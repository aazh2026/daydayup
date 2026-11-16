/**
 * 角色权限测试。
 *
 * 覆盖运维类接口的角色边界：
 * 家长（只读）不应能触发影响全部学生数据的操作。
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

const STUDENT_ID = 'stu-sh-zhangwei';

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

interface AuditEntry {
  event_type: string;
  aggregate_id: string;
  actor: string;
  actor_role: string;
  payload?: Record<string, unknown>;
}

/** 读取当日审计日志（直接读文件，验证服务端确实落盘） */
async function readAuditToday(): Promise<AuditEntry[]> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const raw = fs.readFileSync(
    path.join(tmpDataDir, 'audit', `${dateKey}.jsonl`),
    'utf8'
  );
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-roles-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'roles-test-secret';
  process.env.GEMINI_API_KEY = '';

  // 教师与家长凭证
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'student-001',
        secret: 'student-key',
        role: 'student',
        studentIds: [STUDENT_ID],
      },
      {
        principalId: 'parent-001',
        secret: 'parent-key',
        role: 'parent',
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
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('运维接口角色边界', () => {
  test('家长不能触发备份（影响全部数据）', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ label: 'unauthorized' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  test('家长不能触发数据清理（会删除他人数据）', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/cleanup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  test('家长不能读取审计日志', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/audit`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  test('家长不能列出备份', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/backups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  test('家长不能校验或恢复备份', async () => {
    const token = await login('parent-key');
    const verify = await fetch(`${baseUrl}/api/v1/admin/backups/some-backup/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(verify.status, 403);

    const restore = await fetch(
      `${baseUrl}/api/v1/admin/backups/some-backup/restore`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dryRun: true }),
      }
    );
    assert.equal(restore.status, 403);
  });

  test('家长不能写入审计记录', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ eventType: 'CustomAudit' }),
    });
    assert.equal(res.status, 403);
  });

  test('教师可以触发备份', async () => {
    const token = await login('teacher-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ label: 'teacher-test' }),
    });
    assert.equal(res.status, 200);
  });

  test('学生不能触发备份', async () => {
    const token = await login('student-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ label: 'student-test' }),
    });
    assert.equal(res.status, 403);
  });

  test('学生不能触发数据清理', async () => {
    const token = await login('student-key');
    const res = await fetch(`${baseUrl}/api/v1/admin/cleanup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  test('未携带令牌访问运维接口返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/backups`, { method: 'GET' });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  test('无效令牌访问运维接口返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/backups`, {
      headers: { Authorization: 'Bearer garbage-token' },
    });
    assert.equal(res.status, 401);
  });
});

describe('家长只读边界', () => {
  test('家长可以查看学生数据', async () => {
    const token = await login('parent-key');
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/mastery`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  test('家长不能修改学生档案', async () => {
    const token = await login('parent-key');
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/profile`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dailyBudgetMinutes: 999 }),
      }
    );
    assert.equal(res.status, 403);
  });

  test('家长不能提交作答（不能替孩子做）', async () => {
    const token = await login('parent-key');
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/math-alg-rational/attempt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mode: '基础练习', isCorrect: true }),
      }
    );
    assert.equal(res.status, 403);
  });

  test('家长可以代为行使孩子的数据删除权', async () => {
    const token = await login('parent-key');
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/${STUDENT_ID}/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    // 允许删除（数据主体权利），但需审计留痕
    assert.ok(res.status === 200, `应允许删除，实际 ${res.status}`);

    const body = (await res.json()) as { studentId: string; deletedAt: string };
    assert.equal(body.studentId, STUDENT_ID);
  });
});

describe('数据删除权边界', () => {
  test('家长不能删除不属于自己的学生数据', async () => {
    const token = await login('parent-key');
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/stu-not-mine/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  test('未携带令牌不能删除学生数据', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/${STUDENT_ID}/data`,
      { method: 'DELETE' }
    );
    assert.equal(res.status, 401);
  });

  test('教师可以删除任意学生数据', async () => {
    const token = await login('teacher-key');
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/stu-teacher-case/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 200);
  });
});

describe('数据删除审计留痕', () => {
  test('家长代删记录 via=parent', async () => {
    const token = await login('parent-key');
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/stu-audit-parent/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 200);

    const entries = await readAuditToday();
    const entry = entries.find(
      (e) => e.event_type === 'StudentDataDeleted' && e.aggregate_id === 'stu-audit-parent'
    );
    assert.ok(entry, '删除操作应写入审计日志');
    assert.equal(entry.payload?.via, 'parent');
    assert.equal(entry.actor, 'parent-001');
    assert.equal(entry.actor_role, 'parent');
  });

  test('老师代删记录 via=teacher（不是 owner）', async () => {
    const token = await login('teacher-key');
    const res = await fetch(
      `${baseUrl}/api/v1/admin/students/stu-audit-teacher/data`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 200);

    const entries = await readAuditToday();
    const entry = entries.find(
      (e) => e.event_type === 'StudentDataDeleted' && e.aggregate_id === 'stu-audit-teacher'
    );
    assert.ok(entry, '删除操作应写入审计日志');
    // 老师删除属于「管理需要」，不能记成 owner —— 否则审计追溯失真
    assert.equal(entry.payload?.via, 'teacher');
    assert.equal(entry.actor_role, 'teacher');
  });
});

describe('教师跨学生访问', () => {
  test('教师可访问任意学生', async () => {
    const token = await login('teacher-key');
    const res = await fetch(`${baseUrl}/api/v1/students/any-other-student/mastery`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 不应是 403
    assert.notEqual(res.status, 403);
  });
});

describe('旧路径兼容层已移除', () => {
  test('/api/diagnose-paper 返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/diagnose-paper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });

  test('/api/v1/diagnose-paper 仍可用', async () => {
    const token = await login('teacher-key');
    const res = await fetch(`${baseUrl}/api/v1/diagnose-paper`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    // 未配置 API Key → 500（非 404），说明路由存在
    assert.notEqual(res.status, 404);
  });
});
