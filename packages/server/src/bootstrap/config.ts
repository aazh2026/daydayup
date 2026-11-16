/**
 * 服务端配置。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  host: string;
  geminiApiKey: string;
  dataDir: string;
  logLevel: string;
  corsOrigins: string[];
  /** AI 每日配额（按 studentId 计），0 = 不限制 */
  dailyTokenQuota: number;
}

export function loadConfig(): AppConfig {
  // 本文件位于 src/bootstrap/，故需上溯 3 层到 packages/server
  const defaultDataDir = path.resolve(__dirname, '../../data');

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : defaultDataDir;

  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    dataDir,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dailyTokenQuota: Number(process.env.DAILY_TOKEN_QUOTA ?? 0),
  };
}
