/**
 * SSE 进度推送集成测试。
 *
 * 用真实的 Job Engine + 真实 HTTP SSE 连接验证进度推送链路。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-sse-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = '';
  process.env.GEMINI_API_KEY = '';

  container = createContainer();

  // 注册一个测试用的任务类型，模拟耗时诊断
  container.jobEngine.register('test-diagnosis', {
    async execute(_input: unknown, ctx) {
      ctx.reportProgress('准备试卷材料', 10);
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.reportProgress('AI 识别试卷结构', 40);
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.reportProgress('生成诊断报告', 90);
      return { diagnosedItems: [], paperSummary: 'ok' };
    },
  });

  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  await container.jobEngine.start();
});

after(async () => {
  await container.jobEngine.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 读取 SSE 流并收集事件 */
async function readSse(
  url: string,
  options: { untilTerminal?: boolean; timeoutMs?: number } = {}
): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 5000
  );

  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
    '应返回 text/event-stream'
  );

  const events: Array<{ event: string; data: unknown }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;

        let data: unknown;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }
        events.push({ event, data });

        if (
          options.untilTerminal &&
          (event === 'done' || event === 'error' || event === 'cancelled')
        ) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

describe('SSE 进度推送', () => {
  test('任务执行过程中推送进度并以 done 结束', async () => {
    const jobId = await container.jobEngine.enqueue('test-diagnosis', {});

    const events = await readSse(`${baseUrl}/api/v1/jobs/${jobId}/events`, {
      untilTerminal: true,
      timeoutMs: 8000,
    });

    const progressEvents = events.filter((e) => e.event === 'progress');
    assert.ok(progressEvents.length >= 3, `应收到至少 3 个进度事件，实际 ${progressEvents.length}`);

    const stages = progressEvents.map(
      (e) => (e.data as { stage: string }).stage
    );
    assert.ok(stages.includes('准备试卷材料'));
    assert.ok(stages.includes('AI 识别试卷结构'));

    const pcts = progressEvents.map((e) => (e.data as { pct: number }).pct);
    assert.ok(
      pcts.every((p, i) => i === 0 || p >= pcts[i - 1]),
      '进度应单调递增'
    );

    const doneEvent = events.find((e) => e.event === 'done');
    assert.ok(doneEvent, '应收到 done 事件');
    const job = (doneEvent!.data as { job: { status: string } }).job;
    assert.equal(job.status, 'SUCCEEDED');
  });

  test('已完成的任务立即返回 done', async () => {
    const jobId = await container.jobEngine.enqueue('test-diagnosis', {});
    // 等待完成
    for (let i = 0; i < 100; i++) {
      const job = await container.jobEngine.getJob(jobId);
      if (job?.status === 'SUCCEEDED') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const events = await readSse(`${baseUrl}/api/v1/jobs/${jobId}/events`, {
      untilTerminal: true,
      timeoutMs: 3000,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
  });

  test('不存在的任务返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/job_nonexistent/events`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  test('GET /jobs 列出任务', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      jobs: Array<{ id: string; type: string; status: string }>;
    };
    assert.ok(body.jobs.length > 0);
    assert.ok(body.jobs.every((j) => typeof j.id === 'string'));
  });
});

describe('文件上传', () => {
  test('上传试卷图片返回 fileId', async () => {
    // 1x1 PNG
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const res = await fetch(`${baseUrl}/api/v1/uploads/papers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'stu-test',
        base64: pngBase64,
        mimeType: 'image/png',
        originalName: 'test.png',
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { fileId: string; size: number };
    assert.ok(body.fileId);
    assert.ok(body.size > 0);
  });

  test('空内容被拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/v1/uploads/papers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'stu-test', base64: '' }),
    });
    assert.equal(res.status, 400);
  });

  test('不支持的文件类型被拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/v1/uploads/papers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'stu-test',
        base64: 'AAAA',
        mimeType: 'application/x-msdownload',
      }),
    });
    assert.equal(res.status, 500);
  });
});
