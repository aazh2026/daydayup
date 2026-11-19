/**
 * Gemini Provider 实现。
 *
 * 收敛 server.ts 中 5 处重复的 generateContent 调用，并补齐：
 * - 超时控制（AbortController）
 * - 指数退避重试
 * - 响应 schema 二次校验
 * - 提示词版本记录
 *
 * **运行时可配置**：模型、温度、超时、重试次数不再写死，
 * 由调用方通过 `GenerateJsonRequest` 逐次传入（来自 AI 配置中心）。
 */
import { GoogleGenAI, Type } from '@google/genai';
import type {
  AIProvider,
  GenerateJsonRequest,
  GenerateJsonResult,
  AIJsonSchema,
} from './provider.ts';
import { validateAgainstSchema } from './schema-validator.ts';
import { getPromptVersion } from './prompts/registry.ts';

/** 默认模型（未提供运行时配置时使用） */
export const DEFAULT_AI_MODEL = 'gemini-4-hydrogen';
/** 默认采样温度 */
export const DEFAULT_AI_TEMPERATURE = 0.2;
/** 默认单次调用超时（毫秒） */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;
/** 默认最大尝试次数 */
export const DEFAULT_AI_MAX_RETRIES = 3;

export interface GeminiProviderOptions {
  /** 运行时模型 ID（缺省用 DEFAULT_AI_MODEL） */
  model?: string;
  /** 运行时温度（缺省用 DEFAULT_AI_TEMPERATURE） */
  temperature?: number;
  /** 运行时超时（缺省用 DEFAULT_AI_TIMEOUT_MS） */
  timeoutMs?: number;
  /** 运行时重试次数（缺省用 DEFAULT_AI_MAX_RETRIES） */
  maxRetries?: number;
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  /**
   * 运行时参数（模型/温度/超时/重试）。
   *
   * 非 readonly：`applyOptions()` 需要在配置中心保存后**热更新**这些值，
   * 让改动立刻生效而不必重建 Provider（客户端持有 API Key，重建会丢状态）。
   */
  private options: Required<GeminiProviderOptions>;
  constructor(apiKey: string, options: GeminiProviderOptions = {}) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
    this.options = {
      model: options.model ?? DEFAULT_AI_MODEL,
      temperature: options.temperature ?? DEFAULT_AI_TEMPERATURE,
      timeoutMs: options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_AI_MAX_RETRIES,
    };
  }

  /**
   * 运行时改写 Provider 默认参数（配置中心保存后调用）。
   *
   * 之所以要「热改」而不是重建 Provider：
   * GoogleGenAI 客户端持有 API Key，重建会丢弃密钥状态；
   * 而模型/温度/超时/重试都是**每次调用时读取**的参数，
   * 热改即可立刻生效。
   */
  applyOptions(options: GeminiProviderOptions): void {
    this.options = {
      model: options.model ?? this.options.model,
      temperature: options.temperature ?? this.options.temperature,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs,
      maxRetries: options.maxRetries ?? this.options.maxRetries,
    };
  }

  /** 当前生效的模型 ID */
  get model(): string {
    return this.options.model;
  }

  async generateJson<T>(
    request: GenerateJsonRequest<T>
  ): Promise<GenerateJsonResult<T>> {
    const maxRetries = request.maxRetries ?? this.options.maxRetries;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const model = request.model ?? this.options.model;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.callWithTimeout(request, timeoutMs, model);
        const text = (response.text ?? '').trim();

        let parsed: unknown;
        try {
          parsed = JSON.parse(text || '{}');
        } catch {
          lastError = '模型返回内容不是合法 JSON';
          await this.backoff(attempt, maxRetries);
          continue;
        }

        const validated = validateAgainstSchema(parsed, request.schema);
        if (!validated) {
          lastError = '模型返回结构不符合 schema';
          await this.backoff(attempt, maxRetries);
          continue;
        }

        return {
          data: parsed as T,
          validated: true,
          attempts: attempt,
          error: null,
          promptVersion: getPromptVersion(request.purpose),
          model,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.backoff(attempt, maxRetries);
      }
    }

    return {
      data: null,
      validated: false,
      attempts: maxRetries,
      error: lastError ?? 'AI 调用失败',
      promptVersion: getPromptVersion(request.purpose),
      model,
    };
  }

  private async callWithTimeout<T>(
    request: GenerateJsonRequest<T>,
    timeoutMs: number,
    model: string
  ): Promise<{ text: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return (await this.client.models.generateContent({
        model,
        contents: request.prompt,
        config: {
          ...(request.systemInstruction
            ? { systemInstruction: request.systemInstruction }
            : {}),
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.schema),
          temperature: request.temperature ?? this.options.temperature,
        },
      })) as { text: string | null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async backoff(attempt: number, maxRetries: number): Promise<void> {
    if (attempt >= maxRetries) return;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * 把内部 AIJsonSchema 转换为 Gemini 的 Type 枚举。
 */
export function toGeminiSchema(schema: AIJsonSchema): unknown {
  const base: Record<string, unknown> = { type: schema.type };

  switch (schema.type) {
    case 'OBJECT':
      base.properties = schema.properties
        ? Object.fromEntries(
            Object.entries(schema.properties).map(([key, value]) => [
              key,
              toGeminiSchema(value as AIJsonSchema),
            ])
          )
        : {};
      if (schema.required) base.required = schema.required;
      break;
    case 'ARRAY':
      base.items = schema.items ? toGeminiSchema(schema.items as AIJsonSchema) : {};
      break;
    default:
      break;
  }

  if (schema.description) base.description = schema.description;

  /**
   * 透传 enum —— 让 Gemini 侧也遵守受控词表，
   * 而不是只靠 prompt 文字约束 + 事后校验。
   */
  if (schema.enum && schema.enum.length > 0) {
    base.enum = schema.enum;
  }

  // 转换 Type 枚举为 Gemini 期望的字符串常量
  switch (schema.type) {
    case 'OBJECT':
      base.type = Type.OBJECT;
      break;
    case 'ARRAY':
      base.type = Type.ARRAY;
      break;
    case 'STRING':
      base.type = Type.STRING;
      break;
    case 'NUMBER':
      base.type = Type.NUMBER;
      break;
    case 'BOOLEAN':
      base.type = Type.BOOLEAN;
      break;
    default:
      break;
  }

  return base;
}
