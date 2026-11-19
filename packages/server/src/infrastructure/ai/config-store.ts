/**
 * AI 配置存储服务。
 *
 * 解决的问题：AI 相关参数此前全部锁死在环境变量里，
 * 改一次模型或换一个 Key 就要改 `.env` + 重启进程，
 * 而且 `GEMINI_API_KEY` 缺失会让**整个 AI 能力直接消失**
 * （`container.ts:49` → `container.ai = null`）。
 *
 * 设计：
 * - **环境变量是默认值，不是唯一真相源**。
 *   后台改过一次后，落盘的运行时配置优先生效（`source: 'runtime'`）。
 * - **API Key 明文只存在服务端**（`dataDir/db/ai-config.json`），
 *   对外一律返回掩码（`maskApiKey`）。
 * - **进程内缓存 + 写后立即失效**，
 *   让「保存后立刻生效」而不必重启。
 */
import type { FileDatabase } from '../persistence/file-database.ts';
import { logger } from '../logging/logger.ts';
import {
  maskApiKey,
  type AIConfig,
  type UpdateAIConfigRequest,
} from '@daydayup/contracts';

/** 环境变量提供的默认配置 */
export interface AIConfigDefaults {
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  dailyQuota: number;
  enabled: boolean;
}

/** 落盘的运行时配置（明文 Key 只在这里） */
interface PersistedAIConfig {
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  dailyQuota: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

const STORE_PATH = ['db', 'ai-config.json'];

export class AIConfigStore {
  private readonly db: FileDatabase;
  private readonly defaults: AIConfigDefaults;
  /** 进程内缓存：避免每次 AI 调用都读盘 */
  private cache: PersistedAIConfig | null = null;
  private loaded = false;

  constructor(db: FileDatabase, defaults: AIConfigDefaults) {
    this.db = db;
    this.defaults = defaults;
  }

  /**
   * 读取生效配置（运行时配置优先，回落到环境变量默认值）。
   */
  async get(): Promise<PersistedAIConfig> {
    if (this.loaded && this.cache) return this.cache;

    const persisted = await this.db.read<PersistedAIConfig>(STORE_PATH);
    if (persisted && typeof persisted.model === 'string') {
      this.cache = {
        apiKey: persisted.apiKey ?? '',
        model: persisted.model,
        temperature: Number(persisted.temperature ?? this.defaults.temperature),
        timeoutMs: Number(persisted.timeoutMs ?? this.defaults.timeoutMs),
        maxRetries: Number(persisted.maxRetries ?? this.defaults.maxRetries),
        dailyQuota: Number(persisted.dailyQuota ?? this.defaults.dailyQuota),
        enabled: persisted.enabled !== false,
        updatedAt: persisted.updatedAt ?? new Date(0).toISOString(),
        updatedBy: persisted.updatedBy ?? null,
      };
      this.loaded = true;
      return this.cache;
    }

    // 没有运行时配置：回落环境变量默认值
    this.cache = {
      apiKey: this.defaults.apiKey,
      model: this.defaults.model,
      temperature: this.defaults.temperature,
      timeoutMs: this.defaults.timeoutMs,
      maxRetries: this.defaults.maxRetries,
      dailyQuota: this.defaults.dailyQuota,
      enabled: this.defaults.enabled,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    };
    this.loaded = true;
    return this.cache;
  }

  /**
   * 对外视图（**不含明文 Key**）。
   */
  async getPublic(): Promise<AIConfig> {
    const current = await this.get();
    const persisted = await this.db.read<PersistedAIConfig>(STORE_PATH);
    const isRuntime = Boolean(persisted);

    return {
      hasApiKey: current.apiKey.length > 0,
      apiKeyMasked: maskApiKey(current.apiKey),
      model: current.model,
      temperature: current.temperature,
      timeoutMs: current.timeoutMs,
      maxRetries: current.maxRetries,
      dailyQuota: current.dailyQuota,
      enabled: current.enabled,
      source: isRuntime ? 'runtime' : 'env',
      updatedAt: isRuntime ? current.updatedAt : null,
      updatedBy: isRuntime ? current.updatedBy : null,
    };
  }

  /**
   * 更新配置并落盘。
   *
   * `apiKey` 传空串表示**保持原值** ——
   * 前端拿到的是掩码，回传掩码不能把真实 Key 覆盖掉。
   */
  async update(
    patch: UpdateAIConfigRequest,
    actor: string | null = null
  ): Promise<PersistedAIConfig> {
    const current = await this.get();

    const next: PersistedAIConfig = {
      apiKey:
        typeof patch.apiKey === 'string' && patch.apiKey.length > 0
          ? patch.apiKey.trim()
          : current.apiKey,
      model: patch.model?.trim() || current.model,
      temperature: patch.temperature ?? current.temperature,
      timeoutMs: patch.timeoutMs ?? current.timeoutMs,
      maxRetries: patch.maxRetries ?? current.maxRetries,
      dailyQuota: patch.dailyQuota ?? current.dailyQuota,
      enabled: patch.enabled ?? current.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };

    await this.db.write(STORE_PATH, next);
    // 写后立即失效缓存：保存即可生效，无需重启
    this.cache = next;
    this.loaded = true;

    logger.info('ai.config_updated', {
      actor,
      model: next.model,
      enabled: next.enabled,
      // 只记录是否改动 Key，不记录明文
      apiKeyChanged: next.apiKey !== current.apiKey,
    });

    return next;
  }

  /**
   * 清除运行时配置，回落到环境变量默认值。
   */
  async reset(): Promise<PersistedAIConfig> {
    await this.db.remove(STORE_PATH);
    this.cache = null;
    this.loaded = false;
    const fresh = await this.get();
    logger.info('ai.config_reset');
    return fresh;
  }

  /**
   * 清空进程内缓存（外部改文件后调用）。
   */
  invalidate(): void {
    this.cache = null;
    this.loaded = false;
  }
}
