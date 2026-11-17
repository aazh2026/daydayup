/**
 * 限流键维度测试（回归）。
 *
 * ## 为什么重要
 *
 * 限流器的文档写着「已认证用户按用户维度，匿名按 IP」，
 * 实现里也有 `skipAuthenticated: true` 选项 ——
 * 但限流中间件挂在 `requireAuth` **之前**（登录等公开端点不能要求认证），
 * 此时 `req.auth` 恒为 undefined，那个分支**从未执行过**。
 *
 * 后果：所有请求（含已登录的）都挤在同一个 IP 桶里。
 * 实测：max=5 时，用户 A 用掉 5 次后，**用户 B 直接吃 429** ——
 * 同一局域网 / NAT / 公司出口下的不同用户互相影响。
 *
 * 修复：限流器自己解析令牌（`resolvePrincipalId`），
 * 按主体 ID 分桶；令牌无效则回落到 IP 维度。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { TokenService } from '../src/infrastructure/security/token.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;

const RATE_LIMIT = '5';

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

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-ratelimit-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'ratelimit-test-secret';
  process.env.GEMINI_API_KEY = '';
  process.env.RATE_LIMIT_PER_MINUTE = RATE_LIMIT;

  fs.mkdirSync(path.join(tmpDataDir, 'db', 'students'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'students', 'stu-A.json'),
    JSON.stringify({
      id: 'stu-A',
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
        principalId: 'user-one',
        secret: 'key-one',
        role: 'student',
        studentIds: ['stu-A'],
      },
      {
        principalId: 'user-two',
        secret: 'key-two',
        role: 'student',
        studentIds: ['stu-A'],
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

describe('限流按用户隔离（回归）', () => {
  test('不同用户互不影响', async () => {
    const tokenOne = await login('key-one');
    const tokenTwo = await login('key-two');

    // 用户一用掉一半额度
    const codesOne: number[] = [];
    for (let i = 0; i < 3; i++) {
      codesOne.push(
        (
          await fetch(`${baseUrl}/api/v1/students/stu-A/mastery`, {
            headers: { Authorization: `Bearer ${tokenOne}` },
          })
        ).status
      );
    }
    assert.ok(
      codesOne.every((c) => c === 200),
      `用户一应全部成功，实际 ${JSON.stringify(codesOne)}`
    );

    // 用户二仍有完整额度（修复前这里会吃 429）
    const codesTwo: number[] = [];
    for (let i = 0; i < 3; i++) {
      codesTwo.push(
        (
          await fetch(`${baseUrl}/api/v1/students/stu-A/mastery`, {
            headers: { Authorization: `Bearer ${tokenTwo}` },
          })
        ).status
      );
    }
    assert.ok(
      codesTwo.every((c) => c === 200),
      `用户二不应被用户一挤掉，实际 ${JSON.stringify(codesTwo)}`
    );
  });

  test('同一用户超出额度后被限流', async () => {
    const token = await login('key-one');
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push(
        (
          await fetch(`${baseUrl}/api/v1/students/stu-A/mastery`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status
      );
    }
    assert.ok(codes.includes(429), `超出额度应被限流，实际 ${JSON.stringify(codes)}`);
  });

  test('限流响应带 Retry-After 与 X-RateLimit-* 头', async () => {
    const token = await login('key-two');
    let last: Response | null = null;
    for (let i = 0; i < 8; i++) {
      last = await fetch(`${baseUrl}/api/v1/students/stu-A/mastery`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    assert.ok(last);
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'), '应带 Retry-After');
    assert.equal(last.headers.get('x-ratelimit-limit'), RATE_LIMIT);
    assert.ok(last.headers.get('x-ratelimit-reset'));
  });
});

describe('令牌解析', () => {
  test('有效令牌解析出主体 ID', () => {
    const service = new TokenService('secret');
    const { token } = service.issue('user-1', ['stu-A'], 'student');
    assert.equal(
      service.resolvePrincipalId(`Bearer ${token}`),
      'user-1'
    );
  });

  test('无令牌返回 null', () => {
    const service = new TokenService('secret');
    assert.equal(service.resolvePrincipalId(undefined), null);
    assert.equal(service.resolvePrincipalId(''), null);
  });

  test('非 Bearer 格式返回 null', () => {
    const service = new TokenService('secret');
    assert.equal(service.resolvePrincipalId('Basic abc'), null);
    assert.equal(service.resolvePrincipalId('token123'), null);
  });

  test('签名错误的令牌返回 null（不能拿到独立桶）', () => {
    const service = new TokenService('secret');
    const other = new TokenService('other-secret');
    const { token } = other.issue('attacker', [], 'teacher');
    assert.equal(service.resolvePrincipalId(`Bearer ${token}`), null);
  });

  test('过期的令牌返回 null', () => {
    const service = new TokenService('secret', -1);
    const { token } = service.issue('user-1', [], 'student');
    assert.equal(service.resolvePrincipalId(`Bearer ${token}`), null);
  });

  test('大小写不敏感的 Bearer 前缀', () => {
    const service = new TokenService('secret');
    const { token } = service.issue('user-1', [], 'student');
    assert.equal(service.resolvePrincipalId(`bearer ${token}`), 'user-1');
    assert.equal(service.resolvePrincipalId(`BEARER ${token}`), 'user-1');
  });
});

describe('伪造令牌不被限流绕过', () => {
  test('伪造令牌返回 401 且不获得独立桶', async () => {
    // 构造一个 payload 合法但签名错误的令牌
    const forged =
      'eyJzdWIiOiJhdHRhY2tlciIsInNpZHMiOltdLCJyb2xlIjoidGVhY2hlciIsImlhdCI6MTc5NDg4ODg1MSwiZXhwIjo5OTk5OTk5OTk5fQ.badsignature';

    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (
          await fetch(`${baseUrl}/api/v1/students/stu-A/mastery`, {
            headers: { Authorization: `Bearer ${forged}` },
          })
        ).status
      );
    }
    assert.ok(
      codes.every((c) => c === 401),
      `伪造令牌应全部 401，实际 ${JSON.stringify(codes)}`
    );
  });
});
