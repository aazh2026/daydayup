import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Layers,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  Target,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { MathText } from './MathText.tsx';
import { MASTERY_ORDER, fetchRetestStatus } from '../engine/planner.ts';
import { api } from '../api/client.ts';
import { fetchExternalQuestions } from '../api/sprint.ts';
import { ALL_SUBJECTS } from '../types.ts';
import type {
  CoachChatResponse,
  EvaluateResponse,
  GeneratePracticeResponse,
  KnowledgePoint,
} from '@daydayup/contracts';
import type {
  CoachMessage,
  ErrorRecord,
  ErrorType,
  MasteryRecord,
  PracticeMode,
  QuestionLevel,
  Student,
  Subject,
  TeachingBehavior,
  VariantQuestion,
} from '../types.ts';

interface CoachPageProps {
  activeKnowledgeId: string;
  onSelectKnowledge: (knowledgeId: string) => void;
  student: Student;
  masteryRecords: Record<string, MasteryRecord>;
  errorRecords?: ErrorRecord[];
  variantQuestions: VariantQuestion[];
  coachHistoryByKnowledge: Record<string, CoachMessage[]>;
  onUpdateCoachHistory: (knowledgeId: string, messages: CoachMessage[]) => void;
  onUpdateTaskProgress: (
    knowledgeId: string,
    patch: {
      reviewedConcept?: boolean;
      viewedExample?: boolean;
      practiceSolvedDelta?: number;
      reviewedFeedback?: boolean;
    }
  ) => void;
  onSimulateRetestUnlock: (knowledgeId: string) => void;
  onRecordPracticeAttempt: (payload: {
    knowledgeId: string;
    mode: PracticeMode;
    questionStem: string;
    userAnswer: string;
    isCorrect: boolean;
    hintsUsed: number;
    timeSpentSeconds: number;
    aiFeedback: string;
    errorType?: ErrorType;
  }) => void;
  onAddGeneratedVariant: (variant: VariantQuestion) => void;
}

function getInitialDiagnosticPrompt(
  knowledgeId: string,
  knowledgeMap: Record<string, { name: string }>,
  matchedError?: ErrorRecord
): {
  opening: string;
  quickReplies: string[];
} {
  if (matchedError) {
    const title = matchedError.examTitle || '试卷诊断';
    const qNum = matchedError.questionNumber ? `第 ${matchedError.questionNumber} 题` : '关联题目';
    return {
      opening: `今天我们重点攻关「${knowledgeMap[knowledgeId]?.name ?? '核心考点'}」。在【${title}】的${qNum}中，归因为「${matchedError.errorType}」（失分 ${matchedError.scoreLost} 分）。在开始前先做个小诊断：当时面对这道题时，你的第一思考路径是什么？`,
      quickReplies: ['看错或漏了关键条件', '公式定理或切入路径卡住', '会列式但计算或书写扣分'],
    };
  }

  if (knowledgeId === 'cnm_165') {
    return {
      opening:
        '今天我们攻克「分式方程的解法与增根」。在讲例题前，我先做一个诊断提问：如果一个分式的分母是 x - 2，那么 x 能不能等于 2？',
      quickReplies: ['可以', '不可以', '不确定'],
    };
  }
  if (knowledgeId === 'cnm_204') {
    return {
      opening:
        '今天我们训练「一次函数图象的平移」。我先确认一个核心问题：把直线 y = 2x + 1 向上平移 3 个单位，改变的是斜率 k 还是截距 b？',
      quickReplies: ['只改变截距 b', '只改变斜率 k', '两个都变'],
    };
  }
  if (knowledgeId === 'cne_j064') {
    return {
      opening:
        '今天我们练习「描述性形容词与词形转换」。先看一个小诊断：在 "It is ____ (polite) to shout in the library." 中，空格应当填副词还是形容词，肯定还是否定？',
      quickReplies: ['否定形容词 impolite', '副词 politely', '不太确定'],
    };
  }
  if (knowledgeId === 'cnk_j021') {
    return {
      opening:
        '今天我们强化「化学方程式的书写」。先确认一个高频扣分点：书写过氧化氢在二氧化锰催化下分解制氧气的方程式时，氧气后面要不要标气体符号 ↑ ？',
      quickReplies: ['需要标 ↑', '不需要标', '看反应物状态决定'],
    };
  }
  if (knowledgeId === 'cnp_073') {
    return {
      opening:
        '今天我们攻克物理「动态电路分析与故障判断」。先确认一个核心切入点：定值电阻 R₁ 与滑动变阻器 R₂ 串联时，如果滑片移动导致 R₂ 阻值增大，应该先用哪个电阻判断电压变化？',
      quickReplies: ['先看定值电阻 R₁ 分压', '直接看变阻器 R₂', '先看总电流不变'],
    };
  }
  if (knowledgeId === 'cnp_037') {
    return {
      opening:
        '今天我们训练物理「压强与浮力综合」。先做个小诊断：实心均匀正方体放在水平地面上，如果沿竖直方向切去一半，剩余部分对地面的压强会变小还是不变？',
      quickReplies: ['保持不变', '减小一半', '不确定'],
    };
  }
  if (knowledgeId === 'cnc_j001') {
    return {
      opening:
        '今天我们强化语文「现代文关键词句赏析与结构作用」。先问你一个核心得分点：当题目问“文章结尾段有什么作用”时，除了内容情感和主旨，阅卷老师一定会看哪个维度？',
      quickReplies: ['结构作用（收束/照应）', '修辞手法名称', '作者生平背景'],
    };
  }
  if (knowledgeId === 'cnc_j024') {
    return {
      opening:
        '今天我们训练语文「上海考纲文言实词与课外迁移」。翻译课外文言句子时，遇到和课内《岳阳楼记》相同的实词，优先直接套用白话语感还是回想课内对应义项？',
      quickReplies: ['迁移课内对应义项', '按现代汉语词意猜', '不确定'],
    };
  }
  const kp = knowledgeMap[knowledgeId];
  return {
    opening: `今天我们集中训练「${kp?.name ?? '核心考点'}」。先来诊断一下基础理解：面对这类题目时，你觉得最容易出错的一步通常是哪里？`,
    quickReplies: ['审题漏条件', '公式/性质记不清', '计算或格式出错'],
  };
}

interface ActiveQuestionView {
  stem: string;
  options?: string[];
  standardAnswer: string;
  solutionSteps: string[];
  commonTrap: string;
  sourceLabel: string;
  dualVerified?: boolean;
  verificationCheck?: string;
}

export const CoachPage: React.FC<CoachPageProps> = ({
  activeKnowledgeId,
  onSelectKnowledge,
  student,
  masteryRecords,
  errorRecords,
  variantQuestions,
  coachHistoryByKnowledge,
  onUpdateCoachHistory,
  onUpdateTaskProgress,
  onSimulateRetestUnlock,
  onRecordPracticeAttempt,
  onAddGeneratedVariant,
}) => {
  /**
   * 知识体系（服务端资产，通过 /knowledge-points 获取并缓存）。
   */
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: SHANGHAI_CURRICULUM,
  } = useCurriculum();

  /**
   * 兜底知识点。
   *
   * 知识体系是异步加载的服务端资产：首帧或接口慢时
   * `KNOWLEDGE_MAP[activeKnowledgeId]` 和 `knowledgePoints[0]` 都可能为空。
   * 此时直接读 `kp.id` 会抛 TypeError 白屏。
   *
   * 不用「提前 return 加载态」是因为下方还有十几个 hook ——
   * 条件 return 会让 hook 调用顺序在两次渲染间变化，触发 React 报错。
   * 用占位对象可以保持 hook 顺序稳定，等资产到达后自动换成真实知识点。
   */
  const PLACEHOLDER_KP: KnowledgePoint = {
    id: '',
    subject: '数学',
    chapter: '',
    domain: '',
    name: '加载中…',
    subSkills: [],
    definition: '',
    prerequisites: [],
    commonExamForms: [],
    commonTraps: [],
    examWeight: 1,
    learningCostHours: 1,
  };

  const kp =
    KNOWLEDGE_MAP[activeKnowledgeId] ??
    SHANGHAI_CURRICULUM[0] ??
    PLACEHOLDER_KP;
  const mastery = masteryRecords[kp.id];

  /**
   * 延迟复测解锁状态 —— 服务端权威。
   *
   * 分离前由前端直接读 Date.now() 判定，学生改系统时间即可提前解锁复测。
   * 现由服务端按自身时钟判定；请求未返回前先按「未解锁」渲染。
   */
  const [retestStatus, setRetestStatus] = useState<{
    unlocked: boolean;
    daysRemaining: number;
    reason: string;
  }>({
    unlocked: false,
    daysRemaining: 3,
    reason: '需先完成基础或变式训练',
  });

  useEffect(() => {
    let cancelled = false;
    const studentId = student?.id;
    if (!studentId || !kp?.id) return;

    void fetchRetestStatus(studentId, kp.id)
      .then((status) => {
        if (!cancelled) setRetestStatus(status);
      })
      .catch(() => {
        // 服务端不可用：保持默认（未解锁），不做本地时间推导
      });

    return () => {
      cancelled = true;
    };
  }, [student?.id, kp?.id]);

  const [coachSubject, setCoachSubject] = useState<Subject | '全部'>(kp.subject);
  const [showKpDetail, setShowKpDetail] = useState(false);

  useEffect(() => {
    if (kp.subject) {
      setCoachSubject(kp.subject);
    }
  }, [kp.subject]);

  const availableCoachKps = useMemo(() => {
    if (coachSubject === '全部') return SHANGHAI_CURRICULUM;
    return SHANGHAI_CURRICULUM.filter((k) => k.subject === coachSubject);
  }, [SHANGHAI_CURRICULUM, coachSubject]);

  const savedHistory = coachHistoryByKnowledge[kp.id];
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [socraticStage, setSocraticStage] = useState<number>(0);
  const [activeBehavior, setActiveBehavior] = useState<TeachingBehavior>('诊断');
  const [hintsUsedInSession, setHintsUsedInSession] = useState<number>(0);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [practiceLevel, setPracticeLevel] = useState<QuestionLevel>('基础题');
  const [currentQuestion, setCurrentQuestion] = useState<ActiveQuestionView | null>(null);
  const [studentAnswer, setStudentAnswer] = useState('');
  const [isGeneratingQ, setIsGeneratingQ] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalResult, setEvalResult] = useState<{
    isCorrect: boolean;
    errorType: string;
    feedback: string;
    stepHint: string;
    nextRecommendation: string;
  } | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const [attemptedStems, setAttemptedStems] = useState<string[]>([]);
  const [isPaperDraftMode, setIsPaperDraftMode] = useState(false);

  // 关联当前知识点最近一次未闭环的错题
  const matchedError = useMemo(() => {
    return errorRecords?.find(
      (e) => e.knowledgeId === kp.id && e.status !== '已闭环'
    );
  }, [errorRecords, kp.id]);

  // Initialize chat if no persistent history exists, and load bank-first question
  const messages: CoachMessage[] =
    savedHistory && savedHistory.length > 0
      ? savedHistory
      : [
          {
            id: `init-${kp.id}`,
            role: 'coach',
            text: getInitialDiagnosticPrompt(kp.id, KNOWLEDGE_MAP, matchedError).opening,
            behavior: '诊断',
          },
        ];

  /**
   * 从本地已生成的变式题中匹配（AI 变式题存在客户端会话状态中）。
   *
   * 教研题库查找已下沉服务端（GET /practice/questions），
   * 因为题库是服务端资产，前端不应硬编码。
   */
  const findLocalVariant = (
    knowledgeId: string,
    level: QuestionLevel,
    excludeStems: string[]
  ): ActiveQuestionView | null => {
    const variantMatch = variantQuestions.find(
      (v) =>
        v.knowledgeId === knowledgeId &&
        v.level === level &&
        !excludeStems.includes(v.stem)
    );
    if (!variantMatch) return null;

    return {
      stem: variantMatch.stem,
      options: variantMatch.options,
      standardAnswer: variantMatch.standardAnswer,
      solutionSteps: variantMatch.solutionSteps,
      commonTrap: variantMatch.commonTrap,
      sourceLabel:
        variantMatch.source === 'AI变式'
          ? 'AI 变式生成（已双轮验算）'
          : '上海中考教研校对题库',
      dualVerified: variantMatch.dualVerified ?? true,
      verificationCheck: variantMatch.verificationCheck,
    };
  };

  useEffect(() => {
    const init = getInitialDiagnosticPrompt(kp.id, KNOWLEDGE_MAP);
    if (!coachHistoryByKnowledge[kp.id] || coachHistoryByKnowledge[kp.id].length === 0) {
      onUpdateCoachHistory(kp.id, [
        {
          id: `init-${kp.id}`,
          role: 'coach',
          text: init.opening,
          behavior: '诊断',
        },
      ]);
      setQuickReplies(init.quickReplies);
      setSocraticStage(0);
    } else {
      setQuickReplies([]);
    }
    setActiveBehavior('诊断');
    setHintsUsedInSession(0);
    setChatError(null);
    setEvalResult(null);
    setStudentAnswer('');
    setShowSolution(false);

    // 初始题目：优先本地变式题，回落服务端题库
    setCurrentQuestion(null);
    void (async () => {
      const local = findLocalVariant(kp.id, '基础题', []);
      if (local) {
        setCurrentQuestion(local);
        setPracticeLevel('基础题');
        return;
      }
      try {
        const bankRes = await api.get<{
          found: boolean;
          questions: Array<{
            stem: string;
            options?: string[];
            standardAnswer: string;
            solutionSteps: string[];
            commonErrors: string[];
          }>;
        }>(
          `/api/v1/practice/questions?knowledgeId=${encodeURIComponent(kp.id)}`
        );
        const hit = bankRes.questions?.[0];
        if (hit) {
          setCurrentQuestion({
            stem: hit.stem,
            options: hit.options,
            standardAnswer: hit.standardAnswer,
            solutionSteps: hit.solutionSteps ?? [],
            commonTrap: hit.commonErrors?.[0] ?? kp.commonTraps[0] ?? '',
            sourceLabel: '上海中考教研校对题库',
            dualVerified: true,
          });
          setPracticeLevel('基础题');
        }
      } catch {
        // 题库不可用：留空，由用户主动生成
      }
    })();
    setQuestionStartTime(Date.now());
  }, [kp.id]);

  const sendCoachMessage = async (
    text: string,
    opts?: { requestFullExplanation?: boolean; behaviorOverride?: TeachingBehavior }
  ) => {
    const trimmed = text.trim();
    if (!trimmed && !opts?.requestFullExplanation) return;

    const userMsgText = opts?.requestFullExplanation
      ? '我需要看这道知识点的完整讲解与分步示范'
      : trimmed;

    const nextUserMsg: CoachMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: userMsgText,
    };

    const updatedHistory = [...messages, nextUserMsg];
    onUpdateCoachHistory(kp.id, updatedHistory);
    setChatInput('');
    setChatError(null);
    setIsChatLoading(true);

    // Sync TodayPage step progress
    if (opts?.behaviorOverride === '示范') {
      onUpdateTaskProgress(kp.id, { viewedExample: true });
    } else {
      onUpdateTaskProgress(kp.id, { reviewedConcept: true });
    }

    if (!opts?.requestFullExplanation && socraticStage >= 2) {
      setHintsUsedInSession((h) => h + 1);
    }

    try {
      const data = await api.post<CoachChatResponse>('/api/v1/coach/chat', {
        subject: kp.subject,
        knowledgeName: kp.name,
        knowledgeDefinition: kp.definition,
        commonTraps: kp.commonTraps,
        masteryState: mastery?.state ?? '待学习',
        socraticStage,
        requestFullExplanation: Boolean(opts?.requestFullExplanation),
        teachingBehavior: opts?.behaviorOverride ?? activeBehavior,
        history: updatedHistory.map((m) => ({ role: m.role, text: m.text })),
        studentMessage: userMsgText,
        activeProblem: currentQuestion?.stem ?? '',
        sourceErrorStem: matchedError?.stem ?? '',
        sourceStudentAnswer: matchedError?.studentAnswer ?? '',
        sourceErrorType: matchedError?.errorType ?? '',
        sourceAnalysis: matchedError?.aiAnalysis ?? '',
      });

      const behaviorUsed = (data.teachingBehaviorUsed as TeachingBehavior) || '引导';
      setActiveBehavior(behaviorUsed);
      if (typeof data.nextStage === 'number') {
        setSocraticStage(Math.min(4, Math.max(0, data.nextStage)));
      }
      if (Array.isArray(data.suggestedQuickReplies)) {
        setQuickReplies(data.suggestedQuickReplies.slice(0, 3));
      }

      const coachMsg: CoachMessage = {
        id: `c-${Date.now()}`,
        role: 'coach',
        text: String(data.reply ?? ''),
        behavior: behaviorUsed,
      };
      onUpdateCoachHistory(kp.id, [...updatedHistory, coachMsg]);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '教练连接失败，请重试');
    } finally {
      setIsChatLoading(false);
    }
  };

  const loadQuestionForLevel = async (
    targetLevel: QuestionLevel,
    forceAiNew = false
  ) => {
    setPracticeLevel(targetLevel);
    setEvalResult(null);
    setStudentAnswer('');
    setShowSolution(false);
    setChatError(null);

    if (targetLevel === '延迟复测' && !retestStatus.unlocked) {
      setCurrentQuestion(null);
      return;
    }

    // Bank-first strategy: 优先取服务端题库（命中则不调用 AI，省成本且更稳定）
    if (!forceAiNew) {
      try {
        const excludeParam = attemptedStems.join('||');
        const bankRes = await api.get<{
          found: boolean;
          questions: Array<{
            stem: string;
            options?: string[];
            standardAnswer: string;
            solutionSteps: string[];
            commonErrors: string[];
          }>;
        }>(
          `/api/v1/practice/questions?knowledgeId=${encodeURIComponent(kp.id)}` +
            `&level=${encodeURIComponent(targetLevel)}` +
            `&exclude=${encodeURIComponent(excludeParam)}`
        );

        const bankHit = bankRes.questions?.[0];
        if (bankHit) {
          setCurrentQuestion({
            stem: bankHit.stem,
            options: bankHit.options,
            standardAnswer: bankHit.standardAnswer,
            solutionSteps: bankHit.solutionSteps ?? [],
            commonTrap: bankHit.commonErrors?.[0] ?? '',
            sourceLabel: '教研题库',
            dualVerified: true,
            verificationCheck: '教研题库预置题目，经教研审校',
          });
          setQuestionStartTime(Date.now());
          return;
        }
      } catch {
        // 题库不可用时降级为 AI 生成
      }

      // 第二来源：题庄外部真题（教研题库未命中时）
      try {
        const extRes = await fetchExternalQuestions(kp.id, { limit: 5 });
        const extHit = extRes.questions?.[0];
        if (extHit) {
          setCurrentQuestion({
            stem: extHit.stem,
            options: extHit.options,
            standardAnswer: extHit.standardAnswer,
            solutionSteps: extHit.solutionSteps ?? [],
            commonTrap: extHit.commonErrors?.[0] ?? kp.commonTraps[0] ?? '',
            sourceLabel: '题庄外部真题',
            dualVerified: true,
            verificationCheck: '题庄真题库收录，含标准答案与解析',
          });
          setQuestionStartTime(Date.now());
          return;
        }
      } catch {
        // 外部真题不可用：继续降级到 AI 生成
      }
    }

    // Fallback or explicit AI Variant generation with 2-pass verification
    setIsGeneratingQ(true);
    try {
      const data = await api.post<GeneratePracticeResponse>(
        '/api/v1/practice/generate',
        {
          subject: kp.subject,
          knowledgeId: kp.id,
          knowledgeName: kp.name,
          subSkills: kp.subSkills,
          commonTraps: kp.commonTraps,
          level: targetLevel,
          sourceErrorStem: currentQuestion?.stem ?? '',
        }
      );

      const dualVerified = Boolean(data.dualVerified);
      const newQ: ActiveQuestionView = {
        stem: String(data.stem ?? ''),
        options: Array.isArray(data.options) && data.options.length > 0 ? data.options : undefined,
        standardAnswer: String(data.standardAnswer ?? ''),
        solutionSteps: Array.isArray(data.solutionSteps) ? data.solutionSteps : [],
        commonTrap: String(data.commonTrap ?? ''),
        sourceLabel: dualVerified ? 'AI 变式生成（双轮独立验算一致）' : 'AI 变式生成（已二次校验修正）',
        dualVerified,
        verificationCheck: String(data.verificationCheck ?? ''),
      };
      setCurrentQuestion(newQ);
      setQuestionStartTime(Date.now());

      onAddGeneratedVariant({
        id: `var-gen-${Date.now()}`,
        knowledgeId: kp.id,
        subject: kp.subject,
        level: targetLevel,
        stem: newQ.stem,
        options: newQ.options,
        standardAnswer: newQ.standardAnswer,
        solutionSteps: newQ.solutionSteps,
        commonTrap: newQ.commonTrap,
        source: 'AI变式',
        dualVerified,
        verificationCheck: newQ.verificationCheck,
      });
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '生成新题目失败');
    } finally {
      setIsGeneratingQ(false);
    }
  };

  const handleEvaluateAnswer = async (opts?: {
    customAnswer?: string;
    directCorrect?: boolean;
    directErrorType?: ErrorType;
  }) => {
    const finalAnswer = opts?.customAnswer ?? studentAnswer.trim();
    if (!currentQuestion || !finalAnswer) return;
    setIsEvaluating(true);
    setChatError(null);

    const spentSec = Math.max(5, Math.round((Date.now() - questionStartTime) / 1000));
    const modeMap: Record<QuestionLevel, PracticeMode> = {
      基础题: '基础练习',
      变式题: '变式训练',
      迁移题: '迁移应用',
      延迟复测: '延迟复测',
    };

    try {
      let isCorrect = Boolean(opts?.directCorrect);
      let resultObj = {
        isCorrect,
        errorType: opts?.directErrorType ?? (isCorrect ? '无' : '计算问题'),
        feedback: isCorrect
          ? '纸笔独立推导演算正确！结果与标准答案吻合。'
          : '纸笔推导出现疏漏或卡在中间关键步骤。',
        stepHint: '',
        nextRecommendation: isCorrect ? '推进到变式或迁移训练' : '建议回顾典型例题步骤',
      };

      if (opts?.directCorrect === undefined) {
        const data = await api.post<EvaluateResponse>('/api/v1/practice/evaluate', {
          subject: kp.subject,
          knowledgeName: kp.name,
          stem: currentQuestion.stem,
          standardAnswer: currentQuestion.standardAnswer,
          studentAnswer: finalAnswer,
        });

        isCorrect = Boolean(data.isCorrect);
        resultObj = {
          isCorrect,
          errorType: String(data.errorType ?? '无'),
          feedback: String(data.feedback ?? ''),
          stepHint: String(data.stepHint ?? ''),
          nextRecommendation: String(data.nextRecommendation ?? ''),
        };
      }

      setEvalResult(resultObj);
      setShowSolution(true);
      setAttemptedStems((prev) => [...prev, currentQuestion.stem]);

      onUpdateTaskProgress(kp.id, {
        practiceSolvedDelta: 1,
        reviewedFeedback: true,
      });

      const validErrors: ErrorType[] = [
        '知识问题',
        '方法问题',
        '计算问题',
        '熟练度问题',
        '审题问题',
      ];
      const errType = validErrors.includes(resultObj.errorType as ErrorType)
        ? (resultObj.errorType as ErrorType)
        : undefined;

      onRecordPracticeAttempt({
        knowledgeId: kp.id,
        mode: modeMap[practiceLevel],
        questionStem: currentQuestion.stem,
        userAnswer: finalAnswer,
        isCorrect,
        hintsUsed: hintsUsedInSession,
        timeSpentSeconds: spentSec,
        aiFeedback: resultObj.feedback,
        errorType: errType,
      });
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '评测提交失败');
    } finally {
      setIsEvaluating(false);
    }
  };

  const currentMasteryIdx = MASTERY_ORDER.indexOf(mastery?.state ?? '待学习');

  return (
    <div className="space-y-6">
      {/* Top Context & Mastery State Machine Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="text-xs text-slate-500">
              03. AI 学习教练 · 任务驱动苏格拉底教学与双轮验算评测（对话与步骤自动持久化）
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* 学科快捷过滤 */}
              <select
                aria-label="筛选学科"
                value={coachSubject}
                onChange={(e) => setCoachSubject(e.target.value as any)}
                className="px-2.5 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              >
                <option value="全部">全部学科</option>
                {ALL_SUBJECTS.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </select>

              {/* 当前学科考点选择 */}
              <select
                aria-label="选择训练知识点"
                value={kp.id}
                onChange={(e) => onSelectKnowledge(e.target.value)}
                className="px-3 py-1.5 text-sm font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 max-w-sm truncate"
              >
                {availableCoachKps.map((item) => (
                  <option key={item.id} value={item.id}>
                    [{item.subject}] {item.chapter ? `${item.chapter} · ` : ''}{item.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setShowKpDetail((v) => !v)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                <BookOpen className="w-3.5 h-3.5 text-blue-600" />
                <span>{showKpDetail ? '收起考点全貌' : '查看考点全貌'}</span>
                {showKpDetail ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>

              <span className="text-xs text-slate-500">
                当前掌握状态：
                <span className="font-semibold text-blue-700 ml-1">
                  {mastery?.state ?? '待学习'}
                </span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0">
            {MASTERY_ORDER.map((st, idx) => {
              const reached = idx <= currentMasteryIdx;
              const isCurrent = idx === currentMasteryIdx;
              return (
                <div
                  key={st}
                  className={`px-2.5 py-1 text-[11px] rounded-md border whitespace-nowrap shrink-0 ${
                    isCurrent
                      ? 'border-blue-600 bg-blue-50 text-blue-800 font-semibold'
                      : reached
                      ? 'border-emerald-200 bg-emerald-50/60 text-emerald-800'
                      : 'border-slate-200 bg-slate-50 text-slate-400'
                  }`}
                >
                  <MathText text={st} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Knowledge Point Panorama Expanded Panel */}
        {showKpDetail && (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
              <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-blue-600" />
                <span>
                  [{kp.subject}] {kp.chapter} · {kp.domain}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-medium">
                  考纲权重 {kp.examWeight}x
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-medium">
                  预估攻克工时 {kp.learningCostHours}h
                </span>
              </div>
            </div>

            <p className="text-slate-700 leading-relaxed bg-white p-3 rounded-lg border border-slate-200">
              <span className="font-semibold text-slate-900 mr-1">概念定义与要求：</span>
              <MathText text={kp.definition} />
            </p>

            {kp.subSkills && kp.subSkills.length > 0 && (
              <div className="space-y-1">
                <div className="font-semibold text-slate-800 flex items-center gap-1">
                  <Target className="w-3.5 h-3.5 text-blue-600" />
                  <span>分步子能力清单：</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {kp.subSkills.map((sk) => (
                    <span
                      key={sk}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[11px]"
                    >
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span><MathText text={sk} /></span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
              {kp.commonExamForms && kp.commonExamForms.length > 0 && (
                <div className="p-3 bg-white border border-slate-200 rounded-lg space-y-1">
                  <div className="font-semibold text-slate-800 flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-indigo-600" />
                    <span>中考高频考法：</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {kp.commonExamForms.map((fmt) => (
                      <span
                        key={fmt}
                        className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]"
                      >
                        <MathText text={fmt} />
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {kp.commonTraps && kp.commonTraps.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1 text-amber-900">
                  <div className="font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>易错避坑要点：</span>
                  </div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {kp.commonTraps.map((trap) => (
                      <li key={trap}><MathText text={trap} /></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {kp.prerequisites && kp.prerequisites.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="font-semibold text-slate-800 flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-blue-600" />
                  <span>前置依赖知识点（若当前点掌握不牢，建议切换）：</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {kp.prerequisites.map((preId) => (
                    <button
                      key={preId}
                      type="button"
                      onClick={() => onSelectKnowledge(preId)}
                      className="px-2.5 py-1 rounded bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-blue-700 font-medium transition-colors text-left"
                    >
                      切换至前置：{KNOWLEDGE_MAP[preId]?.name ?? preId}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(mastery?.consecutiveErrors ?? 0) >= 2 && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">系统自动降阶保护已触发：</span>
              当前知识点连续失误 {mastery.consecutiveErrors} 次，系统已降低练习难度。
              {kp.prerequisites.length > 0 && (
                <span>
                  建议先回归前置知识「
                  <button
                    type="button"
                    onClick={() => onSelectKnowledge(kp.prerequisites[0])}
                    className="underline font-semibold text-blue-700"
                  >
                    {KNOWLEDGE_MAP[kp.prerequisites[0]]?.name}
                  </button>
                  」。
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {chatError && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {chatError}
        </div>
      )}

      {/* Two-Zone Sandbox Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Zone: Socratic Coach */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl flex flex-col min-h-[540px]">
          <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-900">{kp.subject} AI 教练</span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span className="text-slate-600">
                当前行为：<span className="font-medium text-blue-700">{activeBehavior}</span>
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span className="text-slate-500 font-mono tabular-nums">
                引导深度 {socraticStage}/4
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isChatLoading}
                onClick={() =>
                  sendCoachMessage('请用典型例题示范解题步骤', {
                    behaviorOverride: '示范',
                  })
                }
                className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
              >
                看例题示范
              </button>
              <button
                type="button"
                disabled={isChatLoading}
                onClick={() =>
                  sendCoachMessage('', {
                    requestFullExplanation: true,
                    behaviorOverride: '讲解',
                  })
                }
                className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition-colors whitespace-nowrap"
              >
                我需要看完整讲解
              </button>
            </div>
          </div>

          <div className="flex-1 p-5 space-y-4 overflow-y-auto max-h-[420px]">
            {matchedError && (
              <div className="p-3.5 bg-rose-50/80 border border-rose-200 rounded-xl text-xs text-rose-950 space-y-1.5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="font-semibold flex items-center gap-1.5 text-rose-900">
                    <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                    <span>考试错题靶向攻关：{matchedError.examTitle || '诊断试卷'} · 第 {matchedError.questionNumber || '—'} 题</span>
                  </div>
                  <span className="text-[11px] font-medium text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">
                    {matchedError.errorType} · 扣 {matchedError.scoreLost} 分
                  </span>
                </div>
                <div className="text-slate-700 leading-relaxed">
                  <span className="font-medium text-slate-900">原错题：</span><MathText text={matchedError.stem} />
                </div>
                {matchedError.studentAnswer && (
                  <div className="text-slate-500 text-[11px]">
                    <span className="font-medium text-slate-700">当时作答：</span><MathText text={matchedError.studentAnswer} />
                  </div>
                )}
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-700 text-white'
                      : 'bg-slate-50 border border-slate-200 text-slate-800'
                  }`}
                >
                  {msg.role === 'coach' && msg.behavior && (
                    <div className="text-[11px] font-medium text-slate-400 mb-1">
                      教学行为：{msg.behavior}
                    </div>
                  )}
                  <MathText text={msg.text} />
                </div>
              </div>
            ))}
            {isChatLoading && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                <span>AI 教练正在根据你的作答调整引导粒度...</span>
              </div>
            )}
          </div>

          <div className="p-4 border-t border-slate-200 space-y-3 bg-slate-50/40 rounded-b-xl">
            {quickReplies.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {quickReplies.map((qr, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={isChatLoading}
                    onClick={() => sendCoachMessage(qr)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-blue-50 hover:text-blue-800 border border-slate-200 rounded-lg transition-colors"
                  >
                    {qr}
                  </button>
                ))}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendCoachMessage(chatInput);
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="输入你的思路、算式或疑问..."
                className="flex-1 px-3.5 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
              <button
                type="submit"
                disabled={isChatLoading || !chatInput.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>提交回答</span>
              </button>
            </form>
          </div>
        </section>

        {/* Right Zone: Bank-First Practice & Delayed Retest Verification */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-slate-700" />
              <h2 className="text-sm font-semibold text-slate-900">
                独立练习与变式评测
              </h2>
            </div>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              正确 {mastery?.practiceCorrect ?? 0}/{mastery?.practiceTotal ?? 0}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg">
            {(['基础题', '变式题', '迁移题', '延迟复测'] as const).map((lvl) => {
              const isLockedRetest = lvl === '延迟复测' && !retestStatus.unlocked;
              return (
                <button
                  key={lvl}
                  type="button"
                  disabled={isGeneratingQ}
                  onClick={() => loadQuestionForLevel(lvl)}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center justify-center gap-1 ${
                    practiceLevel === lvl
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {isLockedRetest && <Lock className="w-3 h-3 text-slate-400" />}
                  <span>{lvl}</span>
                </button>
              );
            })}
          </div>

          {practiceLevel === '延迟复测' && !retestStatus.unlocked ? (
            <div className="p-5 border border-amber-200 bg-amber-50/50 rounded-xl space-y-3 text-xs">
              <div className="flex items-center gap-2 font-semibold text-amber-900">
                <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                <span>延迟复测时间间隔锁生效中</span>
              </div>
              <p className="text-slate-700 leading-relaxed">{retestStatus.reason}</p>
              {(mastery?.state === '初步掌握' || mastery?.state === '掌握') && (
                <button
                  type="button"
                  onClick={() => {
                    onSimulateRetestUnlock(kp.id);
                    setTimeout(() => loadQuestionForLevel('延迟复测', true), 50);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-amber-900 bg-white hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors"
                >
                  演示验收：模拟已满 3 天间隔并解锁复测
                </button>
              )}
            </div>
          ) : isGeneratingQ ? (
            <div className="py-16 text-center space-y-2 text-xs text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin text-blue-700 mx-auto" />
              <div>正在生成上海中考{practiceLevel}并执行第二轮独立盲测验算...</div>
            </div>
          ) : currentQuestion ? (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500 gap-2">
                  <span className="inline-flex items-center gap-1 text-slate-600 truncate">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span className="truncate">{currentQuestion.sourceLabel}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => loadQuestionForLevel(practiceLevel, true)}
                    className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 font-medium shrink-0"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>AI 变式新题</span>
                  </button>
                </div>
                <p className="text-sm text-slate-900 leading-relaxed font-medium">
                  <MathText text={currentQuestion.stem} />
                </p>
              </div>

              {currentQuestion.options && currentQuestion.options.length > 0 ? (
                <div className="space-y-2">
                  {currentQuestion.options.map((opt, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setStudentAnswer(opt)}
                      className={`w-full text-left px-3.5 py-2.5 text-xs rounded-lg border transition-colors ${
                        studentAnswer === opt
                          ? 'border-blue-600 bg-blue-50 text-blue-900 font-medium'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <MathText text={opt} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-700">
                      作答方式
                    </label>
                    <div className="inline-flex p-0.5 bg-slate-100 rounded-lg text-[11px]">
                      <button
                        type="button"
                        onClick={() => setIsPaperDraftMode(false)}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          !isPaperDraftMode
                            ? 'bg-white text-slate-900 shadow-sm font-medium'
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        键盘输入
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsPaperDraftMode(true)}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          isPaperDraftMode
                            ? 'bg-white text-blue-700 shadow-sm font-medium'
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        纸笔草稿自评
                      </button>
                    </div>
                  </div>

                  {!isPaperDraftMode ? (
                    <textarea
                      rows={3}
                      value={studentAnswer}
                      onChange={(e) => setStudentAnswer(e.target.value)}
                      placeholder="写出最终结果或关键计算步骤..."
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                    />
                  ) : (
                    <div className="p-3.5 bg-amber-50/70 border border-amber-200 rounded-xl space-y-3">
                      <div className="text-xs text-amber-950 leading-relaxed">
                        <span className="font-semibold text-amber-900">初三草稿纸模式：</span>
                        初中大题步骤较长，建议在草稿纸上完整写出推导与计算过程。完成后核对分步标准解答进行独立自评：
                      </div>
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isEvaluating}
                          onClick={() => {
                            setStudentAnswer(currentQuestion.standardAnswer);
                            void handleEvaluateAnswer({
                              customAnswer: currentQuestion.standardAnswer,
                              directCorrect: true,
                            });
                          }}
                          className="py-2 px-3 text-xs font-semibold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Check className="w-3.5 h-3.5 text-emerald-700" />
                          <span>完全做对（核对一致）</span>
                        </button>
                        <button
                          type="button"
                          disabled={isEvaluating}
                          onClick={() => {
                            setStudentAnswer('计算或推导疏漏');
                            void handleEvaluateAnswer({
                              customAnswer: '计算或推导疏漏',
                              directCorrect: false,
                              directErrorType: '计算问题',
                            });
                          }}
                          className="py-2 px-3 text-xs font-semibold text-rose-800 bg-rose-100 hover:bg-rose-200 border border-rose-300 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span>做错或思路卡住</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                {!isPaperDraftMode && (
                  <button
                    type="button"
                    disabled={isEvaluating || !studentAnswer.trim()}
                    onClick={() => void handleEvaluateAnswer()}
                    className="flex-1 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors"
                  >
                    {isEvaluating ? '正在评测并更新状态机...' : '提交作答并更新掌握状态'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSolution((s) => !s)}
                  className={`py-2.5 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap ${
                    isPaperDraftMode
                      ? 'w-full bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200'
                      : 'px-3 text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {showSolution ? '收起标准答案与解析' : '对照标准分步解答'}
                </button>
              </div>

              {evalResult && (
                <div
                  className={`p-4 rounded-lg border text-xs space-y-2 ${
                    evalResult.isCorrect
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      {evalResult.isCorrect
                        ? `评测通过 · 掌握状态已依据「${practiceLevel}」证据更新`
                        : `作答有误（归因：${evalResult.errorType}）`}
                    </span>
                  </div>
                  <p className="leading-relaxed text-slate-800"><MathText text={evalResult.feedback} /></p>
                  {!evalResult.isCorrect && evalResult.stepHint && (
                    <p className="text-slate-700">
                      <span className="font-semibold">关键提示：</span>
                      <MathText text={evalResult.stepHint} />
                    </p>
                  )}
                  <p className="text-slate-600">
                    <span className="font-semibold">下一步建议：</span>
                    <MathText text={evalResult.nextRecommendation} />
                  </p>
                </div>
              )}

              {showSolution && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2 text-slate-700">
                  <div>
                    <span className="font-semibold text-slate-900">参考答案：</span>
                    <MathText text={currentQuestion.standardAnswer} />
                  </div>
                  {currentQuestion.verificationCheck && (
                    <div className="text-emerald-800">
                      <span className="font-semibold">验算校验：</span>
                      <MathText text={currentQuestion.verificationCheck} />
                    </div>
                  )}
                  {currentQuestion.solutionSteps.length > 0 && (
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-900">标准解题路径：</div>
                      {currentQuestion.solutionSteps.map((st, idx) => (
                        <div key={idx}>
                          {idx + 1}. <MathText text={st} />
                        </div>
                      ))}
                    </div>
                  )}
                  {currentQuestion.commonTrap && (
                    <div className="text-amber-800">
                      <span className="font-semibold">易错点提示：</span>
                      <MathText text={currentQuestion.commonTrap} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="py-10 text-center space-y-3">
              <p className="text-xs text-slate-500">当前知识点题库暂无此层级题目，可立即生成双轮验算变式题</p>
              <button
                type="button"
                onClick={() => loadQuestionForLevel(practiceLevel, true)}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
              >
                AI 生成上海中考{practiceLevel}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
