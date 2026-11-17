/**
 * 家长只读边界的角色测试。
 *
 * ## 背景
 *
 * 文档「角色与权限」明确写着：
 *
 * | 角色 | 权限 |
 * |---|---|
 * | `student` | 读写自己的学习数据 |
 * | `parent` | **只读** —— 可看报告，不能替孩子提交作答 |
 * | `teacher` | 可访问全部学生 |
 *
 * 但 AI 端点此前**只有身份校验、没有角色校验** ——
 * `requireAuth` 只回答「你是谁」，不回答「你能做什么」。
 * 于是家长可以调用 `/practice/evaluate` 替孩子提交作答，
 * 拿到判定结果与分步提示：
 *
 * - 越过「只读」边界（家长拿到了孩子的解题答案）
 * - 消耗**孩子**的 AI 配额（配额按 principalId 计）
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
let parentToken: string;
let studentToken: string;
let teacherToken: string;

const STUDENT_ID = 'stu-role-a';

/** 所有 AI 端点 —— 全部是「学习动作」，家长无正当理由调用 */
const AI_ENDPOINTS = [
  '/api/v1/diagnose-paper',
  '/api/v1/coach/chat',
  '/api/v1/practice/generate',
  '/api/v1/practice/evaluate',
  '/api/v1/diagnose-microquiz',
];

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

async function callAi(
  path: string,
  token: string
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: await res.text() };
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-roles-ai-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'roles-ai-test-secret';
  // 未配 API Key：AI 调用会返回 500，但**角色校验在此之前**，
  // 因此 403 与 500 能明确区分角色是否放行。
  process.env.GEMINI_API_KEY = '';

  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'parent-001',
        secret: 'parent-key',
        role: 'parent',
        studentIds: [STUDENT_ID],
      },
      {
        principalId: 'student-001',
        secret: 'student-key',
        role: 'student',
        studentIds: [STUDENT_ID],
      },
      {
        principalId: 'teacher-001',
        secret: 'teacher-key',
        role: 'teacher',
        studentIds: [],
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

  parentToken = await login('parent-key');
  studentToken = await login('student-key');
  teacherToken = await login('teacher-key');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('AI 端点的角色边界（回归）', () => {
  test('家长调用 AI 端点一律 403', async () => {
    for (const path of AI_ENDPOINTS) {
      const { status, body } = await callAi(path, parentToken);
      assert.equal(
        status,
        403,
        `${path} 对家长应返回 403，实际 ${status}（响应: ${body.slice(0, 100)}）`
      );
      assert.ok(
        body.includes('FORBIDDEN'),
        `${path} 应返回 FORBIDDEN 错误码`
      );
    }
  });

  test('学生可以调用 AI 端点（不受角色限制）', async () => {
    for (const path of AI_ENDPOINTS) {
      const { status } = await callAi(path, studentToken);
      // 未配 API Key → 500（AI 不可用），但**不是 403**（角色已放行）
      assert.notEqual(
        status,
        403,
        `${path} 对学生不应返回 403`
      );
    }
  });

  test('老师可以调用 AI 端点', async () => {
    for (const path of AI_ENDPOINTS) {
      const { status } = await callAi(path, teacherToken);
      assert.notEqual(status, 403, `${path} 对老师不应返回 403`);
    }
  });

  test('家长的只读权限（看报告）不受影响', async () => {
    // 家长仍能读掌握度
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`, {
      headers: { Authorization: `Bearer ${parentToken}` },
    });
    assert.equal(res.status, 200, '家长仍应能查看孩子的学习数据');
  });

  test('家长仍被拒绝写操作（既有防护未回退）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational/attempt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parentToken}`,
        },
        body: JSON.stringify({ mode: '基础练习', isCorrect: true }),
      }
    );
    assert.equal(res.status, 403, '家长不能替孩子提交作答');
  });
});
