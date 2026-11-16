/**
 * 练习与评测 API 契约。
 *
 * 现状：/api/practice/generate 执行 Pass1 生成 + Pass2 独立盲解审计（双轮验算）。
 * 该机制是产品质量关键（防止模型给出错误标准答案），分离时必须完整保留。
 */

import type { Subject, PracticeMode, QuestionLevel } from '../domain/index.ts';

export interface GeneratePracticeRequest {
  subject?: Subject;
  knowledgeId: string;
  knowledgeName?: string;
  subSkills?: string[];
  commonTraps?: string[];
  level?: QuestionLevel | string;
  sourceErrorStem?: string;
}

export interface GeneratePracticeResponse {
  stem: string;
  questionType: string;
  options: string[];
  standardAnswer: string;
  solutionSteps: string[];
  commonTrap: string;
  /** 双轮独立验算是否一致 */
  dualVerified?: boolean;
  /** 验算依据说明 */
  verificationCheck?: string;
}

export interface EvaluateRequest {
  subject?: Subject;
  knowledgeName?: string;
  stem?: string;
  standardAnswer?: string;
  studentAnswer?: string;
}

export interface EvaluateResponse {
  isCorrect: boolean;
  errorType: string;
  feedback: string;
  stepHint: string;
  nextRecommendation: string;
}

export function parseGeneratePracticeResponse(raw: unknown): GeneratePracticeResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stem !== 'string') return null;
  if (typeof r.standardAnswer !== 'string') return null;
  if (!Array.isArray(r.solutionSteps)) return null;
  return r as unknown as GeneratePracticeResponse;
}

export function parseEvaluateResponse(raw: unknown): EvaluateResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.isCorrect !== 'boolean') return null;
  if (typeof r.feedback !== 'string') return null;
  return r as unknown as EvaluateResponse;
}

export type { PracticeMode, QuestionLevel };
