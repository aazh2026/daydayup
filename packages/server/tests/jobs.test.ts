/**
 * Job Engine 测试。
 *
 * 覆盖：持久化、幂等、重试退避、取消、租约恢复、进度事件、优雅退出。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobEngine } from '../src/infrastructure/jobs/job-engine.ts';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { JobCancelledError, type JobContext } from '../src/infrastructure/jobs/job-types.ts';

let tmpDir: string;
let db: FileDatabase;
let engine: JobEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
  db = new FileDatabase(tmpDir);
  engine = new JobEngine(db, {
    concurrency: 2,
    pollIntervalMs: 50,
    backoffBaseMs: 100,
    leaseMs: 1000,
  });
});

afterEach(async () => {
  await engine.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 等待条件成立 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('Job Engine 基础执行', () => {
  test('注册的任务被执行并保存输出', async () => {
    engine.register('echo', {
      async execute(input: { value: string }) {
        return { echoed: input.value };
      },
    });

    await engine.start();
    const jobId = await engine.enqueue('echo', { value: 'hello' });

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });
    assert.ok(ok, '任务应在超时前完成');

    const job = await engine.getJob(jobId);
    assert.equal(job?.status, 'SUCCEEDED');
    assert.deepEqual(job?.output, { echoed: 'hello' });
    assert.ok(job?.completedAt);
  });

  test('未注册的任务类型被拒绝', async () => {
    await engine.start();
    await assert.rejects(
      () => engine.enqueue('unknown-type', {}),
      /未注册的任务类型/
    );
  });

  test('任务持久化到磁盘（可跨实例读取）', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();
    const jobId = await engine.enqueue('echo', {});

    await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });

    // 用新的 FileDatabase 实例读取（模拟重启）
    const db2 = new FileDatabase(tmpDir);
    const persisted = await db2.read<{ status: string }>([
      'db',
      'jobs',
      `${jobId}.json`,
    ]);
    assert.equal(persisted?.status, 'SUCCEEDED');
  });
});

describe('Job Engine 幂等', () => {
  test('相同幂等键返回同一任务', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    const first = await engine.enqueue('echo', { v: 1 }, { idempotencyKey: 'k1' });
    const second = await engine.enqueue('echo', { v: 1 }, { idempotencyKey: 'k1' });

    assert.equal(first, second, '相同幂等键应返回同一任务 ID');
  });

  test('不同幂等键返回不同任务', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    const a = await engine.enqueue('echo', {}, { idempotencyKey: 'k1' });
    const b = await engine.enqueue('echo', {}, { idempotencyKey: 'k2' });
    assert.notEqual(a, b);
  });
});

describe('Job Engine 失败重试', () => {
  test('失败后重试并最终成功', async () => {
    let attempts = 0;
    engine.register('flaky', {
      async execute() {
        attempts++;
        if (attempts < 3) throw new Error('临时故障');
        return { ok: true, attempts };
      },
    });

    await engine.start();
    const jobId = await engine.enqueue('flaky', {}, { maxAttempts: 5 });

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    }, 8000);

    assert.ok(ok, '重试后应成功');
    const job = await engine.getJob(jobId);
    assert.equal(job?.status, 'SUCCEEDED');
    assert.equal(job?.attempts, 3);
  });

  test('超过最大尝试次数后标记为 FAILED', async () => {
    engine.register('always-fail', {
      async execute() {
        throw new Error('持续失败');
      },
    });

    await engine.start();
    const jobId = await engine.enqueue('always-fail', {}, { maxAttempts: 2 });

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'FAILED';
    }, 8000);

    assert.ok(ok, '应最终失败');
    const job = await engine.getJob(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.match(job?.error ?? '', /持续失败/);
    assert.equal(job?.attempts, 2);
  });
});

describe('Job Engine 取消', () => {
  test('运行中的任务可被取消', async () => {
    engine.register('slow', {
      async execute(_input: unknown, ctx: JobContext) {
        // 循环中检查取消标志
        for (let i = 0; i < 200; i++) {
          if (await ctx.isCancelled()) throw new JobCancelledError();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { ok: true };
      },
    });

    await engine.start();
    const jobId = await engine.enqueue('slow', {});

    await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'RUNNING';
    });

    await engine.cancel(jobId);

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'CANCELLED';
    }, 5000);

    assert.ok(ok, '任务应被取消');
  });

  test('待执行的任务可被取消', async () => {
    engine.register('noop', {
      async execute() {
        return { ok: true };
      },
    });

    // 不启动引擎，任务保持 PENDING
    const jobId = await engine.enqueue('noop', {});
    await engine.cancel(jobId);

    const job = await engine.getJob(jobId);
    assert.equal(job?.status, 'CANCELLED');
  });
});

describe('Job Engine 进度事件', () => {
  test('进度变化通过订阅推送', async () => {
    engine.register('with-progress', {
      async execute(_input: unknown, ctx: JobContext) {
        ctx.reportProgress('第一步', 30);
        ctx.reportProgress('第二步', 70);
        return { ok: true };
      },
    });

    const events: Array<{ type: string; pct?: number; stage?: string }> = [];

    await engine.start();
    const jobId = await engine.enqueue('with-progress', {});

    const unsubscribe = engine.subscribe(jobId, (event) => {
      events.push({ type: event.type, pct: event.pct, stage: event.stage });
    });

    await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });
    unsubscribe();

    const progressEvents = events.filter((e) => e.type === 'progress');
    assert.ok(progressEvents.length >= 2, '应收到至少 2 个进度事件');
    assert.equal(progressEvents[0].stage, '第一步');
    assert.equal(progressEvents[0].pct, 30);

    assert.ok(events.some((e) => e.type === 'done'), '应收到完成事件');
  });
});

describe('Job Engine 异常恢复', () => {
  test('租约过期的 RUNNING 任务被重新入队', async () => {
    // 模拟进程崩溃：手工写一个带过期租约的 RUNNING 任务
    const jobId = 'job_orphan_test';
    await db.write(['db', 'jobs', `${jobId}.json`], {
      id: jobId,
      type: 'recoverable',
      status: 'RUNNING',
      input: {},
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lease: {
        owner: 'pid-crashed',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    let executed = false;
    engine.register('recoverable', {
      async execute() {
        executed = true;
        return { recovered: true };
      },
    });

    await engine.start();

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    }, 5000);

    assert.ok(ok, '孤儿任务应被恢复并执行');
    assert.ok(executed);
  });

  test('租约未过期的 RUNNING 任务不被抢占', async () => {
    const jobId = 'job_active_test';
    await db.write(['db', 'jobs', `${jobId}.json`], {
      id: jobId,
      type: 'not-recovered',
      status: 'RUNNING',
      input: {},
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      lease: {
        owner: 'pid-active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    let executed = false;
    engine.register('not-recovered', {
      async execute() {
        executed = true;
        return {};
      },
    });

    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(executed, false, '活跃任务不应被抢占');
  });
});

describe('Job Engine 并发控制', () => {
  test('并发数不超过配置上限', async () => {
    let active = 0;
    let maxActive = 0;

    engine.register('concurrent', {
      async execute() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active--;
        return { ok: true };
      },
    });

    await engine.start();
    for (let i = 0; i < 6; i++) {
      await engine.enqueue('concurrent', {});
    }

    await waitFor(async () => {
      const jobs = await engine.list();
      return jobs.every((j) => j.status === 'SUCCEEDED');
    }, 8000);

    assert.ok(maxActive <= 2, `并发数 ${maxActive} 超过上限 2`);
  });
});
