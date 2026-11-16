/**
 * 依赖注入容器。
 *
 * 显式组装，不引入 DI 框架（保持零外部基础设施约束）。
 */
import { GeminiProvider } from '../infrastructure/ai/gemini-provider.ts';
import type { AIProvider } from '../infrastructure/ai/provider.ts';
import { FileDatabase } from '../infrastructure/persistence/file-database.ts';
import { TokenService } from '../infrastructure/security/token.ts';
import {
  resolveCredentialStore,
  type CredentialStore,
} from '../infrastructure/security/credentials.ts';
import { QuotaService } from '../infrastructure/security/quota.ts';
import { loadConfig, type AppConfig } from './config.ts';

export interface Container {
  config: AppConfig;
  db: FileDatabase;
  ai: AIProvider | null;
  tokenService: TokenService;
  credentialStore: CredentialStore;
  quota: QuotaService;
}

export function createContainer(): Container {
  const config = loadConfig();

  const db = new FileDatabase(config.dataDir);

  // 无 API Key 时不创建 Provider——由路由层返回明确错误，
  // 而不是让整个进程启动失败（现状 server.ts 的问题）。
  const ai = config.geminiApiKey ? new GeminiProvider(config.geminiApiKey) : null;

  // 开发模式使用固定密钥（仅当未配置 AUTH_SECRET 时生效）
  const tokenSecret = config.authSecret || 'dev-insecure-secret-do-not-use-in-prod';
  const tokenService = new TokenService(tokenSecret);

  const credentialStore = resolveCredentialStore(config.dataDir, config.authSecret);
  const quota = new QuotaService(db, config.dailyTokenQuota);

  return { config, db, ai, tokenService, credentialStore, quota };
}
