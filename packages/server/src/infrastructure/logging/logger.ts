/**
 * 结构化日志。
 *
 * 现状 server.ts 使用裸 console.error，无法按 requestId 追踪，
 * 分离后需要能回答「这个学生上周为什么这样诊断」。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: Level =
  (process.env.LOG_LEVEL as Level) && process.env.LOG_LEVEL in LEVEL_ORDER
    ? (process.env.LOG_LEVEL as Level)
    : 'info';

export interface LogContext {
  requestId?: string;
  studentId?: string;
  [key: string]: unknown;
}

/** 日志自身的保留字段 —— 不允许被上下文覆盖 */
const RESERVED_FIELDS = ['ts', 'level', 'message'] as const;

function write(level: Level, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  /**
   * 上下文字段先铺开，日志自身字段后铺开。
   *
   * 顺序很重要：若上下文先展开，调用方传入的 `message` / `level` / `ts`
   * 就会**覆盖**日志自身的字段 ——
   * 比如 `logger.error('api.unhandled', { message })` 会让事件名
   * `api.unhandled` 消失，日志里只剩错误正文，
   * 按事件名聚合日志就失效了。
   *
   * 反过来（自身字段后展开）则保证 `ts`/`level`/`message` 永远可信，
   * 上下文里的同名字段会被改名保留为 `context_message` 之类，不丢信息。
   */
  const safeContext: Record<string, unknown> = { ...(context ?? {}) };
  for (const field of RESERVED_FIELDS) {
    if (field in safeContext) {
      safeContext[`context_${field}`] = safeContext[field];
      delete safeContext[field];
    }
  }

  const entry = {
    ...safeContext,
    ts: new Date().toISOString(),
    level,
    message,
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => write('debug', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
};
