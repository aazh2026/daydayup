/**
 * 教练对话 API 契约。
 */

import type { Subject, MasteryState, TeachingBehavior } from '../domain/index.ts';

export interface CoachMessageInput {
  role: 'user' | 'coach';
  text: string;
}

export interface CoachChatRequest {
  subject?: Subject;
  knowledgeName?: string;
  knowledgeDefinition?: string;
  commonTraps?: string[];
  masteryState?: MasteryState | string;
  socraticStage?: number;
  requestFullExplanation?: boolean;
  teachingBehavior?: TeachingBehavior | string;
  history?: CoachMessageInput[];
  studentMessage?: string;
  activeProblem?: string;
}

export interface CoachChatResponse {
  reply: string;
  teachingBehaviorUsed: string;
  nextStage: number;
  detectedUnderstanding: string;
  suggestedQuickReplies: string[];
}

export function parseCoachChatResponse(raw: unknown): CoachChatResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.reply !== 'string') return null;
  if (typeof r.nextStage !== 'number') return null;
  if (!Array.isArray(r.suggestedQuickReplies)) return null;
  return r as unknown as CoachChatResponse;
}

export type { Subject, MasteryState, TeachingBehavior };
