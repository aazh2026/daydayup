/**
 * 依赖注入容器。
 *
 * 显式组装，不引入 DI 框架（保持零外部基础设施约束）。
 */
import path from 'node:path';
import { GeminiProvider } from '../infrastructure/ai/gemini-provider.ts';
import type { AIProvider } from '../infrastructure/ai/provider.ts';
import { AIConfigStore, type AIConfigDefaults } from '../infrastructure/ai/config-store.ts';
import { AIRuntime } from '../infrastructure/ai/ai-runtime.ts';
import { FileDatabase } from '../infrastructure/persistence/file-database.ts';
import { FileStorage } from '../infrastructure/storage/file-storage.ts';
import { TokenService } from '../infrastructure/security/token.ts';
import {
  resolveCredentialStore,
  type CredentialStore,
} from '../infrastructure/security/credentials.ts';
import { QuotaService } from '../infrastructure/security/quota.ts';
import { JobEngine } from '../infrastructure/jobs/job-engine.ts';
import { RetentionService } from '../infrastructure/retention/retention-service.ts';
import { BackupService } from '../infrastructure/backup/backup-service.ts';
import { AuditService } from '../infrastructure/audit/audit-service.ts';
import { Scheduler } from '../infrastructure/scheduler/scheduler.ts';
import { createDiagnosisJobHandler } from '../modules/diagnosis/diagnosis-job.ts';
import { loadConfig, type AppConfig } from './config.ts';

export interface Container {
  config: AppConfig;
  db: FileDatabase;
  storage: FileStorage;
  /**
   * 当前 AI Provider。
   *
   * - **读**：返回运行时解析出的当前 Provider（AI 被停用时为 null）。
   * - **写**：等价于「注入一个固定实现」（测试替身 / 嵌入场景），
   *   注入的实现会压过配置中心。
   *
   * 保留这个字段是为了兼容既有调用方（`app.ts` 的 `aiEnabled` 探针、
   * 测试里 `container.ai = mockAI` 的注入方式）。
   */
  ai: AIProvider | null;
  /** AI 配置中心（运行时可改，持久化在服务端） */
  aiConfig: AIConfigStore;
  /** AI 运行时解析器（按当前配置创建/热更新 Provider） */
  aiRuntime: AIRuntime;
  tokenService: TokenService;
  credentialStore: CredentialStore;
  quota: QuotaService;
  jobEngine: JobEngine;
  retention: RetentionService;
  backup: BackupService;
  audit: AuditService;
  scheduler: Scheduler;
}

/**
 * 从 AppConfig 提取 AI 配置的默认值。
 *
 * 环境变量是**默认值**，后台改过后由运行时配置覆盖。
 */
export function aiConfigDefaultsFrom(config: AppConfig): AIConfigDefaults {
  return {
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    temperature: config.geminiTemperature,
    timeoutMs: config.geminiTimeoutMs,
    maxRetries: config.geminiMaxRetries,
    dailyQuota: config.dailyTokenQuota,
    enabled: true,
  };
}

export function createContainer(): Container {
  const config = loadConfig();

  const db = new FileDatabase(config.dataDir);
  // FileStorage 需要 db 做元数据索引（鉴权不依赖文件名猜测）
  const storage = new FileStorage({ dataDir: config.dataDir, db });

  // AI 配置中心：环境变量是默认值，运行时可改并落盘
  const aiConfig = new AIConfigStore(db, aiConfigDefaultsFrom(config));

  /**
   * 无 API Key 时不创建 Provider——由路由层返回明确错误，
   * 而不是让整个进程启动失败（现状 server.ts 的问题）。
   *
   * 但注意：**Key 可能在运行时被配置**（后台保存后立刻可用），
   * 所以 Provider 的创建必须延迟到「每次请求时按当前配置判断」，
   * 而不是在启动时一次判定。见 `resolveAIProvider`。
   */
  const ai = createProviderFromConfig(config);
  const aiRuntime = new AIRuntime(aiConfig, ai);

  // 开发模式使用固定密钥（仅当未配置 AUTH_SECRET 时生效）
  const tokenSecret = config.authSecret || 'dev-insecure-secret-do-not-use-in-prod';
  const tokenService = new TokenService(tokenSecret);

  const credentialStore = resolveCredentialStore(config.dataDir, config.authSecret);
  const quota = new QuotaService(db, config.dailyTokenQuota);

  // ---- Job Engine ----
  const jobEngine = new JobEngine(db, {
    concurrency: Number(process.env.JOB_CONCURRENCY ?? 2),
    jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS ?? 10 * 60 * 1000),
  });

  /**
   * 诊断任务处理器**总是注册**。
   *
   * 此前只在启动时已有 Key 才注册（`if (ai)`），
   * 于是「运行时才配上 Key」的场景下异步诊断任务**永远无法提交** ——
   * Job Engine 里根本没有 `diagnosis` 这个处理器。
   *
   * 现在处理器内部在执行时按当前配置解析 Provider，
   * 启动时没有 Key 也能在配上 Key 后正常跑诊断。
   */
  jobEngine.register(
    'diagnosis',
    createDiagnosisJobHandler(aiRuntime, storage)
  );

  const retention = new RetentionService(db, storage);
  const backup = new BackupService(config.dataDir, path.join(config.dataDir, '..', 'backups'));
  const audit = new AuditService(db);

  // ---- 定时任务：每日备份 + 每日清理 ----
  const scheduler = new Scheduler(
    [
      {
        name: 'daily-backup',
        intervalMs: 6 * 60 * 60 * 1000, // 每 6 小时检查一次
        daily: true,
        run: async () => {
          const { manifest } = await backup.create('daily');
          await audit.record('BackupCreated', {
            payload: { fileCount: manifest.fileCount, size: manifest.totalBytes },
          });
        },
      },
      {
        name: 'daily-cleanup',
        intervalMs: 6 * 60 * 60 * 1000,
        daily: true,
        run: async () => {
          const result = await retention.cleanup();
          await audit.record('DataCleanupRun', {
            payload: { ...result.deleted },
          });
        },
      },
    ],
    path.join(config.dataDir, 'db', 'markers')
  );

  const container: Container = {
    config,
    db,
    storage,
    /**
     * `ai` 是「运行时 Provider」的读写代理：
     * - 读 → 当前可用 Provider（停用时为 null）
     * - 写 → 注入固定实现（测试替身 / 嵌入场景），压过配置中心
     */
    get ai() {
      return aiRuntime.peek();
    },
    set ai(provider: AIProvider | null) {
      aiRuntime.setOverride(provider);
    },
    aiConfig,
    aiRuntime,
    tokenService,
    credentialStore,
    quota,
    jobEngine,
    retention,
    backup,
    audit,
    scheduler,
  };

  return container;
}

/**
 * 按启动期配置创建 Provider（仅在启动时已有 Key 时才创建）。
 */
function createProviderFromConfig(config: AppConfig): AIProvider | null {
  if (!config.geminiApiKey) return null;
  return new GeminiProvider(config.geminiApiKey, {
    model: config.geminiModel,
    temperature: config.geminiTemperature,
    timeoutMs: config.geminiTimeoutMs,
    maxRetries: config.geminiMaxRetries,
  });
}
