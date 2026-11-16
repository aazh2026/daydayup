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

function write(level: Level, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ?? {}),
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
