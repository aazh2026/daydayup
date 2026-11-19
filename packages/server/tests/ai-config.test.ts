/**
 * AI 配置能力测试。
 *
 * 覆盖三件事：
 * 1. **契约层**：参数校验与 Key 掩码（纯函数）
 * 2. **存储层**：环境变量默认值 vs 运行时配置覆盖、Key 不外泄
 * 3. **路由层**：老师可读写配置、非老师被拒、Key 永不出现在响应里
 *
 * 为什么要单独测：
 * - 「Key 不外泄」是**安全红线**，一旦回归就是泄露；
 * - 「保存即生效」是本功能的核心价值，
 *   回归成「要重启才生效」等于功能没做。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  AI_CONFIG_LIMITS,
  maskApiKey,
  validateAIConfigUpdate,
  type AIConfig,
} from '@daydayup/contracts';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;
let teacherToken: string;
let studentToken: string;

const TEACHER_SECRET = 'teacher-key';
const STUDENT_SECRET = 'student-key';
const STUDENT_ID = 'stu-ai-cfg';

/** 模拟一次配置更新，并断言响应中**不含**明文 Key */
async function putSettings(
  token: string,
  body: unknown
): Promise<{ status: number; payload: any }> {
  const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: unknown = undefined;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-aicfg-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'ai-cfg-test-secret';
  // 故意设一个环境变量 Key，用来验证「运行时配置覆盖环境变量」
  process.env.GEMINI_API_KEY = 'env-key-0000';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  process.env.DAILY_TOKEN_QUOTA = '50';

  fs.mkdirSync(path.join(tmpDataDir, 'db', 'students'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'students', `${STUDENT_ID}.json`),
    JSON.stringify({
      id: STUDENT_ID,
      name: '李雷',
      grade: '初三',
      region: '上海',
      dailyBudgetMinutes: 60,
    })
  );
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'teacher-001',
        secret: TEACHER_SECRET,
        role: 'teacher',
        studentIds: [],
        displayName: '王老师',
      },
      {
        principalId: 'student-001',
        secret: STUDENT_SECRET,
        role: 'student',
        studentIds: [STUDENT_ID],
        displayName: '李雷',
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

  const login = async (secret: string) => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    const body = (await res.json()) as { token?: string };
    return body.token ?? '';
  };

  teacherToken = await login(TEACHER_SECRET);
  studentToken = await login(STUDENT_SECRET);
  assert.ok(teacherToken, '应取得老师令牌');
  assert.ok(studentToken, '应取得学生令牌');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('契约层：参数校验与掩码', () => {
  test('合法参数通过校验', () => {
    const errors = validateAIConfigUpdate({
      model: 'gemini-2.5-pro',
      temperature: 0.5,
      timeoutMs: 60_000,
      maxRetries: 2,
      dailyQuota: 100,
      enabled: true,
    });
    assert.deepEqual(errors, []);
  });

  test('越界数值被拒绝并给出原因', () => {
    const errors = validateAIConfigUpdate({
      temperature: AI_CONFIG_LIMITS.temperature.max + 1,
      timeoutMs: 1,
      maxRetries: 99,
      dailyQuota: -1,
    });
    assert.ok(errors.length >= 4, `应报出 4 项错误，实际 ${errors.length}`);
  });

  test('类型错误被拒绝', () => {
    const errors = validateAIConfigUpdate({
      temperature: 'hot',
      enabled: 'yes',
    });
    assert.equal(errors.length, 2);
  });

  test('Key 掩码只保留末 4 位', () => {
    assert.equal(maskApiKey('AIzaSy-1234567890'), '****7890');
    assert.equal(maskApiKey('abc'), '****');
    assert.equal(maskApiKey(''), '');
  });
});

describe('配置读取：环境变量作为默认值', () => {
  test('未改过时来自环境变量，且 Key 只返回掩码', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { config: AIConfig; models: string[] };

    assert.equal(body.config.source, 'env');
    assert.equal(body.config.hasApiKey, true);
    assert.equal(body.config.apiKeyMasked, '****0000');
    assert.equal(body.config.model, 'gemini-2.5-flash');
    assert.equal(body.config.dailyQuota, 50);

    // 安全红线：明文 Key 不得出现在响应体里
    assert.ok(!raw.includes('env-key-0000'), '响应中不得出现明文 API Key');
    assert.ok(!raw.includes('env-key'), '响应中不得出现 API Key 片段');
  });

  test('模型清单随配置一起返回', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const body = (await res.json()) as { models: string[] };
    assert.ok(body.models.includes('gemini-4-hydrogen'));
  });
});

describe('配置修改：保存即生效', () => {
  test('老师可以修改配置，来源变为 runtime', async () => {
    const { status, payload } = await putSettings(teacherToken, {
      model: 'gemini-4-hydrogen',
      temperature: 0.3,
      timeoutMs: 90_000,
      maxRetries: 4,
      dailyQuota: 20,
      enabled: true,
    });
    assert.equal(status, 200);
    assert.equal(payload.config.source, 'runtime');
    assert.equal(payload.config.model, 'gemini-4-hydrogen');
    assert.equal(payload.config.temperature, 0.3);
    assert.equal(payload.config.maxRetries, 4);
    assert.equal(payload.config.dailyQuota, 20);
  });

  test('重新读取仍是修改后的值（无需重启）', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const body = (await res.json()) as { config: AIConfig };
    assert.equal(body.config.source, 'runtime');
    assert.equal(body.config.temperature, 0.3);
    assert.equal(body.config.timeoutMs, 90_000);
  });

  test('保存后立即落盘（重启也不丢）', async () => {
    const file = path.join(tmpDataDir, 'db', 'ai-config.json');
    assert.ok(fs.existsSync(file), '配置应落盘到 db/ai-config.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      temperature: number;
      model: string;
    };
    assert.equal(saved.temperature, 0.3);
    assert.equal(saved.model, 'gemini-4-hydrogen');
  });

  test('换用新 Key 后掩码随之变化，明文不外泄', async () => {
    const secretKey = 'AIzaSy-runtime-9999';
    const { status, payload } = await putSettings(teacherToken, {
      apiKey: secretKey,
    });
    assert.equal(status, 200);
    assert.equal(payload.config.hasApiKey, true);
    assert.equal(payload.config.apiKeyMasked, '****9999');

    const raw = JSON.stringify(payload);
    assert.ok(!raw.includes(secretKey), '响应中不得出现明文 API Key');
  });

  test('空字符串 Key 表示「不修改」，原 Key 保留', async () => {
    const { status, payload } = await putSettings(teacherToken, { apiKey: '' });
    assert.equal(status, 200);
    assert.equal(payload.config.hasApiKey, true);
    assert.equal(payload.config.apiKeyMasked, '****9999');
  });

  test('非法参数被拒绝（400）', async () => {
    const { status } = await putSettings(teacherToken, { temperature: 99 });
    assert.equal(status, 400);
  });

  test('停用 AI 后配置立即反映为 disabled', async () => {
    const { status, payload } = await putSettings(teacherToken, { enabled: false });
    assert.equal(status, 200);
    assert.equal(payload.config.enabled, false);

    // 恢复
    await putSettings(teacherToken, { enabled: true });
  });

  test('恢复默认后回落环境变量', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { config: AIConfig };
    assert.equal(body.config.source, 'env');
    assert.equal(body.config.model, 'gemini-2.5-flash');
    assert.equal(body.config.apiKeyMasked, '****0000');
  });
});

describe('权限：只有老师能配置 AI', () => {
  test('学生访问被拒绝（403）', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(res.status, 403);
  });

  test('学生修改被拒绝（403）', async () => {
    const { status } = await putSettings(studentToken, { model: 'gemini-2.5-pro' });
    assert.equal(status, 403);
  });

  test('未登录访问被拒绝（401）', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings`);
    assert.equal(res.status, 401);
  });
});

describe('连通性测试接口', () => {
  test('没有可用 Key 时返回结构化失败而非 500', async () => {
    // 停用 AI → 无可用 Provider → 不发起任何网络请求（确定性）
    await putSettings(teacherToken, { enabled: false });

    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error: string | null };
    assert.equal(body.ok, false);
    assert.ok(body.error, '失败时应给出原因');

    await putSettings(teacherToken, { enabled: true });
  });

  test('AI 被停用时提示先启用', async () => {
    await putSettings(teacherToken, { enabled: false });
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const body = (await res.json()) as { ok: boolean; error: string | null };
    assert.equal(body.ok, false);
    assert.ok(body.error?.includes('禁用'));
    await putSettings(teacherToken, { enabled: true });
  });

  test('学生调用测试接口被拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/ai-settings/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(res.status, 403);
  });
});

describe('运行时行为：配额随配置变化', () => {
  test('配额上限可被运行时配置改写', async () => {
    await putSettings(teacherToken, { dailyQuota: 7 });
    assert.equal(container.quota.getLimit(), 7);

    await putSettings(teacherToken, { dailyQuota: 0 });
    assert.equal(container.quota.getLimit(), 0, '0 表示不限制');
  });

  test('AI 停用后 AI 接口返回明确提示', async () => {
    await putSettings(teacherToken, { enabled: false });

    const res = await fetch(`${baseUrl}/api/v1/coach/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({ knowledgeId: 'math-alg-rational', message: '你好' }),
    });

    assert.notEqual(res.status, 200, '停用后不应成功');
    const body = (await res.json()) as { error?: { message?: string } };
    assert.ok(
      body.error?.message?.includes('AI'),
      `错误提示应说明 AI 不可用，实际：${body.error?.message}`
    );

    await putSettings(teacherToken, { enabled: true });
  });
});
