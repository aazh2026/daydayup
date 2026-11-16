/**
 * 依赖注入容器。
 *
 * 显式组装，不引入 DI 框架（保持零外部基础设施约束）。
 */
import { GeminiProvider } from '../infrastructure/ai/gemini-provider.ts';
import type { AIProvider } from '../infrastructure/ai/provider.ts';
import { FileDatabase } from '../infrastructure/persistence/file-database.ts';
import { loadConfig, type AppConfig } from './config.ts';

export interface Container {
  config: AppConfig;
  db: FileDatabase;
  ai: AIProvider | null;
}

export function createContainer(): Container {
  const config = loadConfig();

  const db = new FileDatabase(config.dataDir);

  // 无 API Key 时不创建 Provider——由路由层返回明确错误，
  // 而不是让整个进程启动失败（现状 server.ts 的问题）。
  const ai = config.geminiApiKey ? new GeminiProvider(config.geminiApiKey) : null;

  return { config, db, ai };
}
