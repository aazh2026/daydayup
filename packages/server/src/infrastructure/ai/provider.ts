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
  /**
   * 运行时模型 ID。
   *
   * 不传则用 Provider 的默认模型（来自 AI 配置中心）。
   * 提供它是为了让「配置生效」在**单次调用粒度**也可验证，
   * 而不必依赖 Provider 的可变状态。
   */
  model?: string;
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

/**
 * Provider 运行时参数（来自 AI 配置中心）。
 */
export interface AIProviderRuntimeOptions {
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * 支持热更新的 Provider（可选能力）。
 *
 * 为什么需要：配置中心保存后要**立刻生效**，
 * 而重建 Provider 会丢弃已持有的 API Key 客户端。
 * 用类型守卫判断 Provider 是否支持热更新，避免 `as any`。
 */
export interface MutableAIProvider extends AIProvider {
  applyOptions(options: AIProviderRuntimeOptions): void;
}

/**
 * 判断 Provider 是否支持运行时热更新。
 */
export function isMutableAIProvider(
  provider: AIProvider
): provider is MutableAIProvider {
  return typeof (provider as Partial<MutableAIProvider>).applyOptions === 'function';
}
