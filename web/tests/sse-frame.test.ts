/**
 * SSE 帧解析测试。
 *
 * 前端用 fetch + ReadableStream 手动解析 SSE 帧
 * （因为 EventSource 不支持自定义 header，无法携带 Bearer token）。
 *
 * 这段解析逻辑的全部难点都在帧边界处理上：
 * - 注释行（心跳）必须跳过
 * - 多行 data 必须用 \n 连接
 * - 帧可能被网络切成任意片段
 * - 非法 JSON 不能让整个订阅崩掉
 *
 * 出错时的症状是「进度条不动」或「诊断结果丢失」——
 * 没有报错、没有日志，极难定位。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleFrame, type DiagnosisJobHandlers } from '../src/api/jobs.ts';

/** 收集所有回调 */
function recorder() {
  const events: string[] = [];
  const handlers: DiagnosisJobHandlers = {
    onProgress: (p) => events.push(`progress:${p.stage}:${p.pct}`),
    onDone: (j) => events.push(`done:${j?.id ?? 'none'}`),
    onError: (m) => events.push(`error:${m}`),
    onRetry: (m, at) => events.push(`retry:${m}:${at ?? 'none'}`),
    onCancelled: () => events.push('cancelled'),
  };
  return { events, handlers };
}

describe('SSE 帧解析', () => {
  test('解析 progress 事件', () => {
    const { events, handlers } = recorder();
    handleFrame(
      'event: progress\ndata: {"stage":"识别试卷结构","pct":40}',
      handlers
    );
    assert.deepEqual(events, ['progress:识别试卷结构:40']);
  });

  test('解析 done 事件并带出 job', () => {
    const { events, handlers } = recorder();
    handleFrame(
      'event: done\ndata: {"job":{"id":"job-1","status":"SUCCEEDED"}}',
      handlers
    );
    assert.deepEqual(events, ['done:job-1']);
  });

  test('解析 error 事件', () => {
    const { events, handlers } = recorder();
    handleFrame('event: error\ndata: {"message":"模型超时"}', handlers);
    assert.deepEqual(events, ['error:模型超时']);
  });

  test('解析 retry 事件（含 retryAt）', () => {
    const { events, handlers } = recorder();
    handleFrame(
      'event: retry\ndata: {"message":"AI 暂时不可用","retryAt":"2026-11-17T10:00:00Z"}',
      handlers
    );
    assert.deepEqual(events, ['retry:AI 暂时不可用:2026-11-17T10:00:00Z']);
  });

  test('解析 cancelled 事件', () => {
    const { events, handlers } = recorder();
    handleFrame('event: cancelled\ndata: {"job":{"id":"job-1"}}', handlers);
    assert.deepEqual(events, ['cancelled']);
  });
});

describe('SSE 帧边界处理', () => {
  test('跳过心跳注释行', () => {
    const { events, handlers } = recorder();
    handleFrame(': ping\n\nevent: progress\ndata: {"stage":"x","pct":1}', handlers);
    // 注释帧不应触发任何回调；progress 帧正常处理
    assert.deepEqual(events, ['progress:x:1']);
  });

  /**
   * 注释行（含 `event:` / `data:` 字样）不产生任何事件。
   *
   * 说明：解析器只认以 `event:` / `data:` **开头**的行，
   * 而注释行以 `:` 开头，因此天然不会命中 —— 这也是
   * `startsWith(':')` 那行检查在当前实现下不可达的原因。
   *
   * 这里锁住的是**可观察行为**（注释不伪造事件），
   * 而不是某个具体实现细节。
   */
  test('注释行中含 data: 时不产生事件', () => {
    const { events, handlers } = recorder();
    handleFrame(': data: {"stage":"伪造","pct":999}', handlers);
    assert.deepEqual(events, [], '注释行不应产生进度事件');
  });

  test('注释行中含 event: 时不改变事件类型', () => {
    const { events, handlers } = recorder();
    handleFrame(': event: done\ndata: {"job":{"id":"fake"}}', handlers);
    assert.deepEqual(events, [], '注释行不应改变事件类型');
  });

  test('纯注释帧不触发任何回调', () => {
    const { events, handlers } = recorder();
    handleFrame(': ping', handlers);
    assert.deepEqual(events, []);
  });

  test('没有 data 行的帧被忽略', () => {
    const { events, handlers } = recorder();
    handleFrame('event: progress', handlers);
    assert.deepEqual(events, []);
  });

  test('多行 data 用换行连接后再解析', () => {
    const { events, handlers } = recorder();
    handleFrame(
      'event: progress\ndata: {"stage":"多行",\ndata: "pct":50}',
      handlers
    );
    // 两段 data 拼成 {"stage":"多行",\n"pct":50} —— 合法 JSON
    assert.deepEqual(events, ['progress:多行:50']);
  });

  test('非法 JSON 不抛错（不让整个订阅崩掉）', () => {
    const { events, handlers } = recorder();
    assert.doesNotThrow(() => {
      handleFrame('event: progress\ndata: {not json}', handlers);
    });
    assert.deepEqual(events, []);
  });

  test('未知事件类型被忽略', () => {
    const { events, handlers } = recorder();
    handleFrame('event: unknown-thing\ndata: {"a":1}', handlers);
    assert.deepEqual(events, []);
  });

  test('缺少 event 行时按 message 处理（不触发已知回调）', () => {
    const { events, handlers } = recorder();
    handleFrame('data: {"stage":"x","pct":1}', handlers);
    assert.deepEqual(events, []);
  });

  test('data 行首尾空白被裁掉', () => {
    const { events, handlers } = recorder();
    handleFrame('event: progress\ndata:   {"stage":"带空格","pct":7}   ', handlers);
    assert.deepEqual(events, ['progress:带空格:7']);
  });
});

describe('SSE 字段缺失时的兜底', () => {
  test('progress 缺 stage 时用空串', () => {
    const { events, handlers } = recorder();
    handleFrame('event: progress\ndata: {"pct":30}', handlers);
    assert.deepEqual(events, ['progress::30']);
  });

  test('progress 缺 pct 时用 0', () => {
    const { events, handlers } = recorder();
    handleFrame('event: progress\ndata: {"stage":"s"}', handlers);
    assert.deepEqual(events, ['progress:s:0']);
  });

  test('error 缺 message 时用默认文案', () => {
    const { events, handlers } = recorder();
    handleFrame('event: error\ndata: {}', handlers);
    assert.deepEqual(events, ['error:任务失败']);
  });

  test('retry 缺 retryAt 时为 undefined', () => {
    const { events, handlers } = recorder();
    handleFrame('event: retry\ndata: {"message":"稍后重试"}', handlers);
    assert.deepEqual(events, ['retry:稍后重试:none']);
  });

  test('缺少回调时不抛错', () => {
    assert.doesNotThrow(() => {
      handleFrame('event: progress\ndata: {"stage":"x","pct":1}', {});
      handleFrame('event: done\ndata: {"job":{"id":"j"}}', {});
      handleFrame('event: error\ndata: {}', {});
      handleFrame('event: cancelled\ndata: {}', {});
      handleFrame('event: retry\ndata: {}', {});
    });
  });

  test('pct 为字符串时转成数字', () => {
    const { events, handlers } = recorder();
    handleFrame('event: progress\ndata: {"stage":"s","pct":"42"}', handlers);
    assert.deepEqual(events, ['progress:s:42']);
  });
});
