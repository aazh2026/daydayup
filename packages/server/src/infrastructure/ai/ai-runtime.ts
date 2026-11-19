/**
 * AI 运行时解析器。
 *
 * 解决的核心问题：**AI 能力此前是「启动时一次性判定」的**。
 * - `container.ts:49` → `config.geminiApiKey ? new GeminiProvider(...) : null`
 * - 没有 Key 就 `container.ai = null`，所有 AI 端点直接 500。
 *
 * 于是「配置一个 API Key」这件事必须改 `.env` + 重启进程，
 * 而重启在容器化部署里意味着停服。
 *
 * 现在：
 * - Provider **按需创建**，Key 可以在运行时配置；
 * - 已创建的 Provider 通过 `applyOptions` **热更新**模型/温度/超时/重试；
 * - Key 本身变更时重建 Provider（客户端持有 Key）。
 *
 * 两条「来源」互斥且有明确优先级：
 * 1. **注入（override）**：外部显式塞进来的 Provider（测试替身 / 嵌入实现）。
 *    它代表「调用方明确要用的实现」，因此**压过**配置中心的开关。
 * 2. **配置中心**：环境变量默认值 + 运行时持久化覆盖。
 *    `enabled=false` 或没有 Key 时 → 不可用。
 */
import { GeminiProvider } from './gemini-provider.ts';
import { isMutableAIProvider, type AIProvider } from './provider.ts';
import type { AIConfigStore, PersistedAIConfig } from './config-store.ts';
import { logger } from '../logging/logger.ts';

export class AIRuntime {
  private readonly store: AIConfigStore;
  private provider: AIProvider | null = null;
  /** 当前 Provider 使用的 API Key（判断是否需要重建） */
  private providerKey = '';
  /**
   * 手动注入的 Provider（测试 / 嵌入场景）。
   *
   * 一旦注入，就**优先于配置中心**返回 ——
   * 否则测试里注入的 mock 会被「没有 API Key」覆盖掉。
   */
  private override: AIProvider | null = null;
  /** 最近一次解析到的配置（同步读取 `peek()` 时用） */
  private lastConfig: PersistedAIConfig | null = null;

  constructor(store: AIConfigStore, initialProvider: AIProvider | null = null) {
    this.store = store;
    this.provider = initialProvider;
  }

  /**
   * 注入固定 Provider（测试替身）。
   */
  setOverride(provider: AIProvider | null): void {
    this.override = provider;
  }

  /**
   * 解析当前可用的 Provider。
   *
   * @returns Provider；AI 被禁用或没有 Key 时返回 null
   */
  async resolve(): Promise<AIProvider | null> {
    // 手动注入优先（测试替身 / 外部注入的实现）
    if (this.override) return this.override;

    const config = await this.store.get();
    this.lastConfig = config;

    if (!config.enabled) return null;
    if (!config.apiKey) return null;

    // Key 变了 → 重建 Provider（客户端持有 Key）
    if (!this.provider || this.providerKey !== config.apiKey) {
      this.provider = new GeminiProvider(config.apiKey, {
        model: config.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
      this.providerKey = config.apiKey;
      logger.info('ai.provider_created', { model: config.model });
      return this.provider;
    }

    // Key 没变 → 热更新参数
    if (isMutableAIProvider(this.provider)) {
      this.provider.applyOptions({
        model: config.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
    }

    return this.provider;
  }

  /**
   * 当前 Provider（不触发创建）。
   *
   * 给「已启动的诊断任务」用：任务开始时已持有 Provider 引用，
   * 中途配置变更不应让任务崩掉。
   *
   * 注意：AI 被显式停用时返回 null —— 停用必须真的停用，
   * 不能因为「曾经有 Provider」而继续放行。
   */
  peek(): AIProvider | null {
    if (this.override) return this.override;
    if (this.lastConfig && !this.lastConfig.enabled) return null;
    return this.provider;
  }

  /**
   * 配置保存后立即刷新（不必等下一次请求）。
   */
  async refresh(): Promise<void> {
    await this.resolve();
  }
}
