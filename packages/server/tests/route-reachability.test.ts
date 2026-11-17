/**
 * 前后端路由可达性测试。
 *
 * ## 为什么需要
 *
 * 分离后前端靠 URL 字符串调后端，两边**没有编译期保证**对得上 ——
 * 契约包只覆盖了**类型**，不覆盖「路径是否存在」。
 *
 * 后果：前端调了一个后端没注册的路径 →
 * - 404，且错误信息是「接口不存在: POST /api/v1/xxx」，
 *   排查时很难立刻联想到「路径写错了」还是「路由漏注册」
 * - 分离前是单体（前后端同进程），路径写错会直接抛错、立刻暴露；
 *   分离后变成静默的 404 —— **这类退化恰恰是分离的代价**
 *
 * 所以本测试用**真实 HTTP 服务**逐条验证前端实际使用的路径确实存在。
 *
 * 覆盖两类：
 * 1. 路径可达性（不 404）
 * 2. 方法匹配（GET 路径不能用 POST，反之亦然）
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
let token: string;

const STUDENT_ID = 'stu-reach';

/**
 * 前端实际使用的路径（来源：web/src 下的 api 调用点）。
 *
 * 期望状态用「非 404」判定 —— 鉴权失败（401/403）、校验失败（400）
 * 都说明**路由存在**，这才是本测试关心的。
 */
const FRONTEND_PATHS: Array<{ method: string; path: string; note: string }> = [
  // 认证与元信息
  { method: 'GET', path: '/api/v1/health', note: '健康检查' },
  { method: 'POST', path: '/api/v1/auth/login', note: '登录' },
  { method: 'GET', path: '/api/v1/knowledge-points', note: '知识体系' },

  // 学生维度
  { method: 'GET', path: '/api/v1/students', note: '学生列表（教师工作台）' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}`, note: '学生档案' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/mastery`, note: '掌握度' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/mastery/history`, note: '掌握度历史' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/opportunities`, note: '提分机会' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/effective-budget`, note: '有效预算' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/error-records`, note: '错题记录' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/attempts`, note: '作答流水' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/exam-results`, note: '考试成绩' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/exams`, note: '考试场次' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/papers`, note: '试卷存档库' },
  { method: 'GET', path: `/api/v1/students/${STUDENT_ID}/plans/current`, note: '当前计划' },
  { method: 'POST', path: `/api/v1/students/${STUDENT_ID}/plans`, note: '重算计划' },
  {
    method: 'GET',
    path: `/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational/retest-status`,
    note: '延迟复测状态',
  },
  {
    method: 'POST',
    path: `/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational/attempt`,
    note: '提交作答',
  },
  {
    method: 'GET',
    path: `/api/v1/students/${STUDENT_ID}/coaching/sessions`,
    note: '教练会话列表',
  },
  {
    method: 'GET',
    path: `/api/v1/students/${STUDENT_ID}/coaching/sessions/math-alg-rational`,
    note: '教练会话',
  },

  // 计划任务
  {
    method: 'PATCH',
    path: `/api/v1/plans/${STUDENT_ID}/tasks/task-1`,
    note: '更新任务状态',
  },

  // 错题
  {
    method: 'PATCH',
    path: `/api/v1/error-records/${STUDENT_ID}/err-1`,
    note: '更新错题状态',
  },

  // 考试与试卷
  { method: 'POST', path: '/api/v1/exams', note: '创建考试' },
  { method: 'GET', path: '/api/v1/exams/exam-1', note: '考试详情' },
  { method: 'POST', path: '/api/v1/exams/exam-1/papers', note: '上传试卷' },
  { method: 'POST', path: '/api/v1/exams/exam-1/diagnosis', note: '发起诊断' },
  {
    method: 'PATCH',
    path: '/api/v1/papers/paper-1/confirm-metadata',
    note: '确认元信息',
  },

  // 任务
  { method: 'GET', path: '/api/v1/jobs', note: '任务列表' },
  { method: 'GET', path: '/api/v1/jobs/job-1', note: '任务详情' },
  { method: 'GET', path: '/api/v1/jobs/job-1/events', note: 'SSE 进度' },
  { method: 'POST', path: '/api/v1/jobs/job-1/cancel', note: '取消任务' },

  // 练习与 AI
  {
    method: 'GET',
    path: '/api/v1/practice/questions?knowledgeId=math-alg-rational',
    note: '题库取题',
  },
  { method: 'POST', path: '/api/v1/practice/generate', note: 'AI 出题' },
  { method: 'POST', path: '/api/v1/practice/evaluate', note: 'AI 评测' },
  { method: 'POST', path: '/api/v1/coach/chat', note: 'AI 教练' },
  { method: 'POST', path: '/api/v1/diagnose-microquiz', note: '诊断微测' },
  { method: 'POST', path: '/api/v1/diagnose-paper', note: '试卷诊断' },

  // 上传
  { method: 'POST', path: '/api/v1/uploads/papers', note: '上传试卷图片' },
];

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-reach-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'reach-test-secret';
  process.env.GEMINI_API_KEY = '';

  fs.mkdirSync(path.join(tmpDataDir, 'db', 'students'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'students', `${STUDENT_ID}.json`),
    JSON.stringify({
      id: STUDENT_ID,
      name: '张伟',
      grade: '初三',
      region: '上海',
      targetExamDate: '2027-06-20',
      targetSchool: '上海市重点高中',
      dailyBudgetMinutes: 60,
      homeworkLoad: '适中',
      fatigueLevel: '低',
    })
  );
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'student-001',
        secret: 'student-key',
        role: 'student',
        studentIds: [STUDENT_ID],
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

  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'student-key' }),
  });
  const body = (await res.json()) as { token: string };
  token = body.token;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('前端使用的路径均可达', () => {
  for (const { method, path: apiPath, note } of FRONTEND_PATHS) {
    test(`${method} ${apiPath.split('?')[0]}（${note}）不返回 404`, async () => {
      const res = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: method === 'GET' ? undefined : JSON.stringify({}),
      });

      /**
       * 注意：**资源不存在**也会返回 404（如「任务不存在」「错题记录不存在」），
       * 那说明路由**是存在的**、只是数据没有。
       *
       * 真正要防的是「**接口不存在**」——
       * 那是 `notFoundHandler` 抛的，表示前端调了一个后端没注册的路径。
       *
       * 两者的错误消息不同，可以据此区分。
       */
      if (res.status === 404) {
        const body = (await res.json()) as { error?: { message?: string } };
        const message = body.error?.message ?? '';
        assert.ok(
          !message.includes('接口不存在'),
          `${method} ${apiPath} —— 路由未注册（${note}）`
        );
      }
    });
  }
});

describe('方法不匹配会被正确拒绝', () => {
  test('GET 一个只支持 POST 的路径 → 404（不是 405）', async () => {
    // Express 对未匹配方法返回 404 —— 关键是**不能**意外地成功
    const res = await fetch(`${baseUrl}/api/v1/practice/evaluate`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.notEqual(res.status, 200, '方法不匹配不应成功');
  });

  test('POST 一个只支持 GET 的路径 → 404', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.notEqual(res.status, 200, '方法不匹配不应成功');
  });
});

describe('旧路径兼容层确实已移除', () => {
  test('/api/diagnose-paper 返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/diagnose-paper`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.equal(res.status, 404, '旧路径兼容层应已移除');
  });

  test('/api/coach/chat 返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/coach/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });

  test('/api/practice/generate 返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/practice/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });
});
