import { useEffect, useMemo, useState } from 'react';
import { TopBar } from './components/TopBar.tsx';
import { StudentProfileModal } from './components/StudentProfileModal.tsx';
import { TodayPage } from './components/TodayPage.tsx';
import { DiagnosisPage } from './components/DiagnosisPage.tsx';
import { PlanningPage } from './components/PlanningPage.tsx';
import { CoachPage } from './components/CoachPage.tsx';
import { ReportPage } from './components/ReportPage.tsx';
import { INITIAL_APP_STATE } from './data/initialStore.ts';
import { KNOWLEDGE_MAP } from './data/shanghaiCurriculum.ts';
import { submitMasteryAttempt, fetchCurrentPlan } from './engine/planner.ts';
import { buildLocalPlanFallback } from './engine/plan-fallback.ts';
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

const STORAGE_KEY = 'shanghai_ai_score_os_v5';

function loadInitialState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && parsed.student && parsed.masteryRecords) {
        return {
          ...INITIAL_APP_STATE,
          ...parsed,
          masteryRecords: {
            ...INITIAL_APP_STATE.masteryRecords,
            ...parsed.masteryRecords,
          },
          masteryHistory: parsed.masteryHistory ?? INITIAL_APP_STATE.masteryHistory,
          deferredKnowledgeIds: parsed.deferredKnowledgeIds ?? [],
          coachHistoryByKnowledge: parsed.coachHistoryByKnowledge ?? {},
          taskProgressByKnowledge: parsed.taskProgressByKnowledge ?? {},
        };
      }
    }
  } catch {
    // Fallback to initial seed
  }
  return INITIAL_APP_STATE;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>(loadInitialState);
  const [activePage, setActivePage] = useState<AppPage>('today');
  const [activeKnowledgeId, setActiveKnowledgeId] = useState<string>('math-alg-rational');
  const [isProfileOpen, setIsProfileOpen] = useState(false);

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

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch {
      // Ignore quota errors
    }
  }, [appState]);

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
    localStorage.removeItem(STORAGE_KEY);
    setAppState(INITIAL_APP_STATE);
    setActiveKnowledgeId('math-alg-rational');
  };

  const handleStartTask = (task: LearningTask) => {
    setActiveKnowledgeId(task.knowledgeId);
    setActivePage('coach');
  };

  const handleLaunchCoach = (knowledgeId: string) => {
    setActiveKnowledgeId(knowledgeId);
    setActivePage('coach');
  };

  const handleToggleCompleteTask = (taskId: string) => {
    setAppState((prev) => {
      const exists = prev.completedTaskIds.includes(taskId);
      return {
        ...prev,
        completedTaskIds: exists
          ? prev.completedTaskIds.filter((id) => id !== taskId)
          : [...prev.completedTaskIds, taskId],
      };
    });
  };

  const handleDeferTask = (knowledgeId: string) => {
    setAppState((prev) => ({
      ...prev,
      deferredKnowledgeIds: prev.deferredKnowledgeIds.includes(knowledgeId)
        ? prev.deferredKnowledgeIds
        : [...prev.deferredKnowledgeIds, knowledgeId],
    }));
  };

  const handleClearDeferrals = () => {
    setAppState((prev) => ({
      ...prev,
      deferredKnowledgeIds: [],
    }));
  };

  const handleUpdateCoachHistory = (knowledgeId: string, messages: CoachMessage[]) => {
    setAppState((prev) => ({
      ...prev,
      coachHistoryByKnowledge: {
        ...prev.coachHistoryByKnowledge,
        [knowledgeId]: messages.slice(-24),
      },
    }));
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
    setAppState((prev) => ({
      ...prev,
      errorRecords: prev.errorRecords.map((err) =>
        err.id === errorId
          ? {
              ...err,
              status: err.status === '已闭环' ? '已闭环' : '已订正',
              correctionNote: note,
            }
          : err
      ),
    }));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <TopBar
        activePage={activePage}
        onNavigate={setActivePage}
        student={appState.student}
        onOpenProfile={() => setIsProfileOpen(true)}
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
