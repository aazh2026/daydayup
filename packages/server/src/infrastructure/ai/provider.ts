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
  /**
   * 允许的取值集合（仅对 STRING 生效）。
   *
   * Gemini 的 responseSchema 支持 enum，但本项目之前没有透传，
   * 导致「五维错因」「置信度」这类受控词表只能靠 prompt 文字约束 ——
   * 模型返回别的值时服务端也不拦。
   *
   * 现在本地校验器会强制这个集合，
   * 保证落库的是规格定义的枚举值。
   */
  enum?: string[];
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
