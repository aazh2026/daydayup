/**
 * 本地计划降级渲染（仅展示用，非权威数据）。
 *
 * 用途：服务端不可用时（如本地开发未启动后端），
 * 前端仍能渲染一份计划草稿，避免页面空白。
 *
 * 重要：本模块**不是**业务逻辑的权威实现。
 * 权威实现在 packages/server/src/engines/planning-engine.ts。
 * 此处仅在 UI 层做最小可用的降级（不参与任何评分、落库或状态迁移）。
 *
 * 降级只简化**优先级公式**（服务端有前置依赖/紧急度/复测等修正因子），
 * 但**展示性字段**（学科、知识点名称）仍应取自知识体系资产 ——
 * 否则英语/物理/化学的学生会看到一屏「数学」任务。
 */
import type {
  AppState,
  LearningPlan,
  DailySchedule,
  LearningTask,
  PriorityOpportunity,
  MasteryState,
  Subject,
  KnowledgePoint,
} from '@daydayup/contracts';

const DAY_LABELS = ['今天', '明天', '第3天', '第4天', '第5天', '第6天', '第7天'];

const CONFIDENCE_WEIGHT = {
  确定: 1.0,
  较可能: 0.8,
  待验证: 0.55,
} as const;

/** 每日有效预算（降级版，与服务端规则一致） */
export function getEffectiveDailyBudgetFallback(student: AppState['student']): number {
  let factor = 1.0;
  if (student.homeworkLoad === '较重') factor -= 0.15;
  if (student.homeworkLoad === '轻松') factor += 0.1;
  if (student.fatigueLevel === '高') factor -= 0.15;
  return Math.max(30, Math.round((student.dailyBudgetMinutes * factor) / 5) * 5);
}

/**
 * 构造本地降级计划。
 *
 * @param state 应用状态
 * @param knowledgeMap 知识体系索引（id → KnowledgePoint）——
 *   用于还原学科与知识点名称。缺失时回退到 id（仅影响展示）。
 */
export function buildLocalPlanFallback(
  state: AppState,
  knowledgeMap: Record<string, KnowledgePoint> = {}
): LearningPlan {
  const effectiveBudget = getEffectiveDailyBudgetFallback(state.student);

  const opportunities: PriorityOpportunity[] = Object.entries(state.masteryRecords)
    .filter(([, rec]) => rec.state !== '稳定掌握')
    .map(([knowledgeId, rec]) => {
      const kp = knowledgeMap[knowledgeId];
      const lostScore = Math.max(1, rec.lostScoreEvidence);
      const expectedGain = Number((lostScore * rec.recoveryProbability).toFixed(1));
      const confWeight = CONFIDENCE_WEIGHT[rec.confidence] ?? 0.55;
      const priorityScore = Number(
        ((expectedGain * confWeight) / 2).toFixed(2)
      );
      return {
        knowledgeId,
        // 学科与名称取自知识体系资产（服务端同一来源）
        subject: (kp?.subject ?? '数学') as Subject,
        knowledgeName: kp?.name ?? knowledgeId,
        domain: kp?.domain ?? '',
        lostScore,
        recoveryProbability: rec.recoveryProbability,
        expectedGain,
        learningCostHours: kp?.learningCostHours ?? 2,
        confidenceScore: confWeight,
        confidenceLabel: rec.confidence,
        examWeight: kp?.examWeight ?? 1,
        priorityScore,
        priorityTier:
          priorityScore >= 1.35
            ? ('高' as const)
            : priorityScore < 0.7
              ? ('低' as const)
              : ('中' as const),
        rationale: `预计投入 2 小时可恢复约 ${expectedGain} 分`,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);

  const priorities = opportunities.slice(0, 6);
  const days: DailySchedule[] = [];

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayCandidates = priorities.slice(0, 3);
    let remaining = effectiveBudget;
    const ratios = dayCandidates.length === 3 ? [0.42, 0.33, 0.25] : dayCandidates.length === 2 ? [0.55, 0.45] : [1.0];

    const tasks: LearningTask[] = dayCandidates.map((item, idx) => {
      const mins =
        idx === dayCandidates.length - 1
          ? Math.max(10, remaining)
          : Math.max(15, Math.round((effectiveBudget * ratios[idx]) / 5) * 5);
      remaining = Math.max(0, remaining - mins);

      const rec = state.masteryRecords[item.knowledgeId];
      const state_: MasteryState = rec?.state ?? '待学习';

      return {
        id: `task-d${dayIdx}-${item.knowledgeId}`,
        dayIndex: dayIdx,
        dayLabel: DAY_LABELS[dayIdx],
        subject: item.subject,
        knowledgeId: item.knowledgeId,
        knowledgeName: item.knowledgeName,
        title: `${item.subject}：${item.knowledgeName}`,
        objective: `针对「${item.knowledgeName}」失分点完成诊断讲解与变式验证`,
        verifiableOutcome: '完成核心规则梳理并独立做对基础/同类题',
        estimatedMinutes: mins,
        steps: buildStepsFallback(mins, state_),
        status: state.completedTaskIds.includes(`task-d${dayIdx}-${item.knowledgeId}`)
          ? '已完成'
          : '待开始',
        priorityRank: idx + 1,
        difficultyAdjusted: (rec?.consecutiveErrors ?? 0) >= 2,
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
    id: `plan-local-${new Date().toISOString().slice(0, 10)}`,
    weekLabel: '本周7天提分冲刺周期',
    effectiveDailyBudget: effectiveBudget,
    generatedAt: new Date().toISOString(),
    priorities,
    days,
    engineVersion: 'local-fallback.v1',
  };
}

function buildStepsFallback(minutes: number, state: MasteryState): LearningTask['steps'] {
  const m1 = Math.max(5, Math.round(minutes * 0.2));
  const m2 = Math.max(5, Math.round(minutes * 0.2));
  const m3 = Math.max(8, Math.round(minutes * 0.45));
  const m4 = Math.max(2, minutes - m1 - m2 - m3);

  if (state === '初步掌握' || state === '掌握') {
    return [
      { label: '易错点快速回顾', minutes: m1, done: false },
      { label: '变式题与迁移训练', minutes: m2 + m3, done: false },
      { label: '独立评测与复盘', minutes: m4, done: false },
    ];
  }
  return [
    { label: '复习核心知识点', minutes: m1, done: false },
    { label: '观看典型例题示范', minutes: m2, done: false },
    { label: '独立完成变式练习题', minutes: m3, done: false },
    { label: '查看AI错因反馈', minutes: m4, done: false },
  ];
}
