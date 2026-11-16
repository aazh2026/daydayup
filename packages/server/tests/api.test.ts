/**
 * API 集成测试。
 *
 * 用真实的 HTTP 服务器 + 真实文件存储，验证端到端行为：
 * 认证、资源隔离、计划生成、错题落库、事件日志。
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

let server: Server;
let baseUrl: string;
let tmpDataDir: string;

const STUDENT_ID = 'stu-sh-zhangwei';

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-api-'));

  // 复制种子数据到临时目录
  const seedSrc = path.resolve(
    __dirname,
    '../data/seed/demo-student.json'
  );
  const seedDir = path.join(tmpDataDir, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.copyFileSync(seedSrc, path.join(seedDir, 'demo-student.json'));

  // 播种
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'test-secret-for-integration';
  process.env.GEMINI_API_KEY = '';

  const { execSync } = await import('node:child_process');
  execSync(`npx tsx ${path.resolve(__dirname, '../scripts/seed.ts')}`, {
    env: { ...process.env, DATA_DIR: tmpDataDir },
    stdio: 'pipe',
  });

  // 断言种子数据已落到临时目录
  assert.ok(
    fs.existsSync(path.join(tmpDataDir, 'db', 'students', `${STUDENT_ID}.json`)),
    `种子数据未写入 ${tmpDataDir}`
  );

  const container = createContainer();
  const app = createApp(container);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

async function login(secret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token, '登录应返回 token');
  return body.token;
}

describe('健康检查与认证', () => {
  test('health 返回服务状态', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; authRequired: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true, '配置了 AUTH_SECRET 应要求认证');
  });

  test('错误凭证返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong-secret' }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  test('缺少令牌访问受保护接口返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`);
    assert.equal(res.status, 401);
  });

  test('无效令牌返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`, {
      headers: { Authorization: 'Bearer invalid.token.here' },
    });
    assert.equal(res.status, 401);
  });
});

describe('资源级隔离', () => {
  test('访问非授权学生返回 403', async () => {
    const token = await login('1234');
    const res = await fetch(`${baseUrl}/api/v1/students/stu-other/mastery`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  test('访问授权学生返回 200', async () => {
    const token = await login('1234');
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });
});

describe('知识体系', () => {
  test('返回带版本号的知识点列表', async () => {
    const res = await fetch(`${baseUrl}/api/v1/knowledge-points`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: string;
      knowledgePoints: Array<{ id: string; prerequisites: string[] }>;
    };
    assert.match(body.version, /^shanghai-junior-/);
    assert.ok(body.knowledgePoints.length > 0);

    // 前置知识引用完整性
    const ids = new Set(body.knowledgePoints.map((k) => k.id));
    for (const kp of body.knowledgePoints) {
      for (const pre of kp.prerequisites) {
        assert.ok(ids.has(pre), `悬空的前置知识引用: ${pre}`);
      }
    }
  });

  test('按学科筛选生效', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/knowledge-points?subject=${encodeURIComponent('数学')}`
    );
    const body = (await res.json()) as {
      knowledgePoints: Array<{ subject: string }>;
    };
    assert.ok(body.knowledgePoints.length > 0);
    for (const kp of body.knowledgePoints) {
      assert.equal(kp.subject, '数学');
    }
  });
});

describe('TC08 — 服务端权威计划', () => {
  test('计划满足每日时间预算约束', async () => {
    const token = await login('1234');
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/plans/current`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 200);
    const plan = (await res.json()) as {
      effectiveDailyBudget: number;
      engineVersion: string;
      days: Array<{
        dayLabel: string;
        tasks: Array<{ estimatedMinutes: number }>;
      }>;
    };

    assert.equal(plan.days.length, 7);
    assert.ok(plan.engineVersion, '应记录引擎版本');

    for (const day of plan.days) {
      const total = day.tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      assert.ok(
        total <= plan.effectiveDailyBudget,
        `${day.dayLabel} 总时长 ${total} 超出预算 ${plan.effectiveDailyBudget}`
      );
      assert.ok(day.tasks.length <= 3, `${day.dayLabel} 任务数超限`);
    }
  });
});

describe('TC11 — 服务端权威掌握度迁移', () => {
  test('提交作答产生状态迁移并落库', async () => {
    const token = await login('1234');

    const before = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational/attempt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: '基础练习',
          isCorrect: true,
          evidenceSummary: '集成测试：独立做对',
          subject: '数学',
        }),
      }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mastery: { previousState: string; newState: string; transitionEventId: string };
    };
    assert.ok(body.mastery.transitionEventId, '应生成迁移事件 ID');
    assert.notEqual(body.mastery.previousState, body.mastery.newState);

    // 迁移历史已落库
    const history = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/history`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const historyBody = (await history.json()) as {
      history: Array<{ id: string }>;
    };
    assert.ok(
      historyBody.history.some(
        (h) => h.id === body.mastery.transitionEventId
      ),
      '迁移事件应持久化'
    );
  });

  test('作答流水写入事件日志', async () => {
    const token = await login('1234');
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(
      tmpDataDir,
      'db',
      'attempts',
      STUDENT_ID,
      `${today}.jsonl`
    );
    assert.ok(fs.existsSync(logPath), '作答流水文件应存在');

    const lines = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.ok(lines.length > 0);

    const last = JSON.parse(lines[lines.length - 1]) as {
      knowledgeId: string;
      isCorrect: boolean;
    };
    assert.equal(last.knowledgeId, 'math-alg-rational');
    assert.equal(last.isCorrect, true);
  });
});

describe('错题记录持久化', () => {
  test('诊断结果落库为错题记录', async () => {
    const token = await login('1234');
    const examId = 'exam-test-integration';

    const res = await fetch(`${baseUrl}/api/v1/exams/${examId}/papers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        studentId: STUDENT_ID,
        examTitle: '集成测试试卷',
        subject: '数学',
        sourceFormat: '文本试卷',
        totalLostScore: 6,
        questionsCount: 2,
        summary: '集成测试',
        knowledgeIds: ['math-alg-rational'],
        diagnosedItems: [
          {
            questionNumber: '1',
            stem: '题目一',
            studentAnswer: 'x=2',
            correctAnswer: 'x=-2',
            scoreLost: 4,
            knowledgeId: 'math-alg-rational',
            errorType: '知识问题',
            aiAnalysis: '未检验分母不为零',
            evidence: '第1题作答 x=2',
            confidence: '确定',
            verificationMethod: '复做同类基础题',
          },
          {
            questionNumber: '2',
            stem: '题目二',
            studentAnswer: '错误',
            correctAnswer: '正确',
            scoreLost: 2,
            knowledgeId: 'math-eq-ineq',
            errorType: '计算问题',
            aiAnalysis: '运算失误',
            evidence: '第2题',
            confidence: '较可能',
            verificationMethod: '限时训练',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { errorRecords: Array<{ id: string }> };
    assert.equal(body.errorRecords.length, 2);

    // 列表可查
    const list = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/error-records`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listBody = (await list.json()) as { records: unknown[] };
    assert.ok(listBody.records.length >= 2);

    // 状态更新
    const recordId = body.errorRecords[0].id;
    const patch = await fetch(
      `${baseUrl}/api/v1/error-records/${STUDENT_ID}/${recordId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: '已订正', correctionNote: '已重做' }),
      }
    );
    assert.equal(patch.status, 200);
    const updated = (await patch.json()) as { status: string; correctionNote: string };
    assert.equal(updated.status, '已订正');
    assert.equal(updated.correctionNote, '已重做');
  });
});

describe('事件日志', () => {
  test('诊断完成后写入事件日志', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDataDir, 'events', `${today}.jsonl`);
    assert.ok(fs.existsSync(logPath), '事件日志应存在');

    const lines = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.ok(lines.length > 0);

    const events = lines.map((l) => JSON.parse(l) as { event_type: string });
    assert.ok(
      events.some((e) => e.event_type === 'DiagnosisCompleted'),
      '应有 DiagnosisCompleted 事件'
    );
  });
});

describe('AI 端点保护', () => {
  test('缺少令牌调用 AI 接口返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/coach/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  test('有令牌但未配置 API Key 返回 500 并带错误码', async () => {
    const token = await login('1234');
    const res = await fetch(`${baseUrl}/api/v1/coach/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  });
});
