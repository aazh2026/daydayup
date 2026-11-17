/**
 * 结构化日志测试。
 *
 * 日志是「这个学生上周为什么这样诊断」这类问题的唯一答案来源，
 * 也是生产环境的告警依据（按 level 过滤、按事件名聚合）。
 *
 * 关键不变量：
 * - `ts` / `level` / `message` 三个字段**永远可信**，
 *   不能被调用方传入的上下文覆盖
 * - 级别过滤正确（debug 不应出现在 info 级别下）
 * - 输出是合法 JSON（可直接被日志采集器解析）
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

type Level = 'debug' | 'info' | 'warn' | 'error';

interface Captured {
  stream: 'stdout' | 'stderr';
  entry: Record<string, unknown>;
}

let captured: Captured[] = [];
let restoreFns: Array<() => void> = [];

/**
 * 捕获日志输出。
 *
 * 注意：`logger` 在模块加载时就读了 LOG_LEVEL 并固定下来，
 * 所以测试用不同 LOG_LEVEL 时必须**重新导入模块**。
 */
async function loadLogger(logLevel?: string) {
  const saved = process.env.LOG_LEVEL;
  if (logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = logLevel;

  const mod = await import(
    `../src/infrastructure/logging/logger.ts?lvl=${logLevel ?? 'default'}-${Date.now()}`
  );

  // 还原环境变量（模块已加载，常量已固化）
  if (saved === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = saved;

  return mod.logger;
}

beforeEach(() => {
  captured = [];
  restoreFns = [];

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  const capture = (stream: 'stdout' | 'stderr') => (line: string) => {
    try {
      captured.push({ stream, entry: JSON.parse(line) });
    } catch {
      captured.push({ stream, entry: { __unparsable: line } });
    }
  };

  console.log = ((line: string) => {
    capture('stdout')(line);
  }) as typeof console.log;
  console.warn = ((line: string) => {
    capture('stderr')(line);
  }) as typeof console.warn;
  console.error = ((line: string) => {
    capture('stderr')(line);
  }) as typeof console.error;

  restoreFns.push(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });
});

afterEach(() => {
  for (const fn of restoreFns) fn();
  restoreFns = [];
});

describe('日志输出结构', () => {
  test('输出是合法 JSON 且含核心字段', async () => {
    const logger = await loadLogger();
    logger.info('some.event', { requestId: 'req_1' });

    assert.equal(captured.length, 1);
    const entry = captured[0].entry;
    assert.equal(entry.message, 'some.event');
    assert.equal(entry.level, 'info');
    assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0);
    assert.equal(entry.requestId, 'req_1');
  });

  test('上下文原样带出', async () => {
    const logger = await loadLogger();
    logger.info('evt', { studentId: 'stu-1', count: 3, ok: true });

    const entry = captured[0].entry;
    assert.equal(entry.studentId, 'stu-1');
    assert.equal(entry.count, 3);
    assert.equal(entry.ok, true);
  });

  test('无上下文时也能输出', async () => {
    const logger = await loadLogger();
    logger.info('evt');
    assert.equal(captured[0].entry.message, 'evt');
  });
});

describe('级别路由', () => {
  test('error 走 stderr', async () => {
    const logger = await loadLogger();
    logger.error('boom');
    assert.equal(captured[0].stream, 'stderr');
    assert.equal(captured[0].entry.level, 'error');
  });

  test('warn 走 stderr', async () => {
    const logger = await loadLogger();
    logger.warn('careful');
    assert.equal(captured[0].stream, 'stderr');
    assert.equal(captured[0].entry.level, 'warn');
  });

  test('info 走 stdout', async () => {
    const logger = await loadLogger();
    logger.info('hello');
    assert.equal(captured[0].stream, 'stdout');
  });

  test('debug 在 info 级别下被过滤', async () => {
    const logger = await loadLogger('info');
    logger.debug('noisy');
    assert.equal(captured.length, 0, 'debug 应被过滤');
  });

  test('debug 在 debug 级别下输出', async () => {
    const logger = await loadLogger('debug');
    logger.debug('noisy');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entry.level, 'debug');
  });

  test('warn/error 不会被 info 级别过滤', async () => {
    const logger = await loadLogger('info');
    logger.warn('w');
    logger.error('e');
    assert.equal(captured.length, 2);
  });

  test('非法 LOG_LEVEL 回落为 info', async () => {
    const logger = await loadLogger('bogus');
    logger.debug('filtered');
    logger.info('kept');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entry.message, 'kept');
  });
});

describe('保留字段不被覆盖（回归）', () => {
  /**
   * 回归：上下文里的 `message` / `level` / `ts` 曾会覆盖日志自身字段。
   *
   * 实际后果：`logger.error('api.unhandled', { message })` 会让事件名
   * `api.unhandled` 消失，日志里只剩错误正文 ——
   * 按事件名聚合日志彻底失效；`level` 被改则影响 stderr/stdout 路由与告警。
   */
  test('上下文的 message 不会覆盖事件名', async () => {
    const logger = await loadLogger();
    logger.error('api.unhandled', { message: '原始错误文本' });

    const entry = captured[0].entry;
    assert.equal(entry.message, 'api.unhandled', '事件名必须保留');
    assert.equal(
      entry.context_message,
      '原始错误文本',
      '被覆盖的字段应改名保留，信息不丢'
    );
  });

  test('上下文的 level 不会覆盖日志级别', async () => {
    const logger = await loadLogger();
    logger.info('evt', { level: 'error' });

    const entry = captured[0].entry;
    assert.equal(entry.level, 'info', '日志级别必须保留');
    assert.equal(entry.context_level, 'error');
    assert.equal(captured[0].stream, 'stdout', '路由仍按真实级别');
  });

  test('上下文的 ts 不会覆盖时间戳', async () => {
    const logger = await loadLogger();
    logger.info('evt', { ts: 'fake-timestamp' });

    const entry = captured[0].entry;
    assert.notEqual(entry.ts, 'fake-timestamp', '时间戳必须由日志生成');
    assert.equal(entry.context_ts, 'fake-timestamp');
  });

  test('上下文含保留字段时仍输出合法 JSON', async () => {
    const logger = await loadLogger();
    logger.info('evt', { message: 'x', level: 'warn', ts: 'y' });
    assert.equal(captured.length, 1);
    assert.ok(captured[0].entry.ts);
  });
});
