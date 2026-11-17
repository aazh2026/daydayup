/**
 * 并发写入的读-判-写原子性测试（回归）。
 *
 * ## 为什么重要
 *
 * 「读 → 判断 → 写」这类组合操作，若不整体串行化，
 * 并发请求会**各自读到同一个旧值**，再各自写回自己的版本 ——
 * 后写者覆盖先写者，先写者的数据被静默丢弃。
 *
 * 这类问题在串行测试里永远看不见：单请求路径完全正常。
 *
 * 实测（修复前）：5 个并发作答（5 个不同知识点）全部返回 200，
 * 但掌握度聚合里只剩 **1 条**记录 —— 4 个知识点的学习记录消失，
 * 接口没有任何报错。
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

const STUDENT_ID = 'stu-concurrent';

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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-concurrent-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'concurrent-test-secret';
  process.env.GEMINI_API_KEY = '';

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
  token = await login('student-key');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('并发作答不丢记录（回归）', () => {
  test('5 个并发作答保留全部 5 条掌握度记录', async () => {
    const knowledgeIds = ['kp-a', 'kp-b', 'kp-c', 'kp-d', 'kp-e'];

    const responses = await Promise.all(
      knowledgeIds.map((kid) =>
        fetch(
          `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/${kid}/attempt`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ mode: '基础练习', isCorrect: true }),
          }
        )
      )
    );

    for (const res of responses) {
      assert.equal(res.status, 200, '所有并发作答都应成功');
    }

    const aggregate = JSON.parse(
      fs.readFileSync(
        path.join(tmpDataDir, 'db', 'mastery', `${STUDENT_ID}.json`),
        'utf8'
      )
    ) as { records: Record<string, unknown> };

    assert.equal(
      Object.keys(aggregate.records).length,
      5,
      `并发作答后应保留 5 条记录，实际 ${Object.keys(aggregate.records).length} 条`
    );
    for (const kid of knowledgeIds) {
      assert.ok(aggregate.records[kid], `缺少记录: ${kid}`);
    }
  });

  test('并发作答的流水全部落盘', async () => {
    const attemptsDir = path.join(tmpDataDir, 'db', 'attempts', STUDENT_ID);
    const files = fs.readdirSync(attemptsDir);
    assert.equal(files.length, 1);

    const lines = fs
      .readFileSync(path.join(attemptsDir, files[0]), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    assert.equal(lines.length, 5, '作答流水应完整记录每次作答');
  });

  test('同一知识点并发作答不丢计数', async () => {
    const kid = 'kp-same';
    await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(
          `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/${kid}/attempt`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ mode: '基础练习', isCorrect: false }),
          }
        )
      )
    );

    const aggregate = JSON.parse(
      fs.readFileSync(
        path.join(tmpDataDir, 'db', 'mastery', `${STUDENT_ID}.json`),
        'utf8'
      )
    ) as {
      records: Record<string, { practiceTotal: number; consecutiveErrors: number }>;
    };

    const record = aggregate.records[kid];
    assert.ok(record, '记录应存在');
    assert.equal(
      record.practiceTotal,
      5,
      `5 次并发作答应累计 5 次，实际 ${record.practiceTotal}`
    );
    assert.equal(
      record.consecutiveErrors,
      5,
      `连续错误数应累计为 5，实际 ${record.consecutiveErrors}`
    );
  });
});

describe('withExclusive 排他锁', () => {
  test('同键的临界区串行执行', async () => {
    const order: string[] = [];
    const db = container.db;

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.withExclusive('test-key', async () => {
          order.push(`enter-${i}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`exit-${i}`);
        })
      )
    );

    // 每个 enter 必须紧跟自己的 exit（不能交错）
    for (let i = 0; i < order.length; i += 2) {
      assert.equal(order[i].replace('enter', ''), order[i + 1].replace('exit', ''));
    }
  });

  test('不同键互不阻塞', async () => {
    let running = 0;
    let maxConcurrent = 0;

    await Promise.all(
      ['k1', 'k2', 'k3'].map((key) =>
        container.db.withExclusive(key, async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 10));
          running -= 1;
        })
      )
    );

    assert.ok(maxConcurrent > 1, '不同键应能并行');
  });

  test('临界区抛错不阻塞后续调用', async () => {
    await assert.rejects(() =>
      container.db.withExclusive('err-key', async () => {
        throw new Error('boom');
      })
    );

    let ran = false;
    await container.db.withExclusive('err-key', async () => {
      ran = true;
    });
    assert.equal(ran, true, '抛错后锁应被释放');
  });
});
