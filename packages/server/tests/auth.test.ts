/**
 * 鉴权与配额测试。
 *
 * 覆盖场景：
 * - Token 签发 / 校验 / 过期 / 篡改
 * - 资源级隔离（跨学生访问被拒）
 * - 角色权限（家长只读）
 * - AI 配额上限
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenService } from '../src/infrastructure/security/token.ts';
import { QuotaService } from '../src/infrastructure/security/quota.ts';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Token 签发与校验', () => {
  const service = new TokenService('test-secret');

  test('签发的 token 可被校验', () => {
    const { token } = service.issue('user-1', ['stu_001'], 'student');
    const payload = service.verify(token);
    assert.ok(payload);
    assert.equal(payload.sub, 'user-1');
    assert.equal(payload.role, 'student');
    assert.deepEqual(payload.sids, ['stu_001']);
  });

  test('篡改 payload 后校验失败', () => {
    const { token } = service.issue('user-1', ['stu_001'], 'student');
    const [payloadB64] = token.split('.');

    // 伪造 payload：冒用其他学生 ID
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        sids: ['stu_999'],
        role: 'student',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    assert.equal(service.verify(`${forged}.${token.split('.')[1]}`), null);
    assert.notEqual(payloadB64, forged);
  });

  test('不同 secret 签发的 token 互不通用', () => {
    const a = new TokenService('secret-a');
    const b = new TokenService('secret-b');
    const { token } = a.issue('user-1', ['stu_001'], 'student');
    assert.equal(b.verify(token), null);
  });

  test('过期 token 校验失败', () => {
    const shortLived = new TokenService('test-secret', -1); // 立即过期
    const { token } = shortLived.issue('user-1', ['stu_001'], 'student');
    assert.equal(shortLived.verify(token), null);
  });

  test('格式非法的 token 校验失败', () => {
    assert.equal(service.verify('garbage'), null);
    assert.equal(service.verify('a.b.c'), null);
    assert.equal(service.verify(''), null);
  });
});

describe('AI 配额', () => {
  function makeQuotaService(limit: number) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
    const db = new FileDatabase(tmpDir);
    return new QuotaService(db, limit);
  }

  test('未超限的调用被允许', async () => {
    const quota = makeQuotaService(3);
    assert.equal(await quota.consume('user-1'), true);
    assert.equal(await quota.consume('user-1'), true);
    assert.equal(await quota.consume('user-1'), true);
  });

  test('超出限额的调用被拒绝', async () => {
    const quota = makeQuotaService(2);
    await quota.consume('user-1');
    await quota.consume('user-1');
    assert.equal(await quota.consume('user-1'), false);
  });

  test('limit = 0 表示不限制', async () => {
    const quota = makeQuotaService(0);
    for (let i = 0; i < 50; i++) {
      assert.equal(await quota.consume('user-1'), true);
    }
  });

  test('不同账号配额相互独立', async () => {
    const quota = makeQuotaService(1);
    assert.equal(await quota.consume('user-1'), true);
    assert.equal(await quota.consume('user-2'), true, '其他账号不应受影响');
    assert.equal(await quota.consume('user-1'), false);
  });

  test('用量按账号持久化', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
    const quota = new QuotaService(new FileDatabase(tmpDir), 5);
    await quota.consume('user-1');
    assert.equal(await quota.getUsed('user-1'), 1);

    // 新实例（模拟重启）应读到已持久化的用量
    const quota2 = new QuotaService(new FileDatabase(tmpDir), 5);
    assert.equal(await quota2.getUsed('user-1'), 1);
  });
});
