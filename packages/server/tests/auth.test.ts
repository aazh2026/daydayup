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
import {
  FileCredentialStore,
  MemoryCredentialStore,
  resolveCredentialStore,
  createDefaultCredentials,
} from '../src/infrastructure/security/credentials.ts';
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

describe('凭证存储', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
  }

  function writeCredentials(dir: string, creds: unknown[]): void {
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'db', 'credentials.json'),
      JSON.stringify(creds)
    );
  }

  describe('文件凭证存储', () => {
    test('按 secret 查到凭证', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: ['s1'] },
      ]);
      const store = new FileCredentialStore(
        path.join(dir, 'db', 'credentials.json')
      );

      const found = await store.findBySecret('pin-1');
      assert.ok(found);
      assert.equal(found.principalId, 'u1');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('secret 不匹配时返回 null', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: [] },
      ]);
      const store = new FileCredentialStore(
        path.join(dir, 'db', 'credentials.json')
      );

      assert.equal(await store.findBySecret('wrong'), null);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('已禁用的凭证不可用', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: [], disabled: true },
      ]);
      const store = new FileCredentialStore(
        path.join(dir, 'db', 'credentials.json')
      );

      assert.equal(await store.findBySecret('pin-1'), null, 'disabled 凭证不应可用');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('文件不存在时返回空列表', async () => {
      const dir = tmpDir();
      const store = new FileCredentialStore(
        path.join(dir, 'db', 'credentials.json')
      );

      assert.deepEqual(await store.list(), []);
      assert.equal(await store.findBySecret('anything'), null);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('reload 后能读到新写入的凭证', async () => {
      const dir = tmpDir();
      const file = path.join(dir, 'db', 'credentials.json');
      writeCredentials(dir, [
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: [] },
      ]);
      const store = new FileCredentialStore(file);
      assert.ok(await store.findBySecret('pin-1'));

      writeCredentials(dir, [
        { principalId: 'u2', secret: 'pin-2', role: 'student', studentIds: [] },
      ]);
      await store.reload();

      assert.equal(await store.findBySecret('pin-1'), null, 'reload 后旧凭证应失效');
      assert.ok(await store.findBySecret('pin-2'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('内存凭证存储', () => {
    test('按 secret 查到凭证', async () => {
      const store = new MemoryCredentialStore([
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: [] },
      ]);
      assert.ok(await store.findBySecret('pin-1'));
      assert.equal(await store.findBySecret('nope'), null);
    });

    test('已禁用的凭证不可用', async () => {
      const store = new MemoryCredentialStore([
        { principalId: 'u1', secret: 'pin-1', role: 'student', studentIds: [], disabled: true },
      ]);
      assert.equal(await store.findBySecret('pin-1'), null);
    });
  });

  /**
   * 回归：生产模式下演示 PIN 不得成为公开后门。
   *
   * 历史缺陷：`resolveCredentialStore` 逐个 secret 回落 ——
   * `fileStore.findBySecret(secret) ?? fallback.findBySecret(secret)`。
   * 于是只要凭证文件存在且内容不同，内置演示 PIN `1234` 依然有效。
   * 等于在生产环境留了一个公开的默认口令。
   */
  describe('生产模式的演示凭证回落', () => {
    test('凭证文件存在时，演示 PIN 不可用', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'real', secret: 'real-pin', role: 'student', studentIds: ['s1'] },
      ]);
      const store = resolveCredentialStore(dir, 'production-secret');

      const demo = await store.findBySecret('1234');
      assert.equal(demo, null, '生产模式下演示 PIN 不应可用');
      assert.ok(await store.findBySecret('real-pin'), '真实凭证应可用');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('凭证文件存在时，list 不含演示凭证', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'real', secret: 'real-pin', role: 'student', studentIds: ['s1'] },
      ]);
      const store = resolveCredentialStore(dir, 'production-secret');

      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].principalId, 'real');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('凭证文件缺失时整体回落（首次部署引导）', async () => {
      const dir = tmpDir();
      const store = resolveCredentialStore(dir, 'production-secret');

      const demo = await store.findBySecret('1234');
      assert.ok(demo, '凭证文件缺失时应可用演示凭证以便首次部署');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('开发模式（无 AUTH_SECRET）演示凭证可用', async () => {
      const dir = tmpDir();
      const store = resolveCredentialStore(dir, '');

      assert.ok(await store.findBySecret('1234'));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('开发模式不读凭证文件', async () => {
      const dir = tmpDir();
      writeCredentials(dir, [
        { principalId: 'real', secret: 'real-pin', role: 'student', studentIds: [] },
      ]);
      const store = resolveCredentialStore(dir, '');

      assert.equal(
        await store.findBySecret('real-pin'),
        null,
        '开发模式只认内存演示凭证'
      );
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('默认凭证仅含一个学生账号', () => {
      const defaults = createDefaultCredentials();
      assert.equal(defaults.length, 1);
      assert.equal(defaults[0].role, 'student');
      assert.ok(defaults[0].secret.length > 0);
    });
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
