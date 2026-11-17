/**
 * 资源归属校验测试（跨学生越权）。
 *
 * ## 为什么重要
 *
 * 有些接口的 `studentId` 来自**请求体**（调用方自述），
 * 而写入目标是**另一个实体**（如某张试卷）。
 * 若只校验请求体的 studentId，就会出现：
 *
 * 学生 A 填 `studentId: 'stu-A'`（自己的），
 * 却把请求打到学生 B 的试卷上 → 改掉 B 的卷面元信息。
 *
 * `assertStudentWriteAccess(req, studentId)` 只回答
 * 「调用方能否写 studentId」，与「这张卷属于谁」是两个问题，
 * 必须分别校验。
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
let tokenA: string;
let tokenB: string;

const STUDENT_A = 'stu-owner-a';
const STUDENT_B = 'stu-owner-b';
const PAPER_B = 'paper-b';

async function login(secret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token);
  return body.token;
}

function readPaperB(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDataDir, 'db', 'papers', `${PAPER_B}.json`), 'utf8')
  );
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-ownership-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'ownership-test-secret';
  process.env.GEMINI_API_KEY = '';

  fs.mkdirSync(path.join(tmpDataDir, 'db', 'papers'), { recursive: true });
  // 学生 B 的试卷
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'papers', `${PAPER_B}.json`),
    JSON.stringify({
      id: PAPER_B,
      studentId: STUDENT_B,
      examId: 'exam-b',
      subject: '数学',
      title: 'B 的试卷',
      date: '2026-11-01',
      status: '待校验',
      totalLostScore: 0,
      questionsCount: 0,
      summary: '',
      confirmedMetadata: { examTitle: 'B 的试卷' },
    })
  );

  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'owner-a',
        secret: 'key-a',
        role: 'student',
        studentIds: [STUDENT_A],
      },
      {
        principalId: 'owner-b',
        secret: 'key-b',
        role: 'student',
        studentIds: [STUDENT_B],
      },
    ])
  );

  container = createContainer();
  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  tokenA = await login('key-a');
  tokenB = await login('key-b');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('试卷元信息确认的归属校验（回归）', () => {
  test('学生 A 不能改学生 B 的试卷（即使请求体填自己的 studentId）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/papers/${PAPER_B}/confirm-metadata`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          studentId: STUDENT_A, // ← 调用方自述，填自己的
          confirmedMetadata: { subject: '英语', examTitle: '被篡改' },
        }),
      }
    );

    assert.equal(res.status, 403, '跨学生修改应被拒绝');
  });

  test('越权请求不改变目标试卷的内容', async () => {
    await fetch(`${baseUrl}/api/v1/papers/${PAPER_B}/confirm-metadata`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        studentId: STUDENT_A,
        confirmedMetadata: { subject: '英语', examTitle: '被篡改' },
      }),
    });

    const paper = readPaperB();
    assert.notEqual(paper.confirmedMetadata?.examTitle, '被篡改');
    assert.equal(paper.subject, '数学', '学科不应被改');
  });

  test('试卷主人可以正常修改自己的试卷', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/papers/${PAPER_B}/confirm-metadata`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({
          studentId: STUDENT_B,
          confirmedMetadata: { subject: '数学', examTitle: 'B 确认后的试卷名' },
        }),
      }
    );

    assert.equal(res.status, 200, '主人应能修改自己的试卷');
    const paper = readPaperB();
    assert.equal(paper.confirmedMetadata?.examTitle, 'B 确认后的试卷名');
    assert.equal(paper.status, '已识别');
  });
});

describe('新建试卷持久化归属', () => {
  test('创建的试卷记录了 studentId', async () => {
    const res = await fetch(`${baseUrl}/api/v1/exams/exam-a/papers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        studentId: STUDENT_A,
        id: 'paper-new-owner',
        subject: '物理',
        title: 'A 的卷子',
        date: '2026-11-01',
        diagnosedItems: [],
      }),
    });

    assert.equal(res.status, 200);

    const paper = JSON.parse(
      fs.readFileSync(
        path.join(tmpDataDir, 'db', 'papers', 'paper-new-owner.json'),
        'utf8'
      )
    ) as { studentId?: string };

    assert.equal(
      paper.studentId,
      STUDENT_A,
      '试卷必须记录归属，否则后续无法校验「这张卷属于谁」'
    );
  });
});
