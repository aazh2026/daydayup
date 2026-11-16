/**
 * 掌握度与提分机会 API 契约。
 *
 * 关键：掌握度状态迁移由服务端 MasteryEngine 计算，
 * 前端只消费 authoritative 变更结果，不得本地推导。
 */

import type {
  Subject,
  MasteryState,
  ConfidenceLevel,
  PracticeMode,
  PriorityOpportunity,
} from '../domain/index.ts';

export interface MasteryChange {
  knowledgeId: string;
  previousState: MasteryState;
  newState: MasteryState;
  transitionEventId: string;
}

export interface RetestStatus {
  unlocked: boolean;
  daysRemaining: number;
  reason: string;
}

export interface SubmitAttemptRequest {
  studentId?: string;
  taskId?: string;
  knowledgeId: string;
  questionId?: string;
  mode: PracticeMode;
  studentAnswer: string;
  hintsUsed?: number;
  timeSpentSeconds?: number;
  independent?: boolean;
}

export interface SubmitAttemptResponse {
  attemptId?: string;
  isCorrect: boolean;
  errorType?: string;
  feedback: string;
  stepHint?: string;
  nextRecommendation?: string;
  /** 服务端权威的掌握度变更 */
  mastery?: MasteryChange;
  updatedOpportunity?: PriorityOpportunity;
}

export function parseRetestStatus(raw: unknown): RetestStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.unlocked !== 'boolean') return null;
  if (typeof r.daysRemaining !== 'number') return null;
  if (typeof r.reason !== 'string') return null;
  return r as unknown as RetestStatus;
}

export type { MasteryState, ConfidenceLevel, PracticeMode, Subject };
export type { MasteryRecord, MasteryTransitionEvent, PriorityOpportunity } from '../domain/index.ts';
