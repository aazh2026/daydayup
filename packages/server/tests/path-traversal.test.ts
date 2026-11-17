/**
 * 路径穿越防护测试。
 *
 * ## 为什么重要
 *
 * `FileDatabase.resolvePath` 只保证最终路径**不逃出 dataDir 根**，
 * 但拦不住「逃出预期子目录」——
 * 而 dataDir 内部放着凭证文件、其它学生的数据文件。
 *
 * 实测（修复前）：
 * - 老师 `PUT /students/../credentials/profile` → **覆盖了 `db/credentials.json`**
 * - 学生 `PUT /coaching/sessions/../../evil` → **在 `db/` 下写了文件**
 *
 * 老师角色尤其危险：`assertStudentAccess` 对 teacher 直接放行，
 * 所以穿越串不需要在任何人的授权名单里。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { sanitizeSegment } from '../src/infrastructure/persistence/file-database.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;
let teacherToken: string;
let studentToken: string;

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

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-traversal-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'traversal-test-secret';
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
        principalId: 'teacher-001',
        secret: 'teacher-key',
        role: 'teacher',
        studentIds: [],
      },
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

  teacherToken = await login('teacher-key');
  studentToken = await login('student-key');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('路径片段清洗', () => {
  test('路径分隔符被替换', () => {
    // 允许集为 [a-zA-Z0-9_-]，所以 `.` 也被替换
    assert.equal(sanitizeSegment('../evil'), '___evil');
    assert.equal(sanitizeSegment('a/b'), 'a_b');
    assert.equal(sanitizeSegment('a\\b'), 'a_b');
  });

  test('正常 ID 不受影响', () => {
    assert.equal(sanitizeSegment('stu-sh-zhangwei'), 'stu-sh-zhangwei');
    assert.equal(sanitizeSegment('math-alg-rational'), 'math-alg-rational');
    assert.equal(sanitizeSegment('abc_123'), 'abc_123');
  });

  test('空值回落到 unknown', () => {
    assert.equal(sanitizeSegment(''), 'unknown');
  });

  test('长度被限制在 64 以内', () => {
    assert.equal(sanitizeSegment('x'.repeat(200)).length, 64);
  });

  test('点号被保留但分隔符不保留（无法形成 .. 路径）', () => {
    const cleaned = sanitizeSegment('../../etc/passwd');
    assert.ok(!cleaned.includes('/'), '清洗后不得含路径分隔符');
    assert.ok(!cleaned.includes('..'), '清洗后不得含 .. 序列');
  });
});

describe('学生档案接口的路径穿越', () => {
  test('老师用 ../credentials 更新档案不会覆盖凭证文件', async () => {
    const before = fs.readFileSync(
      path.join(tmpDataDir, 'db', 'credentials.json'),
      'utf8'
    );

    const res = await fetch(
      `${baseUrl}/api/v1/students/${encodeURIComponent('../credentials')}/profile`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${teacherToken}`,
        },
        body: JSON.stringify({ name: 'PWNED' }),
      }
    );

    // 修复前返回 200 且凭证文件被覆盖；现在应找不到该学生
    assert.notEqual(res.status, 200, '穿越路径不应命中任何学生档案');

    const after = fs.readFileSync(
      path.join(tmpDataDir, 'db', 'credentials.json'),
      'utf8'
    );
    assert.equal(after, before, '凭证文件不得被改写');
  });

  test('穿越请求不会在 db/ 根目录留下文件', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${encodeURIComponent('../../evil')}/profile`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${teacherToken}`,
        },
        body: JSON.stringify({ name: 'PWNED' }),
      }
    );
    assert.notEqual(res.status, 200);
    assert.equal(
      fs.existsSync(path.join(tmpDataDir, 'db', 'evil.json')),
      false,
      '不应在 db/ 下创建文件'
    );
  });

  test('正常学生 ID 仍然可用', async () => {
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string };
    assert.equal(body.id, STUDENT_ID);
  });
});

describe('教练会话接口的路径穿越', () => {
  test('knowledgeId 含穿越串时写不到预期目录之外', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/coaching/sessions/${encodeURIComponent('../../evil')}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
        },
        body: JSON.stringify({
          messages: [{ id: 'm1', role: 'user', text: 'x' }],
        }),
      }
    );
    assert.equal(res.status, 200);

    assert.equal(
      fs.existsSync(path.join(tmpDataDir, 'db', 'evil.json')),
      false,
      '不应写到 db/ 根目录'
    );

    // 实际应落在 coaching/<studentId>/ 下（清洗后的名字）
    const coachingDir = path.join(tmpDataDir, 'db', 'coaching', STUDENT_ID);
    const files = fs.existsSync(coachingDir) ? fs.readdirSync(coachingDir) : [];
    assert.equal(files.length, 1, '应在会话目录内写一个文件');
    assert.ok(!files[0].includes('/'), '文件名不得含路径分隔符');
  });

  test('穿越串被清洗后可正常读回（不会 500）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/coaching/sessions/${encodeURIComponent('../../evil')}`,
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { messages: unknown[] };
    assert.equal(body.messages.length, 1);
  });
});

describe('数据目录边界', () => {
  test('越界路径被拒绝（不逃出 dataDir）', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${encodeURIComponent('../../../../../../tmp/pwned')}`,
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    // 逃出 dataDir 必须失败（500 或 404）
    assert.ok(res.status >= 400, `应拒绝越界路径，实际 ${res.status}`);
    assert.equal(fs.existsSync('/tmp/pwned.json'), false);
  });

  test('dataDir 内没有意外产生的文件', () => {
    const dbFiles = fs.readdirSync(path.join(tmpDataDir, 'db'));
    const allowed = ['students', 'coaching', 'credentials.json'];
    for (const f of dbFiles) {
      assert.ok(
        allowed.includes(f),
        `db/ 下出现意外文件: ${f}（允许: ${allowed.join(', ')}）`
      );
    }
  });
});
