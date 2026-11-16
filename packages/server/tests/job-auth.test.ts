/**
 * 任务端点鉴权回归测试。
 *
 * 背景：任务输出包含学生的诊断结论与作答内容，
 * 不能仅凭 jobId 就被他人读取。
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
let studentToken: string;
let otherStudentToken: string;

const STUDENT_ID = 'stu-sh-zhangwei';
const OTHER_STUDENT_ID = 'stu-other';

async function login(secret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token, `登录应返回 token: ${secret}`);
  return body.token;
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-jobauth-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'job-auth-test-secret';
  process.env.GEMINI_API_KEY = '';

  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'student-a',
        secret: 'key-a',
        role: 'student',
        studentIds: [STUDENT_ID],
      },
      {
        principalId: 'student-b',
        secret: 'key-b',
        role: 'student',
        studentIds: [OTHER_STUDENT_ID],
      },
      {
        principalId: 'teacher-a',
        secret: 'key-t',
        role: 'teacher',
        studentIds: [],
      },
    ])
  );

  container = createContainer();
  container.jobEngine.register('noop', {
    async execute() {
      return { sensitive: '学生的诊断结论内容' };
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

  studentToken = await login('key-a');
  otherStudentToken = await login('key-b');
});

after(async () => {
  await container.jobEngine.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 创建属于 student-a 的任务 */
async function createJobForStudentA(): Promise<string> {
  const jobId = await container.jobEngine.enqueue('noop', {
    studentId: STUDENT_ID,
    paperId: 'paper-1',
  });
  // 等执行完成
  for (let i = 0; i < 100; i++) {
    const job = await container.jobEngine.getJob(jobId);
    if (job?.status === 'SUCCEEDED') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return jobId;
}

describe('任务端点鉴权', () => {
  test('无令牌访问任务返回 401', async () => {
    const jobId = await createJobForStudentA();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`);
    assert.equal(res.status, 401);
  });

  test('他人令牌访问任务返回 403（不泄露任务内容）', async () => {
    const jobId = await createJobForStudentA();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${otherStudentToken}` },
    });
    assert.equal(res.status, 403);

    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'FORBIDDEN');

    // 响应体不得包含任务输出
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('学生的诊断结论内容'), '越权响应不得包含任务输出');
  });

  test('本人可访问自己的任务', async () => {
    const jobId = await createJobForStudentA();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(res.status, 200);

    const job = (await res.json()) as { output?: { sensitive?: string } };
    assert.equal(job.output?.sensitive, '学生的诊断结论内容');
  });

  test('老师可访问任意任务', async () => {
    const jobId = await createJobForStudentA();
    const teacherToken = await login('key-t');
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(res.status, 200);
  });

  test('任务列表只返回调用者可访问的任务', async () => {
    await createJobForStudentA();

    const mineRes = await fetch(`${baseUrl}/api/v1/jobs`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const mine = (await mineRes.json()) as { jobs: unknown[] };
    assert.ok(mine.jobs.length > 0, '本人应看到自己的任务');

    const otherRes = await fetch(`${baseUrl}/api/v1/jobs`, {
      headers: { Authorization: `Bearer ${otherStudentToken}` },
    });
    const other = (await otherRes.json()) as { jobs: unknown[] };
    assert.equal(other.jobs.length, 0, '他人不应看到别人的任务');
  });

  test('SSE 端点同样要求认证', async () => {
    const jobId = await createJobForStudentA();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/events`);
    assert.equal(res.status, 401);
  });

  test('越权取消任务返回 403', async () => {
    const jobId = await createJobForStudentA();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${otherStudentToken}` },
    });
    assert.equal(res.status, 403);
  });
});
