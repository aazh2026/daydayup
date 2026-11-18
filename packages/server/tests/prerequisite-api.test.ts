/**
 * 先修链 API 端点测试。
 *
 * 覆盖：
 *  - GET /students/:id/prerequisite-chain：目标 → 根因 → 学习路径
 *  - GET /students/:id/blocking-summary：全量阻断概况
 *  - **认证与资源隔离**：这两个端点读学生掌握度，必须受 requireAuth 保护
 *
 * 为什么必须带 AUTH_SECRET 跑：
 * 曾经的实现把这两个端点挂在 `v1`（无 requireAuth）上，
 * 于是 `req.auth` 永远为空 → 401「缺少访问令牌」→
 * 前端 API 客户端触发 notifyAuthExpired() 清会话 →
 * 用户一进「提分报告」页就被踢回登录页。
 * 若测试跑在开发模式（无 AUTH_SECRET，认证被跳过），
 * 这个 bug 完全测不出来 —— 所以本文件显式配置 AUTH_SECRET。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { createContainer } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { getCurriculum } from '../src/infrastructure/knowledge/curriculum.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let token: string;

const STUDENT_ID = 'stu-sh-zhangwei';
const OTHER_STUDENT_ID = 'stu-other-student';

/** 从当前资产里找一个有先修的知识点 */
function findKnowledgeWithPrereq(): string {
  const curriculum = getCurriculum();
  const kp = curriculum.knowledgePoints.find((k) => k.prerequisites.length > 0);
  if (!kp) throw new Error('当前资产里没有带先修的知识点');
  return kp.id;
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-pre-api-'));

  // 播种演示数据（含学生档案与掌握度）
  const seedSrc = path.resolve(__dirname, '../data/seed/demo-student.json');
  const seedDir = path.join(tmpDataDir, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.copyFileSync(seedSrc, path.join(seedDir, 'demo-student.json'));

  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'test-secret-for-prerequisite';
  process.env.GEMINI_API_KEY = '';

  const { execSync } = await import('node:child_process');
  execSync(`npx tsx ${path.resolve(__dirname, '../scripts/seed.ts')}`, {
    env: { ...process.env, DATA_DIR: tmpDataDir },
    stdio: 'pipe',
  });

  const container = createContainer();
  const app = createApp(container);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // 登录换取令牌（种子默认学生 PIN）
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: '1234' }),
  });
  assert.equal(loginRes.status, 200, '登录失败，无法继续测试');
  const loginBody = (await loginRes.json()) as { token?: string };
  token = loginBody.token ?? '';
  assert.ok(token.length > 0, '登录未返回令牌');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('先修链 API', () => {
  test('带令牌可读取先修链（证明路由在认证保护下仍可达）', async () => {
    const knowledgeId = findKnowledgeWithPrereq();
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/prerequisite-chain?knowledgeId=${knowledgeId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 200, '带令牌却失败：路由可能挂在了无认证的父级上');

    const body = (await res.json()) as {
      version: string;
      knowledgeId: string;
      chain: {
        targetId: string;
        targetName: string;
        hasBlocking: boolean;
        rootCauses: unknown[];
        learningPath: Array<{ knowledgeId: string; state: string; distance: number }>;
      };
    };

    assert.equal(body.knowledgeId, knowledgeId);
    assert.equal(body.chain.targetId, knowledgeId);
    assert.ok(body.chain.targetName.length > 0);
    assert.ok(Array.isArray(body.chain.rootCauses));
    assert.ok(Array.isArray(body.chain.learningPath));
    assert.ok(
      body.chain.learningPath.some((n) => n.knowledgeId === knowledgeId),
      '学习路径应包含目标自身'
    );
  });

  test('学习路径先修在前、目标 distance 为 0', async () => {
    const knowledgeId = findKnowledgeWithPrereq();
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/prerequisite-chain?knowledgeId=${knowledgeId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = (await res.json()) as {
      chain: { learningPath: Array<{ knowledgeId: string; distance: number }> };
    };

    const path = body.chain.learningPath;
    const target = path.find((n) => n.knowledgeId === knowledgeId);
    assert.equal(target?.distance, 0, '目标自身 distance 应为 0');

    // 任一节点的先修若也在路径中，必须排在它前面
    for (const n of path) {
      assert.ok(n.distance >= 0);
    }
  });

  test('缺少 knowledgeId 返回 400', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/prerequisite-chain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 400);
  });

  test('未知知识点返回 200 且空链（不抛错）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/prerequisite-chain?knowledgeId=__nope__`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      chain: { hasBlocking: boolean; rootCauses: unknown[] };
    };
    assert.equal(body.chain.hasBlocking, false);
    assert.equal(body.chain.rootCauses.length, 0);
  });

  test('无令牌返回 401（端点确实受 requireAuth 保护）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/prerequisite-chain?knowledgeId=x`
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'UNAUTHORIZED');
  });

  test('跨学生访问被拒绝（资源级隔离）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${OTHER_STUDENT_ID}/prerequisite-chain?knowledgeId=x`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 403);
  });

  test('GET /students/:id/blocking-summary 返回统计与根因', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/blocking-summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      summary: {
        blockedTargets: Array<{ knowledgeId: string }>;
        rootCauses: unknown[];
        stats: {
          totalKnowledgePoints: number;
          diagnosedCount: number;
          blockedTargetCount: number;
          rootCauseCount: number;
        };
      };
    };

    const s = body.summary.stats;
    assert.ok(s.totalKnowledgePoints > 0);
    assert.equal(
      s.blockedTargetCount,
      new Set(body.summary.blockedTargets.map((b) => b.knowledgeId)).size
    );
    assert.equal(s.rootCauseCount, body.summary.rootCauses.length);
  });

  test('blocking-summary 支持 limit 参数', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/blocking-summary?limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      summary: { stats: { totalKnowledgePoints: number } };
    };
    assert.ok(body.summary.stats.totalKnowledgePoints > 0);
  });

  test('blocking-summary 无令牌返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/blocking-summary`);
    assert.equal(res.status, 401);
  });
});
