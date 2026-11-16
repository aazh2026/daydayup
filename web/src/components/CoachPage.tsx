import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  KNOWLEDGE_MAP,
  SHANGHAI_CURRICULUM,
  VERIFIED_QUESTION_BANK,
} from '../data/shanghaiCurriculum.ts';
import { MASTERY_ORDER, fetchRetestStatus } from '../engine/planner.ts';
import { api } from '../api/client.ts';
import type {
  CoachChatResponse,
  EvaluateResponse,
  GeneratePracticeResponse,
} from '@daydayup/contracts';
import type {
  CoachMessage,
  ErrorType,
  MasteryRecord,
  PracticeMode,
  QuestionLevel,
  Student,
  TeachingBehavior,
  VariantQuestion,
} from '../types.ts';

interface CoachPageProps {
  activeKnowledgeId: string;
  onSelectKnowledge: (knowledgeId: string) => void;
  student: Student;
  masteryRecords: Record<string, MasteryRecord>;
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

function getInitialDiagnosticPrompt(knowledgeId: string): {
  opening: string;
  quickReplies: string[];
} {
  if (knowledgeId === 'math-alg-rational') {
    return {
      opening:
        '今天我们攻克「分式与代数式运算」。在讲例题前，我先做一个诊断提问：如果一个分式的分母是 x - 2，那么 x 能不能等于 2？',
      quickReplies: ['可以', '不可以', '不确定'],
    };
  }
  if (knowledgeId === 'math-func-linear') {
    return {
      opening:
        '今天我们训练「一次函数图像与性质」。我先确认一个核心问题：把直线 y = 2x + 1 向上平移 3 个单位，改变的是斜率 k 还是截距 b？',
      quickReplies: ['只改变截距 b', '只改变斜率 k', '两个都变'],
    };
  }
  if (knowledgeId === 'eng-vocab-core') {
    return {
      opening:
        '今天我们练习「上海中考词性转换与核心词汇」。先看一个小诊断：在 "It is ____ (polite) to shout in the library." 中，空格应当填副词还是形容词，肯定还是否定？',
      quickReplies: ['否定形容词 impolite', '副词 politely', '不太确定'],
    };
  }
  if (knowledgeId === 'chem-concept-symbols') {
    return {
      opening:
        '今天我们强化「化学用语与方程式规范」。先确认一个高频扣分点：书写过氧化氢在二氧化锰催化下分解制氧气的方程式时，氧气后面要不要标气体符号 ↑ ？',
      quickReplies: ['需要标 ↑', '不需要标', '看反应物状态决定'],
    };
  }
  if (knowledgeId === 'phys-elec-ohm') {
    return {
      opening:
        '今天我们攻克物理「动态电路分析与故障判断」。先确认一个核心切入点：定值电阻 R₁ 与滑动变阻器 R₂ 串联时，如果滑片移动导致 R₂ 阻值增大，应该先用哪个电阻判断电压变化？',
      quickReplies: ['先看定值电阻 R₁ 分压', '直接看变阻器 R₂', '先看总电流不变'],
    };
  }
  if (knowledgeId === 'phys-mech-pressure') {
    return {
      opening:
        '今天我们训练物理「压强与浮力综合」。先做个小诊断：实心均匀正方体放在水平地面上，如果沿竖直方向切去一半，剩余部分对地面的压强会变小还是不变？',
      quickReplies: ['保持不变', '减小一半', '不确定'],
    };
  }
  if (knowledgeId === 'chi-modern-read') {
    return {
      opening:
        '今天我们强化语文「现代文关键词句赏析与结构作用」。先问你一个核心得分点：当题目问“文章结尾段有什么作用”时，除了内容情感和主旨，阅卷老师一定会看哪个维度？',
      quickReplies: ['结构作用（收束/照应）', '修辞手法名称', '作者生平背景'],
    };
  }
  if (knowledgeId === 'chi-classical-read') {
    return {
      opening:
        '今天我们训练语文「上海考纲文言实词与课外迁移」。翻译课外文言句子时，遇到和课内《岳阳楼记》相同的实词，优先直接套用白话语感还是回想课内对应义项？',
      quickReplies: ['迁移课内对应义项', '按现代汉语词意猜', '不确定'],
    };
  }
  const kp = KNOWLEDGE_MAP[knowledgeId];
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
  variantQuestions,
  coachHistoryByKnowledge,
  onUpdateCoachHistory,
  onUpdateTaskProgress,
  onSimulateRetestUnlock,
  onRecordPracticeAttempt,
  onAddGeneratedVariant,
}) => {
  const kp = KNOWLEDGE_MAP[activeKnowledgeId] ?? SHANGHAI_CURRICULUM[0];
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

  // Initialize chat if no persistent history exists, and load bank-first question
  const messages: CoachMessage[] =
    savedHistory && savedHistory.length > 0
      ? savedHistory
      : [
          {
            id: `init-${kp.id}`,
            role: 'coach',
            text: getInitialDiagnosticPrompt(kp.id).opening,
            behavior: '诊断',
          },
        ];

  const findBankQuestion = (
    knowledgeId: string,
    level: QuestionLevel,
    excludeStems: string[]
  ): ActiveQuestionView | null => {
    const verifiedMatch = VERIFIED_QUESTION_BANK.find(
      (q) =>
        q.knowledgeIds.includes(knowledgeId) &&
        q.level === level &&
        !excludeStems.includes(q.stem)
    );
    if (verifiedMatch) {
      return {
        stem: verifiedMatch.stem,
        options: verifiedMatch.options,
        standardAnswer: verifiedMatch.standardAnswer,
        solutionSteps: verifiedMatch.solutionSteps,
        commonTrap: verifiedMatch.commonErrors[0] ?? kp.commonTraps[0] ?? '',
        sourceLabel: '上海中考教研校对题库',
        dualVerified: true,
      };
    }

    const variantMatch = variantQuestions.find(
      (v) =>
        v.knowledgeId === knowledgeId &&
        v.level === level &&
        !excludeStems.includes(v.stem)
    );
    if (variantMatch) {
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
    }
    return null;
  };

  useEffect(() => {
    const init = getInitialDiagnosticPrompt(kp.id);
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

    const starter =
      findBankQuestion(kp.id, '基础题', []) ??
      findBankQuestion(kp.id, '变式题', []) ??
      findBankQuestion(kp.id, '迁移题', []);
    if (starter) {
      setCurrentQuestion(starter);
      setPracticeLevel('基础题');
    } else {
      setCurrentQuestion(null);
    }
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

    // Bank-first strategy: check curated verified questions first unless user forces AI generation
    if (!forceAiNew) {
      const bankHit = findBankQuestion(kp.id, targetLevel, attemptedStems);
      if (bankHit) {
        setCurrentQuestion(bankHit);
        setQuestionStartTime(Date.now());
        return;
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

  const handleEvaluateAnswer = async () => {
    if (!currentQuestion || !studentAnswer.trim()) return;
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
      const data = await api.post<EvaluateResponse>('/api/v1/practice/evaluate', {
        subject: kp.subject,
        knowledgeName: kp.name,
        stem: currentQuestion.stem,
        standardAnswer: currentQuestion.standardAnswer,
        studentAnswer: studentAnswer.trim(),
      });

      const isCorrect = Boolean(data.isCorrect);
      const resultObj = {
        isCorrect,
        errorType: String(data.errorType ?? '无'),
        feedback: String(data.feedback ?? ''),
        stepHint: String(data.stepHint ?? ''),
        nextRecommendation: String(data.nextRecommendation ?? ''),
      };
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
        userAnswer: studentAnswer.trim(),
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
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              03. AI 学习教练 · 任务驱动苏格拉底教学与双轮验算评测（对话与步骤自动持久化）
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                aria-label="选择训练知识点"
                value={kp.id}
                onChange={(e) => onSelectKnowledge(e.target.value)}
                className="px-3 py-1.5 text-sm font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              >
                {SHANGHAI_CURRICULUM.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.subject} · {item.name}
                  </option>
                ))}
              </select>
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
                  {st}
                </div>
              );
            })}
          </div>
        </div>

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
                  {msg.text}
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
                  {currentQuestion.stem}
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
                      {opt}
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    你的独立作答
                  </label>
                  <textarea
                    rows={3}
                    value={studentAnswer}
                    onChange={(e) => setStudentAnswer(e.target.value)}
                    placeholder="写出最终结果或关键计算步骤..."
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isEvaluating || !studentAnswer.trim()}
                  onClick={handleEvaluateAnswer}
                  className="flex-1 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors"
                >
                  {isEvaluating ? '正在评测并更新状态机...' : '提交作答并更新掌握状态'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowSolution((s) => !s)}
                  className="px-3 py-2.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  {showSolution ? '收起解析' : '看答案'}
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
                  <p className="leading-relaxed text-slate-800">{evalResult.feedback}</p>
                  {!evalResult.isCorrect && evalResult.stepHint && (
                    <p className="text-slate-700">
                      <span className="font-semibold">关键提示：</span>
                      {evalResult.stepHint}
                    </p>
                  )}
                  <p className="text-slate-600">
                    <span className="font-semibold">下一步建议：</span>
                    {evalResult.nextRecommendation}
                  </p>
                </div>
              )}

              {showSolution && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2 text-slate-700">
                  <div>
                    <span className="font-semibold text-slate-900">参考答案：</span>
                    {currentQuestion.standardAnswer}
                  </div>
                  {currentQuestion.verificationCheck && (
                    <div className="text-emerald-800">
                      <span className="font-semibold">验算校验：</span>
                      {currentQuestion.verificationCheck}
                    </div>
                  )}
                  {currentQuestion.solutionSteps.length > 0 && (
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-900">标准解题路径：</div>
                      {currentQuestion.solutionSteps.map((st, idx) => (
                        <div key={idx}>
                          {idx + 1}. {st}
                        </div>
                      ))}
                    </div>
                  )}
                  {currentQuestion.commonTrap && (
                    <div className="text-amber-800">
                      <span className="font-semibold">易错点提示：</span>
                      {currentQuestion.commonTrap}
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
