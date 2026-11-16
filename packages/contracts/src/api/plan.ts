/**
 * 学习计划 API 契约。
 *
 * 分离后计划由服务端 PlanningEngine 生成（前端不再本地计算），
 * effectiveDailyBudget 与任务时长约束均以服务端为准。
 */

import type {
  Subject,
  PriorityOpportunity,
  LearningPlan,
  LearningTaskStatus,
} from '../domain/index.ts';

export interface TaskStatePatch {
  status?: LearningTaskStatus;
  deferred?: boolean;
  progress?: {
    reviewedConcept?: boolean;
    viewedExample?: boolean;
    practiceSolvedDelta?: number;
    reviewedFeedback?: boolean;
  };
}

export function parseLearningPlan(raw: unknown): LearningPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.effectiveDailyBudget !== 'number') return null;
  if (!Array.isArray(r.days)) return null;
  if (!Array.isArray(r.priorities)) return null;
  for (const day of r.days as unknown[]) {
    if (typeof day !== 'object' || day === null) return null;
    const d = day as Record<string, unknown>;
    if (!Array.isArray(d.tasks)) return null;
  }
  return r as unknown as LearningPlan;
}

export type { TaskStep, LearningTask, LearningTaskStatus, DailySchedule, LearningPlan } from '../domain/index.ts';
