/**
 * AI 配置契约。
 *
 * 背景：系统已具备完整的 AI 能力（试卷诊断、AI 教练、出题、评测、微测），
 * 但所有 AI 参数都是**环境变量 + 启动时固化**：
 * - `GEMINI_API_KEY` 缺失 → 整个 AI 能力不可用（`container.ai = null`）
 * - 模型名 `gemini-4-hydrogen` 硬编码在 3 处
 * - 温度、超时、重试次数无任何入口
 *
 * 本契约定义「运行时可配置」的 AI 设置，供服务端持久化与前端配置页共用。
 *
 * 安全约束：**API Key 永不明文回传**。
 * 服务端只返回掩码（末 4 位）与「是否已配置」标志。
 */

/** AI 能力用途（与提示词注册表一一对应） */
export const AI_PURPOSES = [
  'diagnosis',
  'practice-generate',
  'practice-verify',
  'practice-evaluate',
  'coach',
  'microquiz',
] as const;

export type AIPurposeId = (typeof AI_PURPOSES)[number];

/** 可选模型清单（供配置页下拉） */
export const AI_MODEL_OPTIONS = [
  'gemini-4-hydrogen',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
] as const;

export type AIModelId = (typeof AI_MODEL_OPTIONS)[number];

/**
 * AI 配置（对外视图）。
 *
 * 注意 `apiKeyMasked` / `hasApiKey`：
 * 服务端**不返回**明文 Key，只返回掩码。
 */
export interface AIConfig {
  /** 是否已配置 API Key（明文不外泄） */
  hasApiKey: boolean;
  /** API Key 掩码（末 4 位），未配置时为空串 */
  apiKeyMasked: string;
  /** 模型 ID */
  model: string;
  /** 采样温度 0~2 */
  temperature: number;
  /** 单次调用超时（毫秒） */
  timeoutMs: number;
  /** 单次请求最大尝试次数 */
  maxRetries: number;
  /** 每日调用上限（0 = 不限制） */
  dailyQuota: number;
  /** AI 能力是否启用（关闭后所有 AI 端点返回明确错误） */
  enabled: boolean;
  /** 配置来源：runtime = 后台改过，env = 仍来自环境变量 */
  source: 'env' | 'runtime';
  /** 最近一次修改时间 */
  updatedAt: string | null;
  /** 最近一次修改人 */
  updatedBy: string | null;
}

/** 修改 AI 配置的请求体 */
export interface UpdateAIConfigRequest {
  /**
   * 新的 API Key。
   * 传空串或省略表示**不修改**已有 Key（避免前端每次回显掩码时把 Key 擦掉）。
   */
  apiKey?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  dailyQuota?: number;
  enabled?: boolean;
}

/** 连接测试结果 */
export interface TestAIConnectionResult {
  ok: boolean;
  /** 失败原因（成功时为 null） */
  error: string | null;
  /** 实际使用的模型 */
  model: string;
  /** 往返耗时（毫秒） */
  latencyMs: number;
  /** 测试时间 */
  testedAt: string;
}

/** AI 配置响应体 */
export interface AIConfigResponse {
  config: AIConfig;
  /** 服务端可用的模型清单 */
  models: readonly string[];
}

/** 数值边界（服务端与前端共用，避免两边规则漂移） */
export const AI_CONFIG_LIMITS = {
  temperature: { min: 0, max: 2 },
  timeoutMs: { min: 5_000, max: 600_000 },
  maxRetries: { min: 1, max: 5 },
  dailyQuota: { min: 0, max: 100_000 },
} as const;

/**
 * 校验 AI 配置更新请求。
 *
 * 纯函数（契约包只放类型与纯校验函数）。
 *
 * @returns 错误消息数组；为空数组表示通过
 */
export function validateAIConfigUpdate(
  body: unknown
): string[] {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null) {
    return ['请求体必须是对象'];
  }

  const input = body as Record<string, unknown>;

  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string') {
      errors.push('apiKey 必须是字符串');
    } else if (input.apiKey.length > 512) {
      errors.push('apiKey 过长');
    }
  }

  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.trim().length === 0) {
      errors.push('model 不能为空');
    } else if (input.model.length > 120) {
      errors.push('model 过长');
    }
  }

  if (input.temperature !== undefined) {
    const value = input.temperature;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push('temperature 必须是数字');
    } else if (
      value < AI_CONFIG_LIMITS.temperature.min ||
      value > AI_CONFIG_LIMITS.temperature.max
    ) {
      errors.push(
        `temperature 必须在 ${AI_CONFIG_LIMITS.temperature.min}~${AI_CONFIG_LIMITS.temperature.max} 之间`
      );
    }
  }

  if (input.timeoutMs !== undefined) {
    const value = input.timeoutMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push('timeoutMs 必须是数字');
    } else if (
      value < AI_CONFIG_LIMITS.timeoutMs.min ||
      value > AI_CONFIG_LIMITS.timeoutMs.max
    ) {
      errors.push(
        `timeoutMs 必须在 ${AI_CONFIG_LIMITS.timeoutMs.min}~${AI_CONFIG_LIMITS.timeoutMs.max} 之间`
      );
    }
  }

  if (input.maxRetries !== undefined) {
    const value = input.maxRetries;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push('maxRetries 必须是数字');
    } else if (
      value < AI_CONFIG_LIMITS.maxRetries.min ||
      value > AI_CONFIG_LIMITS.maxRetries.max
    ) {
      errors.push(
        `maxRetries 必须在 ${AI_CONFIG_LIMITS.maxRetries.min}~${AI_CONFIG_LIMITS.maxRetries.max} 之间`
      );
    }
  }

  if (input.dailyQuota !== undefined) {
    const value = input.dailyQuota;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push('dailyQuota 必须是数字');
    } else if (
      value < AI_CONFIG_LIMITS.dailyQuota.min ||
      value > AI_CONFIG_LIMITS.dailyQuota.max
    ) {
      errors.push(
        `dailyQuota 必须在 ${AI_CONFIG_LIMITS.dailyQuota.min}~${AI_CONFIG_LIMITS.dailyQuota.max} 之间`
      );
    }
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    errors.push('enabled 必须是布尔值');
  }

  return errors;
}

/**
 * 生成 API Key 掩码。
 *
 * 只保留末 4 位；长度不足时全部打码。
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 4) return '****';
  return `****${apiKey.slice(-4)}`;
}

/** 校验 AI 配置响应体 */
export function parseAIConfigResponse(raw: unknown): AIConfigResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const root = raw as { config?: unknown; models?: unknown };
  if (typeof root.config !== 'object' || root.config === null) return null;
  const config = root.config as Record<string, unknown>;
  if (typeof config.model !== 'string') return null;
  if (typeof config.enabled !== 'boolean') return null;
  if (typeof config.hasApiKey !== 'boolean') return null;
  return {
    config: config as unknown as AIConfig,
    models: Array.isArray(root.models) ? (root.models as string[]) : [],
  };
}
