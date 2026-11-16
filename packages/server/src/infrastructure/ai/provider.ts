/**
 * AI Provider 抽象。
 *
 * 现状痛点（server.ts 中 5 处重复）：
 * - 无超时（模型 hang 住则请求永久挂起）
 * - 无重试（单次网络抖动 = 整个请求 500）
 * - 无 schema 校验（JSON.parse 崩则整个流程中断）
 * - 无提示词版本（改了 prompt 无法回溯结果差异）
 * - 无成本护栏（token 额度无上限）
 *
 * 本模块统一收敛这些横切能力。
 */

export type AIPurpose =
  | 'diagnosis'
  | 'practice-generate'
  | 'practice-verify'
  | 'practice-evaluate'
  | 'coach'
  | 'microquiz';

export interface AIJsonSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'BOOLEAN';
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  description?: string;
}

export interface GenerateJsonRequest<T = unknown> {
  purpose: AIPurpose;
  prompt: string;
  systemInstruction?: string;
  schema: AIJsonSchema;
  temperature?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface GenerateJsonResult<T = unknown> {
  data: T | null;
  /** schema 校验是否通过 */
  validated: boolean;
  attempts: number;
  /** 失败原因（成功时为 null） */
  error: string | null;
  /** 记录实际使用的提示词版本 */
  promptVersion: string;
  model: string;
}

export interface AIProvider {
  generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResult<T>>;
}
