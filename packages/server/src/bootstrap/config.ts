/**
 * 服务端配置。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../infrastructure/logging/logger.ts';

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

/**
 * 解析数字型环境变量。
 *
 * 为什么需要它：`Number('abc')` 得到 `NaN`，而 NaN 会静默破坏语义 ——
 * - `PORT=abc` → `listen(NaN)` 行为不可预期
 * - `DAILY_TOKEN_QUOTA=abc` → `NaN <= 0` 为 false，配额检查形同虚设
 *   （`used >= NaN` 恒为 false，成本护栏直接消失）
 *
 * 非法值一律回落到默认值，并记警告 —— 配置写错应该被看见，
 * 而不是变成一个「看起来生效、实际不生效」的护栏。
 */
function readNumber(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    logger.warn('config.invalid_number', { name, raw, fallback });
    return fallback;
  }
  return value;
}

/** 解析布尔型环境变量（接受 true/TRUE/1/yes 等真值） */
function readBoolean(
  raw: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  logger.warn('config.invalid_boolean', { name, raw, fallback });
  return fallback;
}

export function loadConfig(): AppConfig {
  // 本文件位于 src/bootstrap/，故需上溯 3 层到 packages/server
  const defaultDataDir = path.resolve(__dirname, '../../data');

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : defaultDataDir;

  const authSecret = process.env.AUTH_SECRET ?? '';

  /**
   * 是否强制认证。
   *
   * 关键安全约束：**强制认证必须有签名密钥**。
   *
   * 否则 `AUTH_REQUIRED=true` 但 `AUTH_SECRET` 为空时，
   * TokenService 会回落到源码里写死的开发密钥
   * （见 container.ts），任何人都能伪造合法令牌 ——
   * 「要求登录」却用公开密钥签发，等于没有认证。
   *
   * 因此：无密钥时一律不强制（开发模式），
   * 并明确告警，而不是静默进入「强制认证 + 公开密钥」的危险状态。
   */
  const authRequired = readBoolean(
    process.env.AUTH_REQUIRED,
    authSecret.length > 0,
    'AUTH_REQUIRED'
  );

  if (authRequired && authSecret.length === 0) {
    logger.error('config.auth_required_without_secret', {
      message:
        'AUTH_REQUIRED=true 但 AUTH_SECRET 为空 —— 将回退为开发模式（不强制认证）',
    });
  }

  const effectiveAuthRequired =
    authRequired && authSecret.length > 0 ? true : false;

  return {
    port: readNumber(process.env.PORT, 3000, 'PORT'),
    host: process.env.HOST ?? '0.0.0.0',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    dataDir,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dailyTokenQuota: readNumber(
      process.env.DAILY_TOKEN_QUOTA,
      0,
      'DAILY_TOKEN_QUOTA'
    ),
    authSecret,
    authRequired: effectiveAuthRequired,
    staticDir: process.env.STATIC_DIR
      ? path.resolve(process.env.STATIC_DIR)
      : '',
    retention: {
      eventLogDays: readNumber(
        process.env.RETENTION_EVENT_LOG_DAYS,
        180,
        'RETENTION_EVENT_LOG_DAYS'
      ),
      attemptDays: readNumber(
        process.env.RETENTION_ATTEMPT_DAYS,
        365,
        'RETENTION_ATTEMPT_DAYS'
      ),
      completedJobDays: readNumber(
        process.env.RETENTION_JOB_DAYS,
        30,
        'RETENTION_JOB_DAYS'
      ),
      uploadDays: readNumber(
        process.env.RETENTION_UPLOAD_DAYS,
        180,
        'RETENTION_UPLOAD_DAYS'
      ),
      auditLogDays: readNumber(
        process.env.RETENTION_AUDIT_DAYS,
        730,
        'RETENTION_AUDIT_DAYS'
      ),
    },
  };
}
