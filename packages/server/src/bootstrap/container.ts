/**
 * 依赖注入容器。
 *
 * 显式组装，不引入 DI 框架（保持零外部基础设施约束）。
 */
import path from 'node:path';
import { GeminiProvider } from '../infrastructure/ai/gemini-provider.ts';
import type { AIProvider } from '../infrastructure/ai/provider.ts';
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
import { createDiagnosisJobHandler } from '../modules/diagnosis/diagnosis-job.ts';
import { loadConfig, type AppConfig } from './config.ts';

export interface Container {
  config: AppConfig;
  db: FileDatabase;
  storage: FileStorage;
  ai: AIProvider | null;
  tokenService: TokenService;
  credentialStore: CredentialStore;
  quota: QuotaService;
  jobEngine: JobEngine;
  retention: RetentionService;
  backup: BackupService;
}

export function createContainer(): Container {
  const config = loadConfig();

  const db = new FileDatabase(config.dataDir);
  const storage = new FileStorage({ dataDir: config.dataDir });

  // 无 API Key 时不创建 Provider——由路由层返回明确错误，
  // 而不是让整个进程启动失败（现状 server.ts 的问题）。
  const ai = config.geminiApiKey ? new GeminiProvider(config.geminiApiKey) : null;

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

  if (ai) {
    jobEngine.register('diagnosis', createDiagnosisJobHandler(ai, storage));
  }

  const retention = new RetentionService(db, storage);
  const backup = new BackupService(config.dataDir, path.join(config.dataDir, '..', 'backups'));

  return {
    config,
    db,
    storage,
    ai,
    tokenService,
    credentialStore,
    quota,
    jobEngine,
    retention,
    backup,
  };
}
