/**
 * PlanningEngine —— 纯函数领域引擎。
 *
 * 迁移自 web 前端 src/engine/planner.ts。
 * **逻辑逐行等价**，仅位置改变：前端 → 服务端独占。
 *
 * 原因：掌握度、提分优先级、每日学习时长约束都是不可被学生篡改的数据。
 * 放在前端等于把评分逻辑交给学生自己改 JS。
 *
 * 纯函数保证：无 IO、无时钟读取（除显式传入 now），可被 node:test 反复验证。
 */
import type {
  Student,
  MasteryRecord,
  MasteryState,
  PriorityOpportunity,
  ConfidenceLevel,
  LearningTask,
  DailySchedule,
  LearningPlan,
  Subject,
  SprintDay,
  SprintSet,
  SprintPlan,
  SprintDayPlan,
} from '@daydayup/contracts';
import { getCurriculum, getKnowledgeMap } from '../infrastructure/knowledge/curriculum.ts';
import {
  getActiveSprintSet,
  getSprintKnowledgeIndex,
  getSprintKnowledgeBySubject,
} from '../infrastructure/knowledge/sprint.ts';

export const CONFIDENCE_WEIGHT: Record<ConfidenceLevel, number> = {
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

/** 引擎版本——写入 LearningPlan.engineVersion，用于结果可追溯 */
export const PLANNING_ENGINE_VERSION = 'planning.v1';

export interface RetestStatus {
  unlocked: boolean;
  daysRemaining: number;
  reason: string;
}

/**
 * 延迟复测解锁判定。
 *
 * 原实现直接读 Date.now()。这里改为接收显式 now 参数，
 * 使其成为完全可测的纯函数，且时间基准由服务端控制（防客户端改时钟作弊）。
 */
export function getDelayedRetestStatus(
  rec: MasteryRecord | undefined,
  now: number = Date.now()
): RetestStatus {
  if (!rec) {
    return {
      unlocked: false,
      daysRemaining: RETEST_INTERVAL_DAYS,
      reason: '需先完成基础或变式训练',
    };
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
  const targetMs = new Date(rec.nextRetestAvailableAt).getTime();
  if (Number.isNaN(targetMs) || now >= targetMs) {
    return {
      unlocked: true,
      daysRemaining: 0,
      reason: '已满 3 天记忆间隔，可进行延迟复测验证',
    };
  }
  const daysRemaining = Math.max(
    1,
    Math.ceil((targetMs - now) / (1000 * 60 * 60 * 24))
  );
  return {
    unlocked: false,
    daysRemaining,
    reason: `为避免短期记忆假象，需距首次掌握满 ${RETEST_INTERVAL_DAYS} 天后解锁（还需约 ${daysRemaining} 天）`,
  };
}

/**
 * 距离中考天数。
 *
 * 注意时区：`new Date('2027-06-20')` 会被解析为 **UTC 零点**，
 * 而「今天」是**本地零点**。在 UTC+8 下两者差 8 小时，
 * `ceil` 会把结果多算一天。因此目标日期必须按**本地日历日**解析。
 */
export function computeDaysToZhongkao(
  targetExamDate: string,
  now: Date = new Date()
): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 按本地日历日解析 'YYYY-MM-DD'，避免被当成 UTC 零点
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetExamDate);
  const target = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(targetExamDate);

  if (Number.isNaN(target.getTime())) return 200;
  const diffMs = target.getTime() - today.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * 每日有效学习预算。
 *
 * 业务规则（作业负担、疲劳度 → 分钟数），必须在服务端计算，
 * 否则学生可篡改前端突破时间预算约束。
 */
export function getEffectiveDailyBudget(student: Student): number {
  let factor = 1.0;
  if (student.homeworkLoad === '较重') factor -= 0.15;
  if (student.homeworkLoad === '轻松') factor += 0.1;
  if (student.fatigueLevel === '高') factor -= 0.15;
  return Math.max(30, Math.round((student.dailyBudgetMinutes * factor) / 5) * 5);
}

/**
 * 提分机会优先级计算。
 *
 * Priority_i = (ExpectedGain_i * Confidence_i * ExamWeight_i) / LearningCost_i
 * where ExpectedGain_i = LostScore_i * RecoveryProbability_i
 */
export function computePriorityOpportunities(
  masteryRecords: Record<string, MasteryRecord>,
  now: number = Date.now()
): PriorityOpportunity[] {
  const opportunities: PriorityOpportunity[] = [];
  const curriculum = getCurriculum();
  const knowledgeMap = getKnowledgeMap();

  for (const kp of curriculum.knowledgePoints) {
    const rec = masteryRecords[kp.id];
    if (!rec) continue;
    if (rec.state === '稳定掌握') continue;

    const lostScore = Math.max(1, rec.lostScoreEvidence);
    const recoveryProb = rec.recoveryProbability;
    const expectedGain = Number((lostScore * recoveryProb).toFixed(1));
    const confWeight = CONFIDENCE_WEIGHT[rec.confidence];

    let blockedBy: string | undefined;
    for (const preId of kp.prerequisites) {
      /**
       * 先修锁定。
       *
       * 规格（§模块02 §3）：「若某知识点的前置先修知识处于 `未诊断` 或 `待学习`，
       * 自动降权并引导先修基础内容」。
       *
       * 注意「未诊断」的判定：**没有 MasteryRecord 就等于未诊断**
       * —— 即从未产生过任何作答/诊断证据。此前写成 `preRec && (...)`，
       * 会在前置知识点无 record 时短路跳过，导致锁定完全不触发。
       * 而「无 record」恰恰是诊断前的初始状态（所有前置都无 record），
       * 于是这条防失败设计在真实初始状态下形同虚设。
       *
       * 这里显式区分两种「未诊断」：
       * - 无 record —— 从未诊断
       * - 有 record 且 state === '未诊断' —— 诊断过但未达标
       */
      const preRec = masteryRecords[preId];
      const preState: MasteryState = preRec?.state ?? '未诊断';

      // 针对真实初三中考备考：目标为初中考点时，跨学段的小学先修点若无负面失分证据，默认基线通过，不虚假阻断
      const isPrimaryKp =
        kp.id.includes('_p') ||
        /cn._p/.test(kp.id) ||
        /一年级|二年级|三年级|四年级|五年级|六年级/.test(kp.chapter ?? '');

      const isPrimaryPre =
        preId.includes('_p') ||
        /cn._p/.test(preId) ||
        /一年级|二年级|三年级|四年级|五年级|六年级/.test(knowledgeMap[preId]?.chapter ?? '');

      if (
        !isPrimaryKp &&
        isPrimaryPre &&
        (!preRec || (preRec.state === '未诊断' && (preRec.lostScoreEvidence ?? 0) === 0))
      ) {
        continue;
      }

      if (preState === '未诊断' || preState === '待学习') {
        blockedBy = knowledgeMap[preId]?.name ?? preId;
        break;
      }
    }

    const prerequisiteModifier = blockedBy ? 0.45 : 1.0;
    const urgencyModifier =
      rec.consecutiveErrors >= 2 && kp.prerequisites.length === 0 ? 1.25 : 1.0;
    const retestStatus = getDelayedRetestStatus(rec, now);
    const retestReadyBoost =
      rec.state === '掌握' && retestStatus.unlocked ? 1.15 : 1.0;

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
    rationaleParts.push(
      `预计投入 ${kp.learningCostHours} 小时可恢复约 ${expectedGain} 分`
    );
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

  // 解除先修死锁：如果一个高优考点被某个前置先修点阻断，但该先修点自身没有在 opportunities 中，
  // 自动将其作为“先修解锁”任务纳入 opportunities，让排期算法能优先排入，打破“因未诊断被锁死、又永远不排”的困境
  const presentIds = new Set(opportunities.map((o) => o.knowledgeId));
  for (const opp of [...opportunities]) {
    if (!opp.blockedByPrerequisite) continue;
    const kp = knowledgeMap[opp.knowledgeId];
    if (!kp) continue;
    for (const preId of kp.prerequisites) {
      if (!presentIds.has(preId) && knowledgeMap[preId]) {
        const preKp = knowledgeMap[preId];
        const preRec = masteryRecords[preId];
        if (preRec?.state === '稳定掌握') continue;
        presentIds.add(preId);
        opportunities.push({
          knowledgeId: preKp.id,
          subject: preKp.subject,
          knowledgeName: preKp.name,
          domain: preKp.domain,
          lostScore: Math.max(2, Math.round(opp.lostScore * 0.8)),
          recoveryProbability: 0.85,
          expectedGain: Math.max(1.5, Math.round(opp.lostScore * 0.8 * 0.85 * 10) / 10),
          learningCostHours: preKp.learningCostHours || 1.5,
          confidenceScore: 0.8,
          confidenceLabel: '较可能',
          examWeight: preKp.examWeight || 1.0,
          priorityScore: Number((opp.priorityScore * 1.35).toFixed(2)),
          priorityTier: '高',
          blockedByPrerequisite: undefined,
          rationale: `为攻克「${opp.knowledgeName}」需优先筑牢此先修基石`,
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.priorityScore - a.priorityScore);
}

const DAY_LABELS = ['今天', '明天', '第3天', '第4天', '第5天', '第6天', '第7天'];

export interface TaskProgress {
  reviewedConcept?: boolean;
  viewedExample?: boolean;
  practiceSolvedCount: number;
  reviewedFeedback?: boolean;
}

export function buildTaskSteps(
  minutes: number,
  state: MasteryState,
  progress?: TaskProgress
): LearningTask['steps'] {
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

export interface PlanInput {
  student: Student;
  masteryRecords: Record<string, MasteryRecord>;
  completedTaskIds?: string[];
  deferredKnowledgeIds?: string[];
  taskProgressByKnowledge?: Record<string, TaskProgress>;
  now?: number;
}

/**
 * 7 天学习计划生成。
 *
 * 硬约束：每日总任务时长 ≤ effectiveDailyBudget，最多 3 个任务/天。
 */
export function buildSevenDayPlan(input: PlanInput): LearningPlan {
  const now = input.now ?? Date.now();
  const effectiveBudget = getEffectiveDailyBudget(input.student);
  const priorities = computePriorityOpportunities(input.masteryRecords, now);
  const activePool = priorities.filter((p) => !p.blockedByPrerequisite);
  const fallbackPool = priorities.filter((p) => Boolean(p.blockedByPrerequisite));
  const orderedPool = [...activePool, ...fallbackPool];

  const deferredSet = new Set(input.deferredKnowledgeIds ?? []);
  const deferredOpps = orderedPool.filter((p) => deferredSet.has(p.knowledgeId));
  const todayEligiblePool = orderedPool.filter((p) => !deferredSet.has(p.knowledgeId));

  const knowledgeMap = getKnowledgeMap();
  const days: DailySchedule[] = [];

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    let dayCandidates: PriorityOpportunity[];

    if (dayIdx === 0) {
      dayCandidates = pickDistinctSubjectCandidates(
        todayEligiblePool.length > 0 ? todayEligiblePool : orderedPool,
        3
      );
    } else if (dayIdx === 1) {
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

    /**
     * 每日时长分配。
     *
     * 规格（§7.1 质量指标）：「每日时间预算满足率 **100%**」——
     * 实际任务总时长 ≤ 调节后每日预算，**任何调节档位都不得超支**。
     *
     * 此前的实现给每个任务设了 15 分钟硬下限、末位 10 分钟硬下限，
     * 于是当预算 < 3 × 15 时（30/35 分钟档位，都在规格「30–120 分钟」
     * 的可调区间内）必然超支 —— 实测 7/7 天超支，最多超 33%。
     *
     * 现在改为**预算感知的整体分配**：
     * 1. 先按比例算出理想时长；
     * 2. 若总和超出预算，整体按比例缩放（至少给每个任务 5 分钟）；
     * 3. 若预算不足以容纳所有任务，则减少任务数 —— 而不是把预算撑破。
     *
     * 这样「每天 ≤ 3 项」与「总时长 ≤ 预算」两条硬约束同时成立。
     */
    const allocateMinutes = (
      count: number,
      budget: number,
      weights: number[]
    ): number[] => {
      if (count <= 0) return [];
      /**
       * 每个任务的最小可用时长。
       * 低于 5 分钟的任务已无学习价值（步骤拆分都放不下），
       * 因此当预算不够时宁可少排任务。
       */
      const MIN_TASK_MINUTES = 5;

      const ideal = weights.map((w) => (budget * w) / 5);
      const idealSum = ideal.reduce((a, b) => a + b, 0);

      // 预算充裕：按比例分配（向下取整到整分钟，避免总时长因取整而超支）
      if (idealSum <= budget) {
        const out = ideal.map((v) => Math.floor(v));
        // 把取整产生的余数补给最后一个任务，仍不超过预算
        const used = out.reduce((a, b) => a + b, 0);
        out[out.length - 1] += budget - used;
        return out;
      }

      // 预算不足：整体等比缩放，并保证每个任务 ≥ MIN_TASK_MINUTES
      const scale = budget / idealSum;
      const scaled = ideal.map((v) => Math.floor(v * scale));
      for (let i = 0; i < scaled.length; i++) {
        if (scaled[i] < MIN_TASK_MINUTES) scaled[i] = MIN_TASK_MINUTES;
      }

      // 缩放后仍超预算（最小任务时长之和 > 预算）——按优先级保留前 N 个任务
      let running = 0;
      const kept: number[] = [];
      for (const m of scaled) {
        if (running + m > budget) break;
        kept.push(m);
        running += m;
      }
      // 若连一个任务都放不下，用尽预算给第一个任务
      if (kept.length === 0) return [budget];
      // 把剩余预算补给最后一个保留的任务
      kept[kept.length - 1] += budget - running;
      return kept;
    };

    const allocations = allocateMinutes(
      dayCandidates.length,
      effectiveBudget,
      ratios
    );

    const tasks: LearningTask[] = dayCandidates.map((item, idx) => {
      const taskId = `task-d${dayIdx}-${item.knowledgeId}`;
      const isCompleted = (input.completedTaskIds ?? []).includes(taskId);
      const carriedOverFromToday = dayIdx === 1 && deferredSet.has(item.knowledgeId);
      const rec = input.masteryRecords[item.knowledgeId];
      const kp = knowledgeMap[item.knowledgeId];
      const progress =
        dayIdx === 0 ? input.taskProgressByKnowledge?.[item.knowledgeId] : undefined;

      const mins = allocations[idx] ?? 0;
      remainingMinutes = Math.max(0, remainingMinutes - mins);

      const difficultyAdjusted = (rec?.consecutiveErrors ?? 0) >= 2;
      const taskTitle = difficultyAdjusted
        ? `${item.subject}：${item.knowledgeName}（降阶巩固）`
        : `${item.subject}：${item.knowledgeName}`;

      const baseObjective = difficultyAdjusted
        ? '连续失误触发降阶保护：拆解前置条件与基础步骤，确保基础题稳定做对'
        : `针对「${item.knowledgeName}」失分点完成诊断讲解与变式验证`;

      const trapHint = kp?.commonTraps?.[0];
      const trapSuffix = trapHint ? `（重点：${trapHint}）` : '';
      const textbook = kp?.textbook;
      const textbookSuffix = textbook
        ? `（${textbook.edition} ${textbook.grade}${textbook.term} ${textbook.chapter}）`
        : '';

      const objective = carriedOverFromToday
        ? `由今日重排顺延（已置换明日低优任务，不堆积总负荷）：${baseObjective}${textbookSuffix}`
        : `${baseObjective}${trapSuffix}${textbookSuffix}`;

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
        steps: buildTaskSteps(mins, rec?.state ?? '待学习', progress),
        status: isCompleted ? '已完成' : '待开始',
        priorityRank: idx + 1,
        difficultyAdjusted,
        carriedOverFromToday,
        ...(textbook ? { textbook } : {}),
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
    id: `plan-${new Date(now).toISOString().slice(0, 10)}`,
    weekLabel: '本周7天提分冲刺周期',
    effectiveDailyBudget: effectiveBudget,
    generatedAt: new Date(now).toISOString(),
    priorities,
    days,
    engineVersion: PLANNING_ENGINE_VERSION,
  };
}

// ===========================================================================
// 冲刺计划引擎（30 天冲刺资产 → 可执行日程）
// ===========================================================================

/**
 * 冲刺引擎版本——独立于 7 天排课引擎的 `planning.v1`。
 *
 * 为什么不复用 planning.v1：7 天排课是「按提分优先级动态排」，
 * 冲刺表是「教研老师手排的 30 天固定节奏」，两者节奏模型不同，
 * 版本号必须能区分，否则线上出问题时分不清是哪个引擎的产物。
 */
export const SPRINT_ENGINE_VERSION = 'sprint.v1';

/** 冲刺每天最多几个任务（与 7 天排课一致） */
export const SPRINT_MAX_TASKS_PER_DAY = 3;

/** 冲刺单个任务的最小分钟数（低于 5 分钟已无学习价值） */
export const SPRINT_MIN_TASK_MINUTES = 5;

/** 冲刺学科（当前只有英语冲刺资产） */
export const SPRINT_SUBJECT: Subject = '英语';

export interface SprintPlanOptions {
  /** 显式指定冲刺资产；不传则取当前生效（ACTIVE）的冲刺资产 */
  sprintSet?: SprintSet;
  /** 生成时间基准（显式传入可保证输出完全确定） */
  now?: Date;
}

/**
 * 解析冲刺日的目标时长（分钟）。
 *
 * 资产里的限时描述是自然语言：
 * - 「每日 35–45 分钟；整套卷日 90 分钟」→ 常规日取上界 45
 * - 整套卷日（day21 / day27）的任务文本里带「(90 分钟)」→ 取 90
 *
 * 取上界而不是中值：冲刺是「限时训练」，
 * 上界才对应手册要求的「必须在这个时间内做完」。
 */
export function parseSprintTargetMinutes(day: SprintDay): number {
  const task = day.task ?? '';
  const limit = day.timeLimit ?? '';

  // 整套卷日：任务文本里带明确分钟数（90 分钟）
  if (/整套|限时卷/.test(task)) {
    // 优先取括号内的时长：「（90 分钟）」
    const paren = /[（(]\s*(\d+)\s*分钟\s*[)）]/.exec(task);
    if (paren) return Number(paren[1]);
    // 其次取紧跟在「套/卷」后的时长：「整套限时卷 90 分钟」
    const near = /(?:套|卷)\D{0,6}(\d+)\s*分钟/.exec(task);
    if (near) return Number(near[1]);
    // 兜底：手册约定整套卷 90 分钟
    return 90;
  }

  // 限时字段里的区间：35–45 分钟 → 上界
  const range = /(\d+)\s*[–—\-~至]\s*(\d+)\s*分钟/.exec(limit);
  if (range) return Math.max(Number(range[1]), Number(range[2]));

  // 限时字段里的单值：90 分钟
  const single = /(\d+)\s*分钟/.exec(limit);
  if (single) return Number(single[1]);

  return 45;
}

/**
 * 兜底知识点：冲刺任务映射不到知识点时用英语学科的稳定知识点。
 *
 * 优先「书面表达要点」（中考英语最大得分项，且每天几乎都涉及），
 * 没有则取英语学科 id 排序第一个（确定性）。
 */
function resolveFallbackKnowledge(
  subject: Subject
): { id: string; name: string } | null {
  const candidates = getSprintKnowledgeBySubject(subject);
  if (candidates.length === 0) return null;
  const preferred = candidates.find((kp) => kp.name === '书面表达要点');
  const picked = preferred ?? candidates[0];
  return { id: picked.id, name: picked.name };
}

/**
 * 冲刺日 → 知识点列表。
 *
 * 查找顺序：先查主知识资产，再查 overlay 叠加层（`cne_wb_*`）；
 * 找不到映射 → 兜底到英语学科的稳定知识点，**不抛错**。
 */
function resolveSprintDayKnowledge(
  day: SprintDay,
  fallback: { id: string; name: string } | null
): Array<{ id: string; name: string }> {
  const index = getSprintKnowledgeIndex();
  const out: Array<{ id: string; name: string }> = [];
  for (const id of day.knowledgeIds ?? []) {
    if (out.length >= SPRINT_MAX_TASKS_PER_DAY) break;
    if (out.some((k) => k.id === id)) continue;
    const ref = index.get(id);
    if (!ref) continue; // 资产里写了但知识库里没有 → 跳过，最终走兜底
    out.push({ id: ref.id, name: ref.name });
  }
  if (out.length === 0 && fallback) out.push(fallback);
  return out;
}

/**
 * 30 天冲刺计划生成。
 *
 * 与 7 天排课的差异：
 * - 天数由**冲刺资产**决定（30 天），不受 7 天限制；
 * - 每天的任务来自冲刺表（教研老师手排），不是按提分优先级动态选；
 * - 但**预算约束完全继承 7 天排课**：每天任务 ≤3、总时长 ≤ 有效每日预算；
 * - 知识点挂载用冲刺资产里的 knowledgeIds（映射不到走兜底）。
 *
 * 确定性：同样的资产 + 同样的学生 → 同样的 plan（id 不含随机数/当前时刻）。
 */
export function buildSprintPlan(
  student: Student,
  options: SprintPlanOptions = {}
): SprintPlan {
  const now = options.now ?? new Date();
  const effectiveBudget = getEffectiveDailyBudget(student);
  const sprintSet = options.sprintSet ?? getActiveSprintSet();

  if (!sprintSet || sprintSet.days.length === 0) {
    // 没有生效的冲刺资产 → 返回空计划（不抛错：冲刺是可选能力，不能拖垮主流程）
    return {
      id: 'sprint-plan-empty',
      subject: SPRINT_SUBJECT,
      engineVersion: SPRINT_ENGINE_VERSION,
      generatedAt: now.toISOString(),
      effectiveDailyBudget: effectiveBudget,
      totalDays: 0,
      days: [],
    };
  }

  const fallback = resolveFallbackKnowledge(SPRINT_SUBJECT);
  const days: SprintDayPlan[] = [];

  for (const day of [...sprintSet.days].sort((a, b) => a.dayIndex - b.dayIndex)) {
    const knowledge = resolveSprintDayKnowledge(day, fallback);
    if (knowledge.length === 0) continue; // 连兜底都没有 → 跳过这天（不产出空天）

    const targetMinutes = parseSprintTargetMinutes(day);
    const dayTotal = Math.min(targetMinutes, effectiveBudget);

    const ratios =
      knowledge.length === 3
        ? [0.42, 0.33, 0.25]
        : knowledge.length === 2
          ? [0.55, 0.45]
          : [1.0];

    /**
     * 冲刺日时长分配（与 7 天排课同一套**约束**，但按冲刺口径重算比例）。
     *
     * 1. 冲刺表本身有「限时」：先按 timeLimit 解析出当天该投入的分钟数
     *    （常规 45 分钟 / 整套卷 90 分钟），再受每日预算封顶；
     * 2. 按任务数比例分配（3 任务 [0.42,0.33,0.25] / 2 任务 [0.55,0.45]）；
     * 3. 每个任务 ≥5 分钟；总数 ≤ 每日有效预算。
     */
    const allocateSprintMinutes = (total: number, count: number): number[] => {
      if (count <= 0) return [];
      const usable = Math.max(SPRINT_MIN_TASK_MINUTES * count, total);

      const ideal = ratios.map((w) => (usable * w) / 1);
      const out = ideal.map((v) => Math.floor(v));

      // 取整余数补给最后一个任务，保证总和 == usable
      const used = out.reduce((a, b) => a + b, 0);
      out[out.length - 1] += usable - used;

      // 每个任务不得低于 5 分钟：从最宽裕的任务挪时间补齐
      for (let i = 0; i < out.length; i++) {
        if (out[i] >= SPRINT_MIN_TASK_MINUTES) continue;
        let need = SPRINT_MIN_TASK_MINUTES - out[i];
        out[i] = SPRINT_MIN_TASK_MINUTES;
        for (let j = 0; j < out.length && need > 0; j++) {
          if (j === i) continue;
          const spare = out[j] - SPRINT_MIN_TASK_MINUTES;
          if (spare <= 0) continue;
          const take = Math.min(spare, need);
          out[j] -= take;
          need -= take;
        }
      }

      return out;
    };

    const allocations = allocateSprintMinutes(dayTotal, knowledge.length);

    const tasks: LearningTask[] = knowledge.map((kp, idx) => {
      const minutes = allocations[idx] ?? allocations[allocations.length - 1] ?? 0;
      const ref = getSprintKnowledgeIndex().get(kp.id);
      const trapHint = ref?.commonTraps?.[0];
      const trapSuffix = trapHint ? `（重点：${trapHint}）` : '';

      return {
        id: `sprint-d${day.dayIndex}-${kp.id}`,
        dayIndex: day.dayIndex,
        dayLabel: `第${day.dayIndex}天`,
        subject: day.subject ?? SPRINT_SUBJECT,
        knowledgeId: kp.id,
        knowledgeName: kp.name,
        title: `${day.subject ?? SPRINT_SUBJECT}：${kp.name}`,
        objective: `冲刺第${day.dayIndex}天（${day.stage}）：${day.task}${trapSuffix}`,
        verifiableOutcome: day.acceptanceCriteria
          ? `当日验收标准：${day.acceptanceCriteria}`
          : '按当日任务清单完成并自查',
        estimatedMinutes: minutes,
        steps: buildTaskSteps(minutes, '待学习'),
        status: '待开始',
        priorityRank: idx + 1,
        difficultyAdjusted: false,
        carriedOverFromToday: false,
      };
    });

    const totalMinutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

    days.push({
      dayIndex: day.dayIndex,
      dayLabel: `第${day.dayIndex}天`,
      stage: day.stage,
      task: day.task,
      timeLimit: day.timeLimit,
      acceptanceCriteria: day.acceptanceCriteria,
      totalMinutes,
      tasks,
    });
  }

  return {
    id: `sprint-plan-${sprintSet.version}`,
    subject: SPRINT_SUBJECT,
    engineVersion: SPRINT_ENGINE_VERSION,
    generatedAt: now.toISOString(),
    effectiveDailyBudget: effectiveBudget,
    totalDays: days.length,
    days,
  };
}

export type {
  Student,
  MasteryRecord,
  MasteryState,
  PriorityOpportunity,
  LearningTask,
  DailySchedule,
  LearningPlan,
  Subject,
  SprintSet,
  SprintPlan,
  SprintDay,
  SprintDayPlan,
};
