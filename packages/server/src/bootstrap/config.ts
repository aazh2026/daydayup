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
  /** AI 每日配额（按调用次数），0 = 不限制 */
  dailyTokenQuota: number;
  /**
   * Token 签名密钥。
   *
   * 为空时进入「开发模式」：启用内存演示凭证（demo PIN 1234）。
   * 生产环境必须配置，否则任何人都能用默认凭证登录。
   */
  authSecret: string;
  /** 是否强制要求认证（生产默认 true） */
  authRequired: boolean;
  /**
   * 前端静态资源目录。
   *
   * 为空则不托管前端（前后端完全独立部署）。
   * 设置后由后端一并托管（单容器部署）。
   */
  staticDir: string;
  /** 数据保留策略（天） */
  retention: {
    eventLogDays: number;
    attemptDays: number;
    completedJobDays: number;
    uploadDays: number;
    auditLogDays: number;
  };
}

export function loadConfig(): AppConfig {
  // 本文件位于 src/bootstrap/，故需上溯 3 层到 packages/server
  const defaultDataDir = path.resolve(__dirname, '../../data');

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : defaultDataDir;

  const authSecret = process.env.AUTH_SECRET ?? '';

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
    authSecret,
    // 未配置 AUTH_SECRET 时默认不强制（便于本地开发）
    authRequired:
      process.env.AUTH_REQUIRED !== undefined
        ? process.env.AUTH_REQUIRED === 'true'
        : authSecret.length > 0,
    staticDir: process.env.STATIC_DIR
      ? path.resolve(process.env.STATIC_DIR)
      : '',
    retention: {
      eventLogDays: Number(process.env.RETENTION_EVENT_LOG_DAYS ?? 180),
      attemptDays: Number(process.env.RETENTION_ATTEMPT_DAYS ?? 365),
      completedJobDays: Number(process.env.RETENTION_JOB_DAYS ?? 30),
      uploadDays: Number(process.env.RETENTION_UPLOAD_DAYS ?? 180),
      auditLogDays: Number(process.env.RETENTION_AUDIT_DAYS ?? 730),
    },
  };
}
