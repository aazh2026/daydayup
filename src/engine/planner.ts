import { KNOWLEDGE_MAP, SHANGHAI_CURRICULUM } from '../data/shanghaiCurriculum.ts';
import type {
  AppState,
  ConfidenceLevel,
  DailySchedule,
  LearningPlan,
  LearningTask,
  MasteryRecord,
  MasteryState,
  PriorityOpportunity,
  Student,
} from '../types.ts';

const CONFIDENCE_WEIGHT: Record<ConfidenceLevel, number> = {
  确定: 1.0,
  较可能: 0.8,
  待验证: 0.55,
};

export const MASTERY_ORDER: MasteryState[] = [
  '未诊断',
  '待学习',
  '学习中',
  '初步掌握',
  '掌握',
  '稳定掌握',
];

export const RETEST_INTERVAL_DAYS = 3;

export function getDelayedRetestStatus(rec?: MasteryRecord): {
  unlocked: boolean;
  daysRemaining: number;
  reason: string;
} {
  if (!rec) {
    return { unlocked: false, daysRemaining: RETEST_INTERVAL_DAYS, reason: '需先完成基础或变式训练' };
  }
  if (rec.state === '未诊断' || rec.state === '待学习' || rec.state === '学习中') {
    return {
      unlocked: false,
      daysRemaining: RETEST_INTERVAL_DAYS,
      reason: '需先通过基础题或变式题达到「初步掌握」及以上，再进入延迟复测',
    };
  }
  if (!rec.nextRetestAvailableAt) {
    return { unlocked: true, daysRemaining: 0, reason: '已满足延迟复测条件' };
  }
  const nowMs = Date.now();
  const targetMs = new Date(rec.nextRetestAvailableAt).getTime();
  if (Number.isNaN(targetMs) || nowMs >= targetMs) {
    return { unlocked: true, daysRemaining: 0, reason: '已满 3 天记忆间隔，可进行延迟复测验证' };
  }
  const daysRemaining = Math.max(1, Math.ceil((targetMs - nowMs) / (1000 * 60 * 60 * 24)));
  return {
    unlocked: false,
    daysRemaining,
    reason: `为避免短期记忆假象，需距首次掌握满 ${RETEST_INTERVAL_DAYS} 天后解锁（还需约 ${daysRemaining} 天）`,
  };
}

export function computeDaysToZhongkao(targetExamDate: string): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(targetExamDate);
  if (Number.isNaN(target.getTime())) return 200;
  const diffMs = target.getTime() - today.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

export function getEffectiveDailyBudget(student: Student): number {
  let factor = 1.0;
  if (student.homeworkLoad === '较重') factor -= 0.15;
  if (student.homeworkLoad === '轻松') factor += 0.1;
  if (student.fatigueLevel === '高') factor -= 0.15;
  return Math.max(30, Math.round((student.dailyBudgetMinutes * factor) / 5) * 5);
}

/**
 * Deterministic Priority Opportunity Engine (Module 02):
 * Priority_i = (ExpectedGain_i * Confidence_i * ExamWeight_i) / LearningCost_i
 * where ExpectedGain_i = LostScore_i * RecoveryProbability_i
 */
export function computePriorityOpportunities(
  masteryRecords: Record<string, MasteryRecord>
): PriorityOpportunity[] {
  const opportunities: PriorityOpportunity[] = [];

  for (const kp of SHANGHAI_CURRICULUM) {
    const rec = masteryRecords[kp.id];
    if (!rec) continue;
    if (rec.state === '稳定掌握') continue;

    const lostScore = Math.max(1, rec.lostScoreEvidence);
    const recoveryProb = rec.recoveryProbability;
    const expectedGain = Number((lostScore * recoveryProb).toFixed(1));
    const confWeight = CONFIDENCE_WEIGHT[rec.confidence];

    let blockedBy: string | undefined;
    for (const preId of kp.prerequisites) {
      const preRec = masteryRecords[preId];
      if (preRec && (preRec.state === '未诊断' || preRec.state === '待学习')) {
        blockedBy = KNOWLEDGE_MAP[preId]?.name ?? preId;
        break;
      }
    }

    const prerequisiteModifier = blockedBy ? 0.45 : 1.0;
    const urgencyModifier = rec.consecutiveErrors >= 2 && kp.prerequisites.length === 0 ? 1.25 : 1.0;
    // Slight boost if delayed retest window is now unlocked
    const retestStatus = getDelayedRetestStatus(rec);
    const retestReadyBoost = rec.state === '掌握' && retestStatus.unlocked ? 1.15 : 1.0;

    const rawPriority =
      ((expectedGain * confWeight * kp.examWeight) / kp.learningCostHours) *
      prerequisiteModifier *
      urgencyModifier *
      retestReadyBoost;
    const priorityScore = Number(rawPriority.toFixed(2));

    let priorityTier: '高' | '中' | '低' = '中';
    if (priorityScore >= 1.35 && !blockedBy) priorityTier = '高';
    else if (priorityScore < 0.7 || blockedBy) priorityTier = '低';

    const rationaleParts: string[] = [];
    if (rec.lostScoreEvidence > 0) {
      rationaleParts.push(`已有失分证据 ${rec.lostScoreEvidence} 分`);
    } else {
      rationaleParts.push('待补充诊断验证');
    }
    rationaleParts.push(`预计投入 ${kp.learningCostHours} 小时可恢复约 ${expectedGain} 分`);
    if (blockedBy) {
      rationaleParts.push(`需先固牢前置知识「${blockedBy}」`);
    } else if (rec.state === '掌握' && retestStatus.unlocked) {
      rationaleParts.push('已满3天间隔，可立即进行延迟复测闭环');
    } else if (kp.examWeight >= 1.25) {
      rationaleParts.push('上海中考高频核心考点');
    }

    opportunities.push({
      knowledgeId: kp.id,
      subject: kp.subject,
      knowledgeName: kp.name,
      domain: kp.domain,
      lostScore,
      recoveryProbability: recoveryProb,
      expectedGain,
      learningCostHours: kp.learningCostHours,
      confidenceScore: confWeight,
      confidenceLabel: rec.confidence,
      examWeight: kp.examWeight,
      priorityScore,
      priorityTier,
      blockedByPrerequisite: blockedBy,
      rationale: rationaleParts.join('，'),
    });
  }

  return opportunities.sort((a, b) => b.priorityScore - a.priorityScore);
}

const DAY_LABELS = ['今天', '明天', '第3天', '第4天', '第5天', '第6天', '第7天'];

function buildTaskSteps(
  minutes: number,
  state: MasteryState,
  progress?: {
    reviewedConcept?: boolean;
    viewedExample?: boolean;
    practiceSolvedCount: number;
    reviewedFeedback?: boolean;
  }
): { label: string; minutes: number; done: boolean }[] {
  const m1 = Math.max(5, Math.round(minutes * 0.2));
  const m2 = Math.max(5, Math.round(minutes * 0.2));
  const m3 = Math.max(8, Math.round(minutes * 0.45));
  const m4 = Math.max(2, minutes - m1 - m2 - m3);

  if (state === '初步掌握' || state === '掌握') {
    return [
      { label: '易错点快速回顾', minutes: m1, done: Boolean(progress?.reviewedConcept) },
      {
        label: '变式题与迁移训练',
        minutes: m2 + m3,
        done: (progress?.practiceSolvedCount ?? 0) >= 1,
      },
      { label: '独立评测与复盘', minutes: m4, done: Boolean(progress?.reviewedFeedback) },
    ];
  }
  return [
    { label: '复习核心知识点', minutes: m1, done: Boolean(progress?.reviewedConcept) },
    { label: '观看典型例题示范', minutes: m2, done: Boolean(progress?.viewedExample) },
    {
      label: '独立完成变式练习题',
      minutes: m3,
      done: (progress?.practiceSolvedCount ?? 0) >= 1,
    },
    { label: '查看AI错因反馈', minutes: m4, done: Boolean(progress?.reviewedFeedback) },
  ];
}

function pickDistinctSubjectCandidates(
  pool: PriorityOpportunity[],
  limit: number,
  priorityFront: PriorityOpportunity[] = []
): PriorityOpportunity[] {
  const candidates: PriorityOpportunity[] = [];
  const usedSubjects = new Set<string>();

  for (const item of priorityFront) {
    if (candidates.length >= limit) break;
    if (!candidates.some((c) => c.knowledgeId === item.knowledgeId)) {
      candidates.push(item);
      usedSubjects.add(item.subject);
    }
  }

  for (const item of pool) {
    if (candidates.length >= limit) break;
    if (candidates.length < 2 && usedSubjects.has(item.subject)) continue;
    if (!candidates.some((c) => c.knowledgeId === item.knowledgeId)) {
      candidates.push(item);
      usedSubjects.add(item.subject);
    }
  }

  for (const item of pool) {
    if (candidates.length >= limit) break;
    if (!candidates.some((c) => c.knowledgeId === item.knowledgeId)) {
      candidates.push(item);
    }
  }

  return candidates;
}

/**
 * Deterministic 7-Day Learning Plan Generator (Module 02 + 03):
 * - Strictly enforces daily time budget & max 3 tasks/day
 * - Truly reschedules today's deferred items to Tomorrow's top slot while dropping Tomorrow's lowest-priority item (no overload accumulation)
 * - Backfills today's freed slot with the next non-deferred priority candidate
 */
export function buildSevenDayPlan(state: AppState): LearningPlan {
  const effectiveBudget = getEffectiveDailyBudget(state.student);
  const priorities = computePriorityOpportunities(state.masteryRecords);
  const activePool = priorities.filter((p) => !p.blockedByPrerequisite);
  const fallbackPool = priorities.filter((p) => Boolean(p.blockedByPrerequisite));
  const orderedPool = [...activePool, ...fallbackPool];

  const deferredSet = new Set(state.deferredKnowledgeIds ?? []);
  const deferredOpps = orderedPool.filter((p) => deferredSet.has(p.knowledgeId));
  const todayEligiblePool = orderedPool.filter((p) => !deferredSet.has(p.knowledgeId));

  const days: DailySchedule[] = [];

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    let dayCandidates: PriorityOpportunity[];

    if (dayIdx === 0) {
      // Today excludes deferred tasks and automatically backfills from remaining priorities
      dayCandidates = pickDistinctSubjectCandidates(
        todayEligiblePool.length > 0 ? todayEligiblePool : orderedPool,
        3
      );
    } else if (dayIdx === 1) {
      // Tomorrow places today's deferred tasks at the top, displacing lower-priority tasks to keep budget flat
      const rotatedPool = [
        ...orderedPool.slice(2 % Math.max(1, orderedPool.length)),
        ...orderedPool.slice(0, 2 % Math.max(1, orderedPool.length)),
      ];
      dayCandidates = pickDistinctSubjectCandidates(rotatedPool, 3, deferredOpps);
    } else {
      const startOffset = (dayIdx * 2) % Math.max(1, orderedPool.length);
      const rotated = [
        ...orderedPool.slice(startOffset),
        ...orderedPool.slice(0, startOffset),
      ];
      dayCandidates = pickDistinctSubjectCandidates(rotated, 3);
    }

    let remainingMinutes = effectiveBudget;
    const ratios =
      dayCandidates.length === 3
        ? [0.42, 0.33, 0.25]
        : dayCandidates.length === 2
        ? [0.55, 0.45]
        : [1.0];

    const tasks: LearningTask[] = dayCandidates.map((item, idx) => {
      const taskId = `task-d${dayIdx}-${item.knowledgeId}`;
      const isCompleted = state.completedTaskIds.includes(taskId);
      const carriedOverFromToday = dayIdx === 1 && deferredSet.has(item.knowledgeId);
      const rec = state.masteryRecords[item.knowledgeId];
      const kp = KNOWLEDGE_MAP[item.knowledgeId];
      const progress = state.taskProgressByKnowledge?.[item.knowledgeId];

      const mins =
        idx === dayCandidates.length - 1
          ? Math.max(10, remainingMinutes)
          : Math.max(15, Math.round((effectiveBudget * ratios[idx]) / 5) * 5);
      remainingMinutes = Math.max(0, remainingMinutes - mins);

      const difficultyAdjusted = (rec?.consecutiveErrors ?? 0) >= 2;
      const taskTitle = difficultyAdjusted
        ? `${item.subject}：${item.knowledgeName}（降阶巩固）`
        : `${item.subject}：${item.knowledgeName}`;

      const baseObjective = difficultyAdjusted
        ? '连续失误触发降阶保护：拆解前置条件与基础步骤，确保基础题稳定做对'
        : `针对「${item.knowledgeName}」失分点完成诊断讲解与变式验证`;

      const objective = carriedOverFromToday
        ? `由今日重排顺延（已置换明日低优任务，不堆积总负荷）：${baseObjective}`
        : kp
        ? `${baseObjective}（重点：${kp.commonTraps[0]}）`
        : baseObjective;

      const verifiableOutcome =
        rec?.state === '初步掌握'
          ? '独立完成变式题且正确率达标'
          : '完成核心规则梳理并独立做对基础/同类题';

      return {
        id: taskId,
        dayIndex: dayIdx,
        dayLabel: DAY_LABELS[dayIdx],
        subject: item.subject,
        knowledgeId: item.knowledgeId,
        knowledgeName: item.knowledgeName,
        title: taskTitle,
        objective,
        verifiableOutcome,
        estimatedMinutes: mins,
        steps: buildTaskSteps(mins, rec?.state ?? '待学习', dayIdx === 0 ? progress : undefined),
        status: isCompleted ? '已完成' : '待开始',
        priorityRank: idx + 1,
        difficultyAdjusted,
        carriedOverFromToday,
      };
    });

    days.push({
      dayIndex: dayIdx,
      dayLabel: DAY_LABELS[dayIdx],
      totalMinutes: tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0),
      tasks,
    });
  }

  return {
    id: `plan-${new Date().toISOString().slice(0, 10)}`,
    weekLabel: '本周7天提分冲刺周期',
    effectiveDailyBudget: effectiveBudget,
    generatedAt: new Date().toISOString(),
    priorities,
    days,
  };
}

/**
 * Mastery State Machine Transition Rule (Section 5.3):
 * Enforces 3-day delayed retest lock before advancing to '稳定掌握'.
 */
export function evaluateMasteryTransition(
  current: MasteryRecord,
  mode: '诊断微测' | '基础练习' | '变式训练' | '迁移应用' | '延迟复测',
  isCorrect: boolean,
  evidenceSummary: string
): MasteryRecord {
  const now = new Date().toISOString();
  const nextLogs = [evidenceSummary, ...current.evidenceLogs].slice(0, 8);
  const practiceTotal = current.practiceTotal + 1;
  const practiceCorrect = current.practiceCorrect + (isCorrect ? 1 : 0);

  if (!isCorrect) {
    const consecutiveErrors = current.consecutiveErrors + 1;
    const nextState: MasteryState =
      consecutiveErrors >= 2 ? '待学习' : current.state === '未诊断' ? '待学习' : '学习中';
    return {
      ...current,
      state: nextState,
      confidence: '确定',
      consecutiveErrors,
      practiceCorrect,
      practiceTotal,
      variantPassed: mode === '变式训练' ? false : current.variantPassed,
      delayedRetestPassed: mode === '延迟复测' ? false : current.delayedRetestPassed,
      evidenceLogs: nextLogs,
      updatedAt: now,
    };
  }

  let nextState: MasteryState = current.state;
  let variantPassed = current.variantPassed;
  let delayedRetestPassed = current.delayedRetestPassed;
  let lostScoreEvidence = current.lostScoreEvidence;
  let preliminaryMasteredAt = current.preliminaryMasteredAt;
  let nextRetestAvailableAt = current.nextRetestAvailableAt;

  if (!preliminaryMasteredAt && (mode === '基础练习' || mode === '变式训练' || mode === '迁移应用')) {
    preliminaryMasteredAt = now;
    nextRetestAvailableAt = new Date(
      Date.now() + RETEST_INTERVAL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  if (mode === '诊断微测' || mode === '基础练习') {
    if (current.state === '未诊断' || current.state === '待学习' || current.state === '学习中') {
      nextState = '初步掌握';
    }
    lostScoreEvidence = Math.max(1, Number((lostScoreEvidence * 0.75).toFixed(1)));
  } else if (mode === '变式训练' || mode === '迁移应用') {
    variantPassed = true;
    const retestStatus = getDelayedRetestStatus({
      ...current,
      state: '掌握',
      nextRetestAvailableAt,
    });
    nextState = current.delayedRetestPassed && retestStatus.unlocked ? '稳定掌握' : '掌握';
    lostScoreEvidence = Math.max(0.5, Number((lostScoreEvidence * 0.45).toFixed(1)));
  } else if (mode === '延迟复测') {
    const retestStatus = getDelayedRetestStatus(current);
    if (retestStatus.unlocked) {
      delayedRetestPassed = true;
      nextState = '稳定掌握';
      lostScoreEvidence = 0;
    } else {
      // If somehow invoked before interval unlock, counts as variant mastery only
      variantPassed = true;
      nextState = '掌握';
    }
  }

  return {
    ...current,
    state: nextState,
    confidence: '确定',
    consecutiveErrors: 0,
    practiceCorrect,
    practiceTotal,
    variantPassed,
    delayedRetestPassed,
    lostScoreEvidence,
    preliminaryMasteredAt,
    nextRetestAvailableAt,
    evidenceLogs: nextLogs,
    updatedAt: now,
  };
}
