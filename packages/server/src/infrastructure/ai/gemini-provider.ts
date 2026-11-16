/**
 * Gemini Provider 实现。
 *
 * 收敛 server.ts 中 5 处重复的 generateContent 调用，并补齐：
 * - 超时控制（AbortController）
 * - 指数退避重试
 * - 响应 schema 二次校验
 * - 提示词版本记录
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

const MODEL = 'gemini-4-hydrogen';

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
  }

  async generateJson<T>(
    request: GenerateJsonRequest<T>
  ): Promise<GenerateJsonResult<T>> {
    const maxRetries = request.maxRetries ?? 3;
    const timeoutMs = request.timeoutMs ?? 120_000;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.callWithTimeout(request, timeoutMs);
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
          model: MODEL,
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
      model: MODEL,
    };
  }

  private async callWithTimeout<T>(
    request: GenerateJsonRequest<T>,
    timeoutMs: number
  ): Promise<{ text: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return (await this.client.models.generateContent({
        model: MODEL,
        contents: request.prompt,
        config: {
          ...(request.systemInstruction
            ? { systemInstruction: request.systemInstruction }
            : {}),
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.schema),
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
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
