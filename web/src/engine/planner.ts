/**
 * 前端规划适配层。
 *
 * 分离后状态机与算法下沉到服务端，本文件只保留「取数」职责。
 *
 * 迁移记录：
 *   原 src/engine/planner.ts 包含 4 个业务函数：
 *     - computePriorityOpportunities  → 服务端 ScoreEngine（GET /students/:id/opportunities）
 *     - buildSevenDayPlan             → 服务端 PlanningEngine（GET /students/:id/plans/current）
 *     - evaluateMasteryTransition     → 服务端 MasteryEngine（POST /mastery/:kid/attempt）
 *     - getEffectiveDailyBudget       → 服务端（GET /students/:id/effective-budget）
 *   全部迁至 packages/server/src/engines/，前端不再本地推导。
 *
 * 原因：掌握度、提分优先级、每日学习时长约束都是不可被学生篡改的数据。
 * 放在前端等于把评分逻辑交给学生自己改 JS。
 */
import type {
  LearningPlan,
  MasteryRecord,
  PriorityOpportunity,
  Student,
} from '@daydayup/contracts';
import { api } from '../api/client.ts';

export { MASTERY_ORDER, RETEST_INTERVAL_DAYS, CONFIDENCE_WEIGHT } from '@daydayup/contracts';

/**
 * 距离中考天数。
 *
 * 这是一个纯展示用的日历计算（不参与任何评分或约束），
 * 且依赖用户本地日期更自然，保留在前端。
 */
export function computeDaysToZhongkao(
  targetExamDate: string,
  now: Date = new Date()
): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(targetExamDate);
  if (Number.isNaN(target.getTime())) return 200;
  const diffMs = target.getTime() - today.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/** 拉取服务端权威的提分机会 */
export async function fetchPriorityOpportunities(
  studentId: string
): Promise<PriorityOpportunity[]> {
  const res = await api.get<{ opportunities: PriorityOpportunity[] }>(
    `/api/v1/students/${studentId}/opportunities`
  );
  return res.opportunities ?? [];
}

/** 拉取服务端权威的 7 天计划 */
export async function fetchCurrentPlan(studentId: string): Promise<LearningPlan> {
  return api.get<LearningPlan>(`/api/v1/students/${studentId}/plans/current`);
}

/** 拉取服务端权威的每日有效预算 */
export async function fetchEffectiveBudget(
  studentId: string
): Promise<number> {
  const res = await api.get<{ effectiveDailyBudget: number }>(
    `/api/v1/students/${studentId}/effective-budget`
  );
  return res.effectiveDailyBudget;
}

/**
 * 延迟复测解锁状态 —— 服务端权威。
 *
 * 原前端实现直接读 Date.now()，学生改系统时间即可提前解锁复测。
 * 现由服务端按自身时钟判定。
 */
export async function fetchRetestStatus(
  studentId: string,
  knowledgeId: string
): Promise<{ unlocked: boolean; daysRemaining: number; reason: string }> {
  return api.get(`/api/v1/students/${studentId}/mastery/${knowledgeId}/retest-status`);
}

/**
 * 提交作答 → 服务端判定并迁移掌握度 → 返回权威变更。
 */
export async function submitMasteryAttempt(
  studentId: string,
  knowledgeId: string,
  payload: {
    mode: string;
    isCorrect: boolean;
    evidenceSummary?: string;
    subject?: string;
    hintsUsed?: number;
    timeSpentSeconds?: number;
    independent?: boolean;
  }
): Promise<{
  mastery: {
    knowledgeId: string;
    previousState: MasteryRecord['state'];
    newState: MasteryRecord['state'];
    transitionEventId: string;
  };
  updatedOpportunity?: PriorityOpportunity;
  record: MasteryRecord;
}> {
  return api.post(
    `/api/v1/students/${studentId}/mastery/${knowledgeId}/attempt`,
    payload
  );
}

export type { LearningPlan, MasteryRecord, PriorityOpportunity, Student };
