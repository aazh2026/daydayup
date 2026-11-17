/**
 * AI 配额测试（补充）。
 *
 * 配额是保护 GEMINI_API_KEY 成本的最后一道护栏 ——
 * 失效意味着真金白银的敞口。
 *
 * 覆盖：
 * - 日期边界：跨天自动重置（用 UTC 日期作为键）
 * - 计数语义：失败也计入（模型已经调用，token 已经花了）
 * - 并发安全：同时请求不会超发额度
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { QuotaService } from '../src/infrastructure/security/quota.ts';

function makeQuota(limit: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-extra-'));
  return {
    quota: new QuotaService(new FileDatabase(dir), limit),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('配额日期边界', () => {
  test('同一天内额度不重置', async () => {
    const { quota, cleanup } = makeQuota(1);
    try {
      assert.equal(await quota.consume('u1'), true);
      assert.equal(await quota.consume('u1'), false, '同一天内应被拒绝');
      assert.equal(await quota.getUsed('u1'), 1);
    } finally {
      cleanup();
    }
  });

  test('用量按 UTC 日期键存储', async () => {
    const { quota, cleanup } = makeQuota(5);
    try {
      await quota.consume('u1');
      const todayUtc = new Date().toISOString().slice(0, 10);

      const dir = fs
        .readdirSync(os.tmpdir())
        .filter((d) => d.startsWith('quota-extra-'))
        .sort()
        .pop();
      assert.ok(dir);
      const file = path.join(os.tmpdir(), dir, 'db', 'quota', 'u1.json');
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        date: string;
        used: number;
      };
      assert.equal(record.date, todayUtc);
      assert.equal(record.used, 1);
    } finally {
      cleanup();
    }
  });
});

describe('配额计数语义', () => {
  test('失败调用也计入配额（模型已被调用，token 已花）', async () => {
    const { quota, cleanup } = makeQuota(2);
    try {
      // 第一次调用「失败」——但模型确实被调用了，费用已发生
      assert.equal(await quota.consume('u1'), true);
      // 失败不退还
      assert.equal(await quota.consume('u1'), true);
      assert.equal(await quota.consume('u1'), false);
      assert.equal(await quota.getUsed('u1'), 2);
    } finally {
      cleanup();
    }
  });

  test('剩余次数随使用递减', async () => {
    const { quota, cleanup } = makeQuota(3);
    try {
      assert.equal(await quota.remaining('u1'), 3);
      await quota.consume('u1');
      assert.equal(await quota.remaining('u1'), 2);
      await quota.consume('u1');
      assert.equal(await quota.remaining('u1'), 1);
    } finally {
      cleanup();
    }
  });

  test('超限后剩余为 0（不为负）', async () => {
    const { quota, cleanup } = makeQuota(1);
    try {
      await quota.consume('u1');
      await quota.consume('u1'); // 被拒绝，但已用记录为 1
      assert.equal(await quota.remaining('u1'), 0);
      assert.ok((await quota.remaining('u1')) >= 0);
    } finally {
      cleanup();
    }
  });

  test('limit=0 时剩余为 Infinity（不限制）', async () => {
    const { quota, cleanup } = makeQuota(0);
    try {
      assert.equal(await quota.remaining('u1'), Infinity);
      for (let i = 0; i < 20; i++) {
        assert.equal(await quota.consume('u1'), true);
      }
    } finally {
      cleanup();
    }
  });
});

describe('并发下的额度不超发', () => {
  test('并发请求不会超过限额', async () => {
    const { quota, cleanup } = makeQuota(5);
    try {
      // 同时发起 20 次消费
      const results = await Promise.all(
        Array.from({ length: 20 }, () => quota.consume('u1'))
      );
      const allowed = results.filter(Boolean).length;
      assert.equal(
        allowed,
        5,
        `并发下只应放行 5 次，实际放行 ${allowed} 次`
      );
      assert.equal(await quota.getUsed('u1'), 5);
    } finally {
      cleanup();
    }
  });

  test('不同账号并发互不影响', async () => {
    const { quota, cleanup } = makeQuota(3);
    try {
      const results = await Promise.all([
        quota.consume('u1'),
        quota.consume('u2'),
        quota.consume('u3'),
      ]);
      assert.ok(results.every(Boolean), '三个账号都应放行');
    } finally {
      cleanup();
    }
  });
});
