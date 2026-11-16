import { useEffect, useMemo, useState } from 'react';
import { TopBar } from './components/TopBar.tsx';
import { StudentProfileModal } from './components/StudentProfileModal.tsx';
import { TodayPage } from './components/TodayPage.tsx';
import { DiagnosisPage } from './components/DiagnosisPage.tsx';
import { PlanningPage } from './components/PlanningPage.tsx';
import { CoachPage } from './components/CoachPage.tsx';
import { ReportPage } from './components/ReportPage.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { TeacherDashboard } from './components/TeacherDashboard.tsx';
import { INITIAL_APP_STATE } from './data/initialStore.ts';
import { submitMasteryAttempt, fetchCurrentPlan } from './engine/planner.ts';
import { buildLocalPlanFallback } from './engine/plan-fallback.ts';
import { isAuthRequired } from './api/auth.ts';
import { api } from './api/client.ts';
import { useCurriculum } from './store/curriculum.tsx';
import { useServerHydration } from './store/hydrate.ts';
import {
  loadSession,
  clearSession,
  AUTH_EXPIRED_EVENT,
  type AuthSession,
} from './store/auth.ts';
import {
  createLocalSkeleton,
  purgeLegacyState,
} from './store/local-state.ts';
import type {
  AppPage,
  AppState,
  CoachMessage,
  ConfidenceLevel,
  ErrorRecord,
  ErrorType,
  Exam,
  ExamResult,
  LearningPlan,
  LearningTask,
  MasteryTransitionEvent,
  PracticeMode,
  Student,
  Subject,
  VariantQuestion,
} from './types.ts';

/**
 * 开发模式会话。
 *
 * 服务端未配置 AUTH_SECRET 时不要求认证，此时用此身份访问服务端。
 */
const DEV_SESSION: AuthSession = {
  token: '',
  expiresAt: '',
  principalId: 'dev',
  role: 'student',
  studentIds: ['stu-sh-zhangwei'],
  displayName: '张伟',
};

export default function App() {
  /**
   * 本地状态仅保留骨架（无业务数据）。
   *
   * 业务数据（掌握度、错题、计划、会话）一律由服务端水合，
   * 不再写 localStorage —— 服务端是唯一真相源。
   */
  const [appState, setAppState] = useState<AppState>(() =>
    createLocalSkeleton(INITIAL_APP_STATE)
  );
  const [activePage, setActivePage] = useState<AppPage>('today');
  const [activeKnowledgeId, setActiveKnowledgeId] = useState<string>('math-alg-rational');
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  /**
   * 登录态。
   *
   * 服务端未配置 AUTH_SECRET 时不要求认证（本地开发），
   * 此时直接进入应用；否则展示登录页。
   */
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);

  /** 知识体系（服务端资产） */
  const { knowledgeMap: KNOWLEDGE_MAP } = useCurriculum();

  /** 从服务端水合业务状态（服务端是唯一真相源） */
  useServerHydration(appState.student?.id, setAppState);

  useEffect(() => {
    void isAuthRequired()
      .then((required) => {
        setAuthRequired(required);
        if (!required) {
          // 开发模式：使用默认学生身份
          setSession((prev) => prev ?? DEV_SESSION);
        }
      })
      .catch(() => {
        setAuthRequired(false);
        setSession((prev) => prev ?? DEV_SESSION);
      });
  }, []);

  // 令牌失效（401）时回到登录页
  useEffect(() => {
    const handleExpired = () => {
      clearSession();
      setSession(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, []);

  /**
   * 学习计划 —— 服务端权威。
   *
   * 分离前：useMemo(() => buildSevenDayPlan(appState), [appState])
   *   每次 appState 变化（含聊天记录）都会全量重算 7 天计划。
   * 分离后：由服务端 PlanningEngine 计算并落库，前端只消费结果。
   *
   * 服务端不可用时降级为本地快照（仅用于展示，不作为权威数据）。
   */
  const [serverPlan, setServerPlan] = useState<LearningPlan | null>(null);

  // 一次性清理分离前遗留的 localStorage 业务数据
  useEffect(() => {
    if (purgeLegacyState()) {
      console.info('已清理历史本地数据（已迁移至服务端）');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const studentId = appState.student?.id;
    if (!studentId) return;

    void fetchCurrentPlan(studentId)
      .then((plan) => {
        if (!cancelled) setServerPlan(plan);
      })
      .catch(() => {
        // 服务端不可用：保留 null，由下方降级逻辑处理
        if (!cancelled) setServerPlan(null);
      });

    return () => {
      cancelled = true;
    };
  }, [appState.student?.id, appState.completedTaskIds, appState.deferredKnowledgeIds]);

  const plan = useMemo(
    () => serverPlan ?? buildLocalPlanFallback(appState),
    [serverPlan, appState]
  );

  const handleUpdateStudent = (updated: Student) => {
    setAppState((prev) => ({
      ...prev,
      student: updated,
    }));
  };

  const handleResetDemo = () => {
    // 重置演示数据：恢复本地骨架（业务数据由服务端水合）
    setAppState(createLocalSkeleton(INITIAL_APP_STATE));
    setActiveKnowledgeId('math-alg-rational');
    setServerPlan(null);
  };

  const handleStartTask = (task: LearningTask) => {
    setActiveKnowledgeId(task.knowledgeId);
    setActivePage('coach');
  };

  const handleLaunchCoach = (knowledgeId: string) => {
    setActiveKnowledgeId(knowledgeId);
    setActivePage('coach');
  };

  /**
   * 任务状态同步到服务端。
   *
   * 服务端收到 PATCH 后会重新生成计划（保持权威一致），
   * 前端收到新计划后覆盖本地展示。
   */
  const syncTaskToServer = (
    taskId: string,
    patch: {
      status?: '已完成' | '待开始';
      deferred?: boolean;
      progress?: {
        reviewedConcept?: boolean;
        viewedExample?: boolean;
        practiceSolvedDelta?: number;
        reviewedFeedback?: boolean;
      };
    }
  ) => {
    void api
      .patch<LearningPlan>(`/api/v1/plans/${appState.student.id}/tasks/${taskId}`, patch)
      .then((plan) => {
        setServerPlan(plan);
      })
      .catch((err) => {
        console.warn('任务状态同步失败（本地状态仍保留）:', err);
      });
  };

  const handleToggleCompleteTask = (taskId: string) => {
    const willComplete = !appState.completedTaskIds.includes(taskId);

    setAppState((prev) => {
      const exists = prev.completedTaskIds.includes(taskId);
      return {
        ...prev,
        completedTaskIds: exists
          ? prev.completedTaskIds.filter((id) => id !== taskId)
          : [...prev.completedTaskIds, taskId],
      };
    });

    syncTaskToServer(taskId, {
      status: willComplete ? '已完成' : '待开始',
    });
  };

  const handleDeferTask = (knowledgeId: string) => {
    setAppState((prev) => ({
      ...prev,
      deferredKnowledgeIds: prev.deferredKnowledgeIds.includes(knowledgeId)
        ? prev.deferredKnowledgeIds
        : [...prev.deferredKnowledgeIds, knowledgeId],
    }));

    syncTaskToServer(`task-d0-${knowledgeId}`, { deferred: true });
  };

  const handleClearDeferrals = () => {
    setAppState((prev) => ({
      ...prev,
      deferredKnowledgeIds: [],
    }));

    for (const knowledgeId of appState.deferredKnowledgeIds) {
      syncTaskToServer(`task-d0-${knowledgeId}`, { deferred: false });
    }
  };

  /**
   * 教练会话历史 —— 服务端持久化。
   *
   * 分离前只存 localStorage（换设备即丢，且每次 appState 变化整体重写）。
   * 现在按「学生 + 知识点」存服务端，前端保留本地缓存做乐观渲染。
   */
  const handleUpdateCoachHistory = (knowledgeId: string, messages: CoachMessage[]) => {
    setAppState((prev) => ({
      ...prev,
      coachHistoryByKnowledge: {
        ...prev.coachHistoryByKnowledge,
        [knowledgeId]: messages.slice(-24),
      },
    }));

    void api
      .put(`/api/v1/students/${appState.student.id}/coaching/sessions/${knowledgeId}`, {
        messages,
      })
      .catch((err) => {
        console.warn('教练会话同步失败（本地缓存仍保留）:', err);
      });
  };

  const handleUpdateTaskProgress = (
    knowledgeId: string,
    patch: {
      reviewedConcept?: boolean;
      viewedExample?: boolean;
      practiceSolvedDelta?: number;
      reviewedFeedback?: boolean;
    }
  ) => {
    setAppState((prev) => {
      const curr = prev.taskProgressByKnowledge[knowledgeId] ?? { practiceSolvedCount: 0 };
      return {
        ...prev,
        taskProgressByKnowledge: {
          ...prev.taskProgressByKnowledge,
          [knowledgeId]: {
            reviewedConcept: patch.reviewedConcept ?? curr.reviewedConcept,
            viewedExample: patch.viewedExample ?? curr.viewedExample,
            practiceSolvedCount: curr.practiceSolvedCount + (patch.practiceSolvedDelta ?? 0),
            reviewedFeedback: patch.reviewedFeedback ?? curr.reviewedFeedback,
          },
        },
      };
    });
  };

  const handleSimulateRetestUnlock = (knowledgeId: string) => {
    setAppState((prev) => {
      const rec = prev.masteryRecords[knowledgeId];
      if (!rec) return prev;
      return {
        ...prev,
        masteryRecords: {
          ...prev.masteryRecords,
          [knowledgeId]: {
            ...rec,
            nextRetestAvailableAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        },
      };
    });
  };

  const handleAddExamResult = (
    result: Omit<ExamResult, 'id' | 'examId'> & {
      existingExamId?: string;
      examType?: Exam['type'];
    }
  ) => {
    const resId = `res-${Date.now()}`;
    setAppState((prev) => {
      const matchedExam = result.existingExamId
        ? prev.exams.find((e) => e.id === result.existingExamId)
        : undefined;
      const examId = matchedExam ? matchedExam.id : `exam-${Date.now()}`;
      const resolvedTitle = matchedExam ? matchedExam.title : result.examTitle;
      const resolvedDate = matchedExam ? matchedExam.date : result.date;

      const nextExams = matchedExam
        ? prev.exams
        : [
            {
              id: examId,
              title: resolvedTitle,
              type: result.examType ?? '随堂诊断',
              date: resolvedDate,
            },
            ...prev.exams,
          ];

      return {
        ...prev,
        exams: nextExams,
        examResults: [
          {
            subject: result.subject,
            score: result.score,
            fullScore: result.fullScore,
            targetScore: result.targetScore,
            date: resolvedDate,
            examTitle: resolvedTitle,
            id: resId,
            examId,
          },
          ...prev.examResults,
        ],
      };
    });
  };

  const handleDiagnosisCompleted = (payload: {
    subject: Subject;
    examTitle: string;
    existingExamId?: string;
    examType?: Exam['type'];
    examDate?: string;
    score?: number;
    fullScore?: number;
    targetScore?: number;
    syncScoreToBaseline?: boolean;
    paperSummary: string;
    questionsCount: number;
    totalLostScore: number;
    imageUrl?: string;
    rawText?: string;
    sourceFormat?: '试卷拍照' | '文本试卷' | '单题录入';
    items: Array<{
      questionNumber: string;
      stem: string;
      studentAnswer: string;
      correctAnswer: string;
      scoreLost: number;
      knowledgeId: string;
      errorType: ErrorType;
      aiAnalysis: string;
      evidence: string;
      confidence: ConfidenceLevel;
      verificationMethod: string;
    }>;
  }) => {
    const now = new Date().toISOString();
    const paperId = `paper-${Date.now()}`;

    /**
     * 落库到服务端（分离后的唯一真相源）。
     *
     * 分离前诊断结果只存在于浏览器内存，刷新即丢。
     * 现在服务端保存试卷 + 错题记录 + 事件日志。
     *
     * 服务端不可用时不阻塞本地渲染（本地状态作为乐观缓存）。
     */
    const studentId = appState.student.id;
    const examId = payload.existingExamId ?? `exam-${Date.now()}`;

    void api
      .post(`/api/v1/exams/${examId}/papers`, {
        studentId,
        id: paperId,
        examTitle: payload.examTitle,
        examType: payload.examType,
        subject: payload.subject,
        title: payload.examTitle,
        date: payload.examDate ?? now.slice(0, 10),
        score: payload.score,
        fullScore: payload.fullScore,
        imageUrl: payload.imageUrl,
        rawText: payload.rawText,
        sourceFormat: payload.sourceFormat,
        status: '待校验',
        totalLostScore: payload.totalLostScore,
        questionsCount: payload.questionsCount,
        summary: payload.paperSummary,
        knowledgeIds: [...new Set(payload.items.map((i) => i.knowledgeId))],
        knowledgeNameById: Object.fromEntries(
          payload.items.map((i) => [
            i.knowledgeId,
            KNOWLEDGE_MAP[i.knowledgeId]?.name ?? i.knowledgeId,
          ])
        ),
        diagnosedItems: payload.items,
      })
      .catch((err) => {
        console.warn('诊断结果落库失败（本地状态仍保留）:', err);
      });

    setAppState((prev) => {
      const matchedExam = payload.existingExamId
        ? prev.exams.find((e) => e.id === payload.existingExamId)
        : undefined;
      const examId = matchedExam ? matchedExam.id : `exam-${Date.now()}`;
      const resolvedExamTitle = matchedExam ? matchedExam.title : payload.examTitle;
      const resolvedDate = matchedExam ? matchedExam.date : (payload.examDate || now.slice(0, 10));

      const nextExams = matchedExam
        ? prev.exams
        : [
            {
              id: examId,
              title: resolvedExamTitle,
              type: payload.examType ?? '随堂诊断',
              date: resolvedDate,
            },
            ...prev.exams,
          ];

      const newErrors: ErrorRecord[] = payload.items.map((item, idx) => ({
        id: `err-${Date.now()}-${idx}`,
        examId,
        examPaperId: paperId,
        examTitle: resolvedExamTitle,
        questionNumber: item.questionNumber,
        subject: payload.subject,
        stem: item.stem,
        studentAnswer: item.studentAnswer,
        correctAnswer: item.correctAnswer,
        scoreLost: item.scoreLost,
        errorType: item.errorType,
        knowledgeId: item.knowledgeId,
        knowledgeName: KNOWLEDGE_MAP[item.knowledgeId]?.name ?? item.knowledgeId,
        aiAnalysis: item.aiAnalysis,
        evidence: item.evidence,
        confidence: item.confidence,
        verificationMethod: item.verificationMethod,
        status: '未订正',
        createdAt: now,
      }));

      const nextMastery = { ...prev.masteryRecords };
      const newHistoryEvents: MasteryTransitionEvent[] = [];

      for (const item of payload.items) {
        const current = nextMastery[item.knowledgeId];
        if (!current) continue;
        const nextState =
          current.state === '稳定掌握' || current.state === '掌握'
            ? '学习中'
            : '待学习';
        if (current.state !== nextState) {
          newHistoryEvents.push({
            id: `mh-${Date.now()}-${item.knowledgeId}-${newHistoryEvents.length}`,
            knowledgeId: item.knowledgeId,
            subject: payload.subject,
            fromState: current.state,
            toState: nextState,
            trigger: `${resolvedExamTitle} ${item.questionNumber} 诊断失分（-${item.scoreLost}分，${item.errorType}）`,
            timestamp: now,
          });
        }
        nextMastery[item.knowledgeId] = {
          ...current,
          state: nextState,
          confidence: item.confidence,
          lostScoreEvidence: Number(
            (current.lostScoreEvidence + item.scoreLost * 0.7).toFixed(1)
          ),
          evidenceLogs: [
            `${resolvedExamTitle} ${item.questionNumber}（-${item.scoreLost}分，${item.errorType}）`,
            ...current.evidenceLogs,
          ].slice(0, 8),
          updatedAt: now,
        };
      }

      const resolvedExamType = matchedExam ? matchedExam.type : (payload.examType ?? '随堂诊断');
      const uniqueKnowledgeIds = Array.from(new Set(payload.items.map((it) => it.knowledgeId)));

      let nextExamResults = prev.examResults;
      if (
        payload.syncScoreToBaseline &&
        payload.score !== undefined &&
        payload.fullScore !== undefined &&
        payload.fullScore > 0
      ) {
        const defaultTarget = Math.round(payload.fullScore * 0.9);
        const existingResIdx = prev.examResults.findIndex(
          (r) => r.examId === examId && r.subject === payload.subject
        );
        const newResult: ExamResult = {
          id: existingResIdx >= 0 ? prev.examResults[existingResIdx].id : `res-${Date.now()}`,
          examId,
          examTitle: resolvedExamTitle,
          subject: payload.subject,
          score: payload.score,
          fullScore: payload.fullScore,
          targetScore: payload.targetScore ?? (existingResIdx >= 0 ? prev.examResults[existingResIdx].targetScore : defaultTarget),
          date: resolvedDate,
        };
        if (existingResIdx >= 0) {
          nextExamResults = prev.examResults.map((r, i) => (i === existingResIdx ? newResult : r));
        } else {
          nextExamResults = [newResult, ...prev.examResults];
        }
      }

      return {
        ...prev,
        exams: nextExams,
        examResults: nextExamResults,
        examPapers: [
          {
            id: paperId,
            examId,
            examTitle: resolvedExamTitle,
            examType: resolvedExamType,
            subject: payload.subject,
            title: `${resolvedExamTitle}（${payload.subject}试卷）`,
            date: resolvedDate,
            score: payload.score,
            fullScore: payload.fullScore,
            imageUrl: payload.imageUrl,
            rawText: payload.rawText,
            sourceFormat: payload.sourceFormat ?? (payload.imageUrl ? '试卷拍照' : '文本试卷'),
            status: '已识别',
            totalLostScore: payload.totalLostScore,
            questionsCount: payload.questionsCount,
            summary: payload.paperSummary,
            knowledgeIds: uniqueKnowledgeIds,
            createdAt: now,
          },
          ...prev.examPapers,
        ],
        errorRecords: [...newErrors, ...prev.errorRecords],
        masteryRecords: nextMastery,
        masteryHistory: [...newHistoryEvents, ...prev.masteryHistory].slice(0, 80),
      };
    });
  };

  const handleVerifyKnowledge = (
    knowledgeId: string,
    isCorrect: boolean,
    evidenceNote: string
  ) => {
    const kp = KNOWLEDGE_MAP[knowledgeId];
    if (!kp) return;

    // 掌握度状态迁移由服务端 MasteryEngine 计算（不可被前端篡改）
    void submitMasteryAttempt(appState.student.id, knowledgeId, {
      mode: '诊断微测',
      isCorrect,
      evidenceSummary: evidenceNote,
      subject: kp.subject,
    })
      .then((result) => {
        const transition = result.mastery;
        setAppState((prev) => {
          const current = prev.masteryRecords[knowledgeId];
          if (!current) return prev;

          const nextHistory: MasteryTransitionEvent[] =
            current.state !== transition.newState
              ? [
                  {
                    id: transition.transitionEventId || `mh-${Date.now()}-${knowledgeId}`,
                    knowledgeId,
                    subject: kp.subject,
                    fromState: transition.previousState,
                    toState: transition.newState,
                    trigger: evidenceNote,
                    timestamp: result.record.updatedAt,
                  },
                  ...prev.masteryHistory,
                ].slice(0, 80)
              : prev.masteryHistory;

          return {
            ...prev,
            masteryRecords: {
              ...prev.masteryRecords,
              [knowledgeId]: result.record,
            },
            masteryHistory: nextHistory,
          };
        });
      })
      .catch(() => {
        // 服务端不可用时保持原状态，不做本地降级推导
      });
  };

  const handleRecordPracticeAttempt = (payload: {
    knowledgeId: string;
    mode: PracticeMode;
    questionStem: string;
    userAnswer: string;
    isCorrect: boolean;
    hintsUsed: number;
    timeSpentSeconds: number;
    aiFeedback: string;
    errorType?: ErrorType;
  }) => {
    const kp = KNOWLEDGE_MAP[payload.knowledgeId];
    if (!kp) return;

    const attemptId = `att-${Date.now()}`;
    const now = new Date().toISOString();

    // 掌握度状态迁移由服务端 MasteryEngine 计算（不可被前端篡改）
    void submitMasteryAttempt(appState.student.id, payload.knowledgeId, {
      mode: payload.mode,
      isCorrect: payload.isCorrect,
      evidenceSummary: `${payload.mode}：${payload.isCorrect ? '独立通过' : '作答有误'}（${now.slice(5, 10)}）`,
      subject: kp.subject,
      hintsUsed: payload.hintsUsed,
      timeSpentSeconds: payload.timeSpentSeconds,
      independent: payload.hintsUsed === 0,
    })
      .then((result) => {
        const transition = result.mastery;
        setAppState((prev) => {
          const currentMastery = prev.masteryRecords[payload.knowledgeId];

          const nextHistory: MasteryTransitionEvent[] =
            currentMastery && currentMastery.state !== transition.newState
              ? [
                  {
                    id: transition.transitionEventId || `mh-${Date.now()}-${payload.knowledgeId}`,
                    knowledgeId: payload.knowledgeId,
                    subject: kp.subject,
                    fromState: transition.previousState,
                    toState: transition.newState,
                    trigger: `${payload.mode}${payload.isCorrect ? '独立作答通过' : '作答有误触发状态调整'}`,
                    timestamp: now,
                  },
                  ...prev.masteryHistory,
                ].slice(0, 80)
              : prev.masteryHistory;

          const nextErrors =
            payload.isCorrect &&
            (payload.mode === '变式训练' ||
              payload.mode === '迁移应用' ||
              payload.mode === '延迟复测')
              ? prev.errorRecords.map((err) =>
                  err.knowledgeId === payload.knowledgeId && err.status !== '已闭环'
                    ? { ...err, status: '已闭环' as const }
                    : err
                )
              : prev.errorRecords;

          // Auto-complete Today's task if variant/delayed practice passes
          const todayTaskId = `task-d0-${payload.knowledgeId}`;
          const nextCompletedTasks =
            payload.isCorrect &&
            (payload.mode === '变式训练' || payload.mode === '延迟复测') &&
            !prev.completedTaskIds.includes(todayTaskId)
              ? [...prev.completedTaskIds, todayTaskId]
              : prev.completedTaskIds;

          return {
            ...prev,
            learningAttempts: [
              {
                id: attemptId,
                knowledgeId: payload.knowledgeId,
                subject: kp.subject,
                mode: payload.mode,
                questionStem: payload.questionStem,
                userAnswer: payload.userAnswer,
                isCorrect: payload.isCorrect,
                hintsUsed: payload.hintsUsed,
                timeSpentSeconds: payload.timeSpentSeconds,
                independent: payload.hintsUsed === 0,
                aiFeedback: payload.aiFeedback,
                timestamp: now,
              },
              ...prev.learningAttempts,
            ],
            masteryRecords: {
              ...prev.masteryRecords,
              [payload.knowledgeId]: result.record,
            },
            masteryHistory: nextHistory,
            errorRecords: nextErrors,
            completedTaskIds: nextCompletedTasks,
          };
        });
      })
      .catch(() => {
        // 服务端不可用：仍记录本地作答流水，但不本地推导掌握度
        setAppState((prev) => ({
          ...prev,
          learningAttempts: [
            {
              id: attemptId,
              knowledgeId: payload.knowledgeId,
              subject: kp.subject,
              mode: payload.mode,
              questionStem: payload.questionStem,
              userAnswer: payload.userAnswer,
              isCorrect: payload.isCorrect,
              hintsUsed: payload.hintsUsed,
              timeSpentSeconds: payload.timeSpentSeconds,
              independent: payload.hintsUsed === 0,
              aiFeedback: payload.aiFeedback,
              timestamp: now,
            },
            ...prev.learningAttempts,
          ],
        }));
      });
  };

  const handleAddGeneratedVariant = (variant: VariantQuestion) => {
    setAppState((prev) => ({
      ...prev,
      variantQuestions: [variant, ...prev.variantQuestions].slice(0, 40),
    }));
  };

  const handleMarkErrorCorrected = (errorId: string, note: string) => {
    const nextStatus = '已订正' as const;

    setAppState((prev) => ({
      ...prev,
      errorRecords: prev.errorRecords.map((err) =>
        err.id === errorId
          ? {
              ...err,
              status: err.status === '已闭环' ? '已闭环' : nextStatus,
              correctionNote: note,
            }
          : err
      ),
    }));

    // 同步到服务端（错题记录的订正状态是持久化业务数据）
    void api
      .patch(`/api/v1/error-records/${appState.student.id}/${errorId}`, {
        status: nextStatus,
        correctionNote: note,
      })
      .catch((err) => {
        console.warn('错题状态同步失败:', err);
      });
  };

  /**
   * 登录守卫。
   *
   * - authRequired 为 null：正在探测服务端配置
   * - authRequired 为 true 且无会话：展示登录页
   */
  if (authRequired === null) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-400">正在连接服务…</div>
      </div>
    );
  }

  if (authRequired && !session) {
    return (
      <LoginPage
        onLoggedIn={(next) => {
          setSession(next);
          setAppState((prev) => ({
            ...prev,
            student: { ...prev.student, id: next.studentIds[0] ?? prev.student.id },
          }));
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <TopBar
        activePage={activePage}
        onNavigate={setActivePage}
        student={appState.student}
        onOpenProfile={() => setIsProfileOpen(true)}
        role={session?.role ?? 'student'}
        displayName={session?.displayName}
        onLogout={
          session?.token
            ? () => {
                clearSession();
                setSession(null);
              }
            : undefined
        }
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activePage === 'today' && (
          <TodayPage
            student={appState.student}
            plan={plan}
            masteryRecords={appState.masteryRecords}
            deferredKnowledgeIds={appState.deferredKnowledgeIds}
            onStartTask={handleStartTask}
            onToggleCompleteTask={handleToggleCompleteTask}
            onDeferTask={handleDeferTask}
            onClearDeferrals={handleClearDeferrals}
            onNavigate={setActivePage}
          />
        )}

        {activePage === 'diagnosis' && (
          <DiagnosisPage
            exams={appState.exams}
            examResults={appState.examResults}
            examPapers={appState.examPapers}
            errorRecords={appState.errorRecords}
            masteryRecords={appState.masteryRecords}
            onAddExamResult={handleAddExamResult}
            onDiagnosisCompleted={handleDiagnosisCompleted}
            studentId={appState.student.id}
            examId={appState.exams[0]?.id ?? `exam-${appState.student.id}`}
            onVerifyKnowledge={handleVerifyKnowledge}
            onLaunchCoach={handleLaunchCoach}
          />
        )}

        {activePage === 'planning' && (
          <PlanningPage
            student={appState.student}
            plan={plan}
            onUpdateStudent={handleUpdateStudent}
            onStartTask={handleStartTask}
            onLaunchCoach={handleLaunchCoach}
          />
        )}

        {activePage === 'coach' && (
          <CoachPage
            activeKnowledgeId={activeKnowledgeId}
            onSelectKnowledge={setActiveKnowledgeId}
            student={appState.student}
            masteryRecords={appState.masteryRecords}
            variantQuestions={appState.variantQuestions}
            coachHistoryByKnowledge={appState.coachHistoryByKnowledge}
            onUpdateCoachHistory={handleUpdateCoachHistory}
            onUpdateTaskProgress={handleUpdateTaskProgress}
            onSimulateRetestUnlock={handleSimulateRetestUnlock}
            onRecordPracticeAttempt={handleRecordPracticeAttempt}
            onAddGeneratedVariant={handleAddGeneratedVariant}
          />
        )}

        {activePage === 'teacher' && session?.role === 'teacher' && (
          <TeacherDashboard
            studentIds={session.studentIds}
            onSelectStudent={(studentId) => {
              // 切换到指定学生的视角
              setAppState((prev) => ({ ...prev, student: { ...prev.student, id: studentId } }));
              setActivePage('today');
            }}
          />
        )}

        {activePage === 'report' && (
          <ReportPage
            exams={appState.exams}
            examResults={appState.examResults}
            examPapers={appState.examPapers}
            errorRecords={appState.errorRecords}
            masteryRecords={appState.masteryRecords}
            masteryHistory={appState.masteryHistory}
            learningAttempts={appState.learningAttempts}
            variantQuestions={appState.variantQuestions}
            plan={plan}
            onMarkErrorCorrected={handleMarkErrorCorrected}
            onLaunchCoach={handleLaunchCoach}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>智学中枢 · 上海初三AI提分操作系统（数学 · 英语 · 物理 · 化学 · 语文）</span>
          <span>内置初始样例数据仅作结构展示，所有诊断与提分验证均依据独立作答证据更新</span>
        </div>
      </footer>

      {isProfileOpen && (
        <StudentProfileModal
          student={appState.student}
          onSave={handleUpdateStudent}
          onResetDemo={handleResetDemo}
          onClose={() => setIsProfileOpen(false)}
        />
      )}
    </div>
  );
}
