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

  /**
   * 回归：并发入队时幂等性必须成立。
   *
   * 历史缺陷：`enqueue` 的「查已存在 → 建任务 → 记映射」三步之间有
   * `await persist()`，并发调用同一 idempotencyKey 时，
   * 多个调用**全部**通过存在性检查，各自建出一个任务。
   *
   * 实测：同一 key 并发 10 次 → 产生 **10 个任务**（磁盘上也是 10 个文件）。
   *
   * 后果：客户端重试会触发多次昂贵的 AI 诊断，
   * 且前端收到多个 jobId，状态推流错乱。
   */
  test('并发使用同一幂等键只产生一个任务（回归）', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.enqueue('echo', { v: 1 }, { idempotencyKey: 'concurrent-key' })
      )
    );

    assert.equal(
      new Set(ids).size,
      1,
      `同一幂等键的并发入队应只产生一个任务，实际 ${new Set(ids).size} 个`
    );
  });

  test('并发入队在磁盘上也只有一个任务文件（回归）', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    // 用一个独有的 key，便于在共享的 tmpDir 里精确定位它的文件
    const key = 'disk-key-unique';
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        engine.enqueue('echo', {}, { idempotencyKey: key })
      )
    );
    assert.equal(new Set(ids).size, 1);

    // 读磁盘上的任务，只数属于这个 key 的
    const jobIds = new Set(ids);
    const files = fs.readdirSync(path.join(tmpDir, 'db', 'jobs'));
    const matching = files.filter((f) => jobIds.has(f.replace(/\.json$/, '')));
    assert.equal(
      matching.length,
      1,
      `磁盘上应只有一个对应任务文件，实际 ${matching.length} 个`
    );
  });

  test('并发使用不同幂等键各自产生任务', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        engine.enqueue('echo', {}, { idempotencyKey: `key-${i}` })
      )
    );

    assert.equal(new Set(ids).size, 5, '不同幂等键应各自产生任务');
  });

  test('无幂等键的并发入队各自独立（不共享锁）', async () => {
    engine.register('echo', {
      async execute() {
        return { ok: true };
      },
    });
    await engine.start();

    const ids = await Promise.all(
      Array.from({ length: 5 }, () => engine.enqueue('echo', {}))
    );

    assert.equal(new Set(ids).size, 5, '无幂等键时应各自创建任务');
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

  /**
   * 回归测试：进度事件必须按调用顺序推送。
   *
   * 历史缺陷：`reportProgress` 内部先 `await persist()`（磁盘写）再 emit，
   * 两次连续上报并发进入 await 时，谁先写完谁先 emit，
   * 导致 SSE 进度乱序（30% → 70% → 30%），前端进度条来回跳动。
   *
   * 修复：同任务的进度上报串行化（FIFO），且 done 事件在进度全部推送后触发。
   */
  test('连续进度上报严格按调用顺序推送，不乱序', async () => {
    const STAGES = ['第一步', '第二步', '第三步', '第四步', '第五步'];

    engine.register('ordered-progress', {
      async execute(_input: unknown, ctx: JobContext) {
        // 不 await：模拟真实 handler 的「即发即忘」调用方式
        for (const stage of STAGES) {
          ctx.reportProgress(stage, STAGES.indexOf(stage) * 20 + 10);
        }
        return { ok: true };
      },
    });

    const events: Array<{ type: string; stage?: string; pct?: number }> = [];

    await engine.start();
    const jobId = await engine.enqueue('ordered-progress', {});
    engine.subscribe(jobId, (event) => {
      events.push({ type: event.type, stage: event.stage, pct: event.pct });
    });

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });
    assert.ok(ok, '任务应成功完成');

    // 等最后一条事件到达
    await waitFor(() => events.some((e) => e.type === 'done'));

    const progressStages = events
      .filter((e) => e.type === 'progress')
      .map((e) => e.stage);

    assert.deepEqual(
      progressStages,
      STAGES,
      '进度事件必须严格按上报顺序推送'
    );

    // pct 也必须单调递增
    const pcts = events.filter((e) => e.type === 'progress').map((e) => e.pct ?? 0);
    for (let i = 1; i < pcts.length; i++) {
      assert.ok(
        pcts[i] > pcts[i - 1],
        `pct 应单调递增，实际 ${JSON.stringify(pcts)}`
      );
    }

    // done 必须排在最后一条 progress 之后
    const lastProgressIndex = events.findLastIndex((e) => e.type === 'progress');
    const doneIndex = events.findIndex((e) => e.type === 'done');
    assert.ok(doneIndex > lastProgressIndex, 'done 事件应在所有进度事件之后');
  });

  test('进度上报失败不影响任务本身', async () => {
    engine.register('progress-then-fail', {
      async execute(_input: unknown, ctx: JobContext) {
        ctx.reportProgress('第一步', 30);
        throw new Error('业务失败');
      },
    });

    await engine.start();
    const jobId = await engine.enqueue('progress-then-fail', {});

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'FAILED' || job?.status === 'PENDING';
    });
    assert.ok(ok, '任务应进入失败或重试状态');
  });

  /**
   * 确定性回归测试：**注入**竞态，证明顺序保证来自引擎本身，而非时序运气。
   *
   * 手法：包装引擎内部的 `reportProgress`，让**第一次**上报多等一段时间。
   * 若引擎不做串行化，后发的第二次上报会抢先 emit，顺序必然倒置。
   *
   * 为什么必须注入而不是「多跑几次碰运气」：
   * 竞态是否显现取决于磁盘写完成的相对时机，天然不稳定——
   * 一个只在 70% 概率下失败的测试，等于没有测试。
   */
  test('进度上报被拖慢时，事件顺序仍按调用顺序（注入竞态）', async () => {
    const slowEngine = new JobEngine(db, {
      concurrency: 2,
      pollIntervalMs: 50,
      backoffBaseMs: 100,
      leaseMs: 1000,
    });

    // 包装内部实现：第一次上报额外等待 100ms，制造「后发先至」的窗口
    const internal = slowEngine as unknown as {
      reportProgress: (job: unknown, stage: string, pct: number) => Promise<void>;
    };
    const originalReport = internal.reportProgress.bind(slowEngine);
    let callCount = 0;
    internal.reportProgress = async (job: unknown, stage: string, pct: number) => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await originalReport(job, stage, pct);
    };

    slowEngine.register('slow-progress', {
      async execute(_input: unknown, ctx: JobContext) {
        ctx.reportProgress('第一步', 30);
        ctx.reportProgress('第二步', 70);
        ctx.reportProgress('第三步', 90);
        return { ok: true };
      },
    });

    const events: Array<{ type: string; stage?: string }> = [];
    await slowEngine.start();
    const jobId = await slowEngine.enqueue('slow-progress', {});
    slowEngine.subscribe(jobId, (event) => {
      events.push({ type: event.type, stage: event.stage });
    });

    const ok = await waitFor(async () => {
      const job = await slowEngine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });
    assert.ok(ok, '任务应成功完成');
    await waitFor(() => events.some((e) => e.type === 'done'));

    const stages = events.filter((e) => e.type === 'progress').map((e) => e.stage);
    assert.deepEqual(
      stages,
      ['第一步', '第二步', '第三步'],
      '即使首次上报被拖慢，进度事件顺序也必须稳定'
    );

    await slowEngine.stop();
  });

  /**
   * 高频进度上报的顺序稳定性。
   *
   * 真实场景（如试卷诊断）会在短时间内连续上报多次进度。
   * 未修复时：10 次里约 7 次乱序（如 s0,s2,s3,s1,...）。
   * 修复后：顺序必须始终稳定。
   */
  test('连续 20 次进度上报顺序始终稳定', async () => {
    const STAGES = Array.from({ length: 20 }, (_, i) => `阶段${i}`);

    engine.register('many-progress', {
      async execute(_input: unknown, ctx: JobContext) {
        for (const stage of STAGES) {
          ctx.reportProgress(stage, 0);
        }
        return { ok: true };
      },
    });

    const events: Array<{ type: string; stage?: string }> = [];
    await engine.start();
    const jobId = await engine.enqueue('many-progress', {});
    engine.subscribe(jobId, (event) => {
      events.push({ type: event.type, stage: event.stage });
    });

    const ok = await waitFor(async () => {
      const job = await engine.getJob(jobId);
      return job?.status === 'SUCCEEDED';
    });
    assert.ok(ok, '任务应成功完成');
    await waitFor(() => events.some((e) => e.type === 'done'));

    const stages = events.filter((e) => e.type === 'progress').map((e) => e.stage);
    assert.deepEqual(stages, STAGES, '高频进度上报也必须严格有序');
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
