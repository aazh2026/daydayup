/**
 * 冲刺计划取数层。
 *
 * 30 天冲刺是服务端权威资产（`GET /api/v1/students/:id/sprint-plan`），
 * 前端只负责展示，不在本地重排 —— 重排规则见
 * `packages/server/src/engines/planning-engine.ts` 的 `buildSprintPlan()`。
 */
import type { SprintPlan } from '@daydayup/contracts';
import { api } from './client.ts';

/** 拉取服务端权威的 30 天冲刺计划 */
export async function fetchSprintPlan(studentId: string): Promise<SprintPlan> {
  return api.get<SprintPlan>(`/api/v1/students/${studentId}/sprint-plan`);
}

/** 外部真题（题庄）取数 —— 教研题库未命中时的第二来源 */
export interface ExternalQuestion {
  id: string;
  subject: string;
  questionType: string;
  level: string;
  stem: string;
  options?: string[];
  standardAnswer: string;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

export interface ExternalQuestionsResult {
  found: boolean;
  source: string;
  questions: ExternalQuestion[];
  quotaRemaining: number | null;
  resolvedKnowledgeId?: string;
  /** 机器可读降级原因：NO_KNOWLEDGE_MAPPING / NO_QUESTIONS / TIZHUANG_* */
  reason?: string;
  message?: string;
}

export async function fetchExternalQuestions(
  knowledgeId: string,
  options?: { limit?: number; questionType?: string; forceOnline?: boolean }
): Promise<ExternalQuestionsResult> {
  const params = new URLSearchParams({ knowledgeId });
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.questionType) params.set('questionType', options.questionType);
  if (options?.forceOnline) params.set('forceOnline', '1');
  return api.get<ExternalQuestionsResult>(
    `/api/v1/practice/external?${params.toString()}`
  );
}

export type { SprintPlan };
