/**
 * 异步诊断端到端测试。
 *
 * 用 Mock AI Provider 验证完整链路：
 * 上传图片 → 创建 Job → SSE 进度 → done 结果。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { createDiagnosisJobHandler } from '../src/modules/diagnosis/diagnosis-job.ts';
import type { AIProvider } from '../src/infrastructure/ai/provider.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;

/** Mock Provider：模拟多模态调用 */
const mockProvider: AIProvider = {
  async generateJson<T>(): Promise<{
    data: T | null;
    validated: boolean;
    attempts: number;
    error: string | null;
    promptVersion: string;
    model: string;
  }> {
    return {
      data: null,
      validated: false,
      attempts: 1,
      error: 'mock',
      promptVersion: 'diagnosis.v1',
      model: 'mock',
    };
  },
} as AIProvider;

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-async-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = '';
  process.env.GEMINI_API_KEY = '';

  container = createContainer();

  // 用 Mock Provider 替换真实 AI，模拟多模态调用
  const mockWithClient = {
    ...mockProvider,
    client: {
      models: {
        generateContent: async ({ contents }: { contents: { parts: unknown[] } }) => {
          const parts = contents?.parts ?? [];
          // 断言确实携带了图片
          const hasImage = parts.some(
            (p) => typeof p === 'object' && p !== null && 'inlineData' in p
          );
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            text: JSON.stringify({
              detectedMetadata: {
                subject: '数学',
                examTitle: '异步诊断测试',
                examType: '期中考试',
                examDate: '2026-11-17',
                score: 76,
                fullScore: 100,
                metadataConfidence: '确定',
              },
              paperSummary: hasImage
                ? '含图片的诊断摘要'
                : '纯文本诊断摘要',
              questionsDetectedCount: 1,
              totalLostScore: 4,
              diagnosedItems: [
                {
                  questionNumber: '1',
                  stem: '分式值为0求x',
                  studentAnswer: 'x=2',
                  correctAnswer: 'x=-2',
                  scoreLost: 4,
                  knowledgeId: 'math-alg-rational',
                  errorType: '知识问题',
                  aiAnalysis: '未检验分母不为零',
                  evidence: '第1题',
                  confidence: '确定',
                  verificationMethod: '复做同类题',
                },
              ],
            }),
          };
        },
      },
    },
  } as unknown as AIProvider;

  container.jobEngine.register(
    'diagnosis',
    createDiagnosisJobHandler(mockWithClient, container.storage)
  );

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

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('异步诊断完整链路', () => {
  test('上传 → 创建任务 → SSE 进度 → 完成', async () => {
    const studentId = 'stu-async-test';

    // ---- 1. 上传 ----
    const uploadRes = await fetch(`${baseUrl}/api/v1/uploads/papers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId,
        base64: PNG_BASE64,
        mimeType: 'image/png',
        originalName: 'paper.png',
      }),
    });
    assert.equal(uploadRes.status, 200);
    const { fileId } = (await uploadRes.json()) as { fileId: string };
    assert.ok(fileId);

    // ---- 2. 创建任务 ----
    const enqueueRes = await fetch(
      `${baseUrl}/api/v1/exams/exam-async-test/diagnosis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId,
          paperId: 'paper-async',
          inputFormat: 'image',
          fileIds: [fileId],
        }),
      }
    );
    assert.equal(enqueueRes.status, 202);
    const enqueued = (await enqueueRes.json()) as {
      mode: string;
      jobId: string;
      streamUrl: string;
    };
    assert.equal(enqueued.mode, 'async');
    assert.ok(enqueued.jobId);
    assert.equal(enqueued.streamUrl, `/api/v1/jobs/${enqueued.jobId}/events`);

    // ---- 3. SSE 订阅 ----
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}${enqueued.streamUrl}`, {
      signal: controller.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<{ event: string; data: any }> = [];

    while (events.length < 20) {
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
        events.push({ event, data: JSON.parse(dataLines.join('\n')) });
      }
    }
    controller.abort();

    // ---- 4. 断言 ----
    const progressEvents = events.filter((e) => e.event === 'progress');
    assert.ok(progressEvents.length >= 2, '应收到进度事件');

    const doneEvent = events.find((e) => e.event === 'done');
    assert.ok(doneEvent, '应收到 done 事件');

    const job = doneEvent!.data.job;
    assert.equal(job.status, 'SUCCEEDED');

    const output = job.output as {
      paperSummary: string;
      diagnosedItems: unknown[];
      meta: { promptVersion: string; curriculumVersion: string };
    };
    assert.equal(output.paperSummary, '含图片的诊断摘要', '图片应被正确传给模型');
    assert.equal(output.diagnosedItems.length, 1);
    assert.equal(output.meta.promptVersion, 'diagnosis.v1');
    assert.match(output.meta.curriculumVersion, /^shanghai-junior-/);
  });

  test('同一试卷重复提交返回同一任务（幂等）', async () => {
    const studentId = 'stu-async-test';

    const body = JSON.stringify({
      studentId,
      paperId: 'paper-idem',
      inputFormat: 'parsed_text',
      rawText: '相同内容',
    });

    const first = await fetch(
      `${baseUrl}/api/v1/exams/exam-idem/diagnosis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    );
    const second = await fetch(
      `${baseUrl}/api/v1/exams/exam-idem/diagnosis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }
    );

    const a = (await first.json()) as { jobId: string };
    const b = (await second.json()) as { jobId: string };
    assert.equal(a.jobId, b.jobId, '相同输入应返回同一任务 ID');
  });

  test('缺少输入内容返回 400', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/exams/exam-empty/diagnosis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'stu-async-test', inputFormat: 'image' }),
      }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'VALIDATION_FAILED');
  });

  test('轮询降级路径可获取结果', async () => {
    const studentId = 'stu-async-test';

    const enqueueRes = await fetch(
      `${baseUrl}/api/v1/exams/exam-poll/diagnosis`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId,
          paperId: 'paper-poll',
          inputFormat: 'parsed_text',
          rawText: '轮询测试内容',
        }),
      }
    );
    const { jobId } = (await enqueueRes.json()) as { jobId: string };

    // 轮询直到完成
    let result: any = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${baseUrl}/api/v1/exams/exam-poll/diagnosis/${jobId}`);
      const body = (await res.json()) as { mode: string; data?: unknown };
      if (body.mode === 'sync') {
        result = body.data;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(result, '轮询应最终拿到结果');
    assert.equal(
      (result as { paperSummary: string }).paperSummary,
      '纯文本诊断摘要'
    );
  });
});
