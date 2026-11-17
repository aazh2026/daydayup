/**
 * Job Engine —— 轻量异步任务引擎（不引入 MQ）。
 *
 * 特性：
 * - 任务持久化到磁盘（重启后未完成任务可恢复）
 * - 幂等键：相同 key 不会重复创建任务
 * - 指数退避重试
 * - 任务租约：进程崩溃后任务不会永久卡在 RUNNING
 * - 进度事件：供 SSE 推送
 * - 优雅退出：停止接收新任务，等待进行中任务完成
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FileDatabase } from '../persistence/file-database.ts';
import { logger } from '../logging/logger.ts';
import {
  JobCancelledError,
  type Job,
  type JobContext,
  type JobHandler,
  type JobStatus,
} from './job-types.ts';

const JOBS_DIR = ['db', 'jobs'];

export interface JobEngineOptions {
  /** 最大并发任务数 */
  concurrency?: number;
  /** 租约时长（毫秒）—— 超时视为进程崩溃，任务重新入队 */
  leaseMs?: number;
  /** 单次任务超时（毫秒） */
  jobTimeoutMs?: number;
  /** 轮询间隔（毫秒） */
  pollIntervalMs?: number;
  /** 退避基数（毫秒） */
  backoffBaseMs?: number;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  idempotencyKey?: string;
}

export class JobEngine extends EventEmitter {
  private handlers = new Map<string, JobHandler<any, any>>();
  private running = new Map<string, AbortController>();
  private cancelled = new Set<string>();
  private byIdempotencyKey = new Map<string, string>();
  private started = false;
  private stopping = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;

  /**
   * 每个任务的进度上报串行链。
   *
   * 为什么需要：`reportProgress` 内部先 `await persist()`（磁盘写）再 emit，
   * 若不加串行化，两次连续上报会并发进入 await，谁先完成就谁先 emit——
   * 导致 SSE 进度事件**乱序**（如 30% 之后先收到 70%，再收到 30%）。
   * 这会让前端的进度条来回跳动。
   *
   * 用 promise 链把同任务的进度上报排成 FIFO，
   * 保证「先调用的一定先推送」。
   */
  private progressChains = new Map<string, Promise<void>>();

  /**
   * 幂等键的串行锁链。
   *
   * 为什么需要：`enqueue` 的「查已存在 → 建任务 → 记映射」三步之间有
   * `await persist()`，并发调用同一 idempotencyKey 时，
   * 多个调用会**全部**通过存在性检查，各自建一个任务 ——
   * 幂等性在并发下彻底失效。
   *
   * 实测：同一 key 并发入队 10 次 → 产生 **10 个任务**。
   *
   * 后果：客户端重试会触发多次昂贵的 AI 诊断（真金白银），
   * 且前端会收到多个 jobId，状态推流错乱。
   */
  private idempotencyLocks = new Map<string, Promise<unknown>>();

  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly jobTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly backoffBaseMs: number;

  private readonly db: FileDatabase;

  constructor(db: FileDatabase, options: JobEngineOptions = {}) {
    super();
    this.db = db;
    this.concurrency = options.concurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 10 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.backoffBaseMs = options.backoffBaseMs ?? 5000;
  }

  register(type: string, handler: JobHandler<any, any>): void {
    this.handlers.set(type, handler);
  }

  /** 是否已注册某类型的 Handler */
  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  /** 启动调度循环 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;

    await this.recoverOrphanedJobs();
    this.scheduleNextTick();
    logger.info('jobs.started', {
      concurrency: this.concurrency,
      leaseMs: this.leaseMs,
    });
  }

  /** 优雅退出：等待进行中任务完成 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 等待进行中任务完成（最多 30s）
    const deadline = Date.now() + 30_000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logger.info('jobs.stopped', { remaining: this.running.size });
  }

  /**
   * 创建任务。
   *
   * @param type 任务类型（需已注册 Handler）
   * @param input 任务输入
   * @param options 幂等键、最大尝试次数
   */
  async enqueue<TInput>(
    type: string,
    input: TInput,
    options: EnqueueOptions = {}
  ): Promise<string> {
    if (!this.handlers.has(type)) {
      throw new Error(`未注册的任务类型: ${type}`);
    }

    // 幂等键：同一 key 的并发入队必须串行化，
    // 否则会各自建出任务（幂等性在并发下失效）。
    if (options.idempotencyKey) {
      return this.withIdempotencyLock(options.idempotencyKey, () =>
        this.enqueueLocked(type, input, options)
      );
    }
    return this.enqueueLocked(type, input, options);
  }

  /**
   * 幂等键的串行锁。
   *
   * 同 key 的调用排队执行，保证「查-建-记」三步原子化。
   */
  private async withIdempotencyLock<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.idempotencyLocks.set(key, previous.then(() => current));
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.idempotencyLocks.get(key) === current) {
        this.idempotencyLocks.delete(key);
      }
    }
  }

  /** enqueue 的实际逻辑（假定幂等性已由调用方保证） */
  private async enqueueLocked<TInput>(
    type: string,
    input: TInput,
    options: EnqueueOptions
  ): Promise<string> {
    // 幂等：相同 key 直接返回既有任务 ID
    if (options.idempotencyKey) {
      const existing = this.byIdempotencyKey.get(options.idempotencyKey);
      if (existing) {
        const job = await this.getJob(existing);
        if (job) return job.id;
      }
    }

    const id = `job_${randomUUID()}`;
    const job: Job<TInput> = {
      id,
      type,
      status: 'PENDING',
      input,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      idempotencyKey: options.idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    await this.persist(job);
    if (options.idempotencyKey) {
      this.byIdempotencyKey.set(options.idempotencyKey, id);
    }

    this.emit('job:created', job);
    // 立即尝试调度
    this.scheduleNextTick(0);
    return id;
  }

  async getJob(id: string): Promise<Job | null> {
    return this.db.read<Job>([...JOBS_DIR, `${id}.json`]);
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    const controller = this.running.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    // 未在运行：直接标记为已取消
    const job = await this.getJob(id);
    if (job && (job.status === 'PENDING' || job.status === 'RUNNING')) {
      job.status = 'CANCELLED';
      job.completedAt = new Date().toISOString();
      await this.persist(job);
      this.emit('job:updated', job);
    }
  }

  /**
   * 列出任务（按状态过滤）。
   */
  async list(status?: JobStatus): Promise<Job[]> {
    const ids = await this.db.list(JOBS_DIR);
    const jobs: Job[] = [];
    for (const fileId of ids) {
      const job = await this.db.read<Job>([
        ...JOBS_DIR,
        fileId.replace(/\.json$/, ''),
      ]);
      if (job && (!status || job.status === status)) jobs.push(job);
    }
    jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return jobs;
  }

  /** 订阅任务事件（供 SSE 使用） */
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    const handler = (event: JobEvent) => {
      if (event.jobId === jobId) listener(event);
    };
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }

  // ---- 内部实现 ----

  private async persist(job: Job): Promise<void> {
    await this.db.write([...JOBS_DIR, `${job.id}.json`], job);
  }

  /**
   * 恢复孤儿任务：进程崩溃时任务停留在 RUNNING 且租约已过期。
   */
  private async recoverOrphanedJobs(): Promise<void> {
    const ids = await this.db.list(JOBS_DIR);
    let recovered = 0;

    for (const fileId of ids) {
      const job = await this.db.read<Job>([
        ...JOBS_DIR,
        fileId.replace(/\.json$/, ''),
      ]);
      if (!job) continue;

      const leaseExpired =
        job.status === 'RUNNING' &&
        job.lease &&
        new Date(job.lease.expiresAt).getTime() < Date.now();

      if (leaseExpired) {
        job.status = 'PENDING';
        job.lease = undefined;
        job.error = '进程异常退出，任务已重新入队';
        await this.persist(job);
        recovered++;
        logger.warn('jobs.recovered', { jobId: job.id, type: job.type });
      }
    }

    if (recovered > 0) {
      logger.info('jobs.recovery_complete', { recovered });
    }
  }

  private scheduleNextTick(delay?: number): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.tick(),
      delay ?? this.pollIntervalMs
    );
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;

    // Tick 互斥：claimNextJob 含 await，期间可能有新的 tick 被触发
    // （enqueue 会调 scheduleNextTick(0)），不加锁会重复领取任务。
    if (this.ticking) {
      this.scheduleNextTick();
      return;
    }
    this.ticking = true;

    try {
      while (this.running.size < this.concurrency) {
        const job = await this.claimNextJob();
        if (!job) break;
        // 关键：先占用并发槽位再异步执行，
        // 否则 await 期间 running.size 未增加，会超出并发上限。
        const controller = new AbortController();
        this.running.set(job.id, controller);
        void this.execute(job, controller);
      }
    } catch (err) {
      logger.error('jobs.tick_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.ticking = false;
    }

    this.scheduleNextTick();
  }

  /** 领取一个待执行任务（加租约） */
  private async claimNextJob(): Promise<Job | null> {
    const ids = await this.db.list(JOBS_DIR);
    const now = Date.now();

    for (const fileId of ids) {
      const job = await this.db.read<Job>([
        ...JOBS_DIR,
        fileId.replace(/\.json$/, ''),
      ]);
      if (!job) continue;

      if (job.status !== 'PENDING') continue;
      if (job.nextRetryAt && new Date(job.nextRetryAt).getTime() > now) {
        continue;
      }

      job.status = 'RUNNING';
      job.startedAt = job.startedAt ?? new Date().toISOString();
      job.attempts += 1;
      job.lease = {
        owner: `pid-${process.pid}`,
        expiresAt: new Date(now + this.leaseMs).toISOString(),
      };
      await this.persist(job);
      this.emit('job:updated', job);
      return job;
    }

    return null;
  }

  private async execute(job: Job, controller: AbortController): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.running.delete(job.id);
      await this.failJob(job, `未注册的任务类型: ${job.type}`, true);
      return;
    }

    const timeoutTimer = setTimeout(() => controller.abort(), this.jobTimeoutMs);

    try {
      const context: JobContext = {
        jobId: job.id,
        reportProgress: (stage, pct, message) => {
          // 串行化：把本次上报挂到该任务的进度链尾部，
          // 保证同任务的进度事件按调用顺序推送（不乱序）。
          const previous = this.progressChains.get(job.id) ?? Promise.resolve();
          const next = previous
            .catch(() => undefined)
            .then(() => this.reportProgress(job, stage, pct, message))
            .catch((err) => {
              // 进度上报失败不应影响任务本身（只影响进度展示）
              logger.warn('jobs.progress_failed', {
                jobId: job.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          this.progressChains.set(job.id, next);
        },
        isCancelled: async () => this.cancelled.has(job.id),
        signal: controller.signal,
      };

      const output = await handler.execute(job.input, context);

      // 关键：等待所有排队中的进度事件推送完毕，
      // 否则 done 事件可能先于最后一条 progress 到达，
      // 订阅者会先收到「完成」再收到「99%」这种乱序。
      await this.drainProgress(job.id);

      if (this.cancelled.has(job.id)) {
        await this.cancelJob(job);
        return;
      }

      job.status = 'SUCCEEDED';
      job.output = output;
      job.completedAt = new Date().toISOString();
      job.lease = undefined;
      job.error = undefined;
      await this.persist(job);
      this.emit('job:updated', job);
      this.emit(`job:${job.id}`, { type: 'done', jobId: job.id, job });
      logger.info('jobs.succeeded', { jobId: job.id, type: job.type });
    } catch (err) {
      if (err instanceof JobCancelledError || this.cancelled.has(job.id)) {
        await this.cancelJob(job);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const canRetry = job.attempts < job.maxAttempts;

      if (canRetry) {
        // 指数退避
        const delay = Math.min(
          this.backoffBaseMs * 2 ** (job.attempts - 1),
          5 * 60 * 1000
        );
        job.status = 'PENDING';
        job.error = message;
        job.nextRetryAt = new Date(Date.now() + delay).toISOString();
        job.lease = undefined;
        await this.persist(job);
        this.emit('job:updated', job);
        this.emit(`job:${job.id}`, {
          type: 'retry',
          jobId: job.id,
          job,
          message,
          retryAt: job.nextRetryAt,
        });
        logger.warn('jobs.retry', {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          error: message,
        });
      } else {
        await this.failJob(job, message, false);
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.running.delete(job.id);
      this.cancelled.delete(job.id);
      // 释放进度链（任务已终结，不会再有新进度）
      this.progressChains.delete(job.id);
    }
  }

  /**
   * 等待某任务当前排队的进度事件全部推送完毕。
   */
  private async drainProgress(jobId: string): Promise<void> {
    const pending = this.progressChains.get(jobId);
    if (!pending) return;
    try {
      await pending;
    } catch {
      // 单次进度上报失败已在链内兜底，此处忽略
    }
  }

  private async reportProgress(
    job: Job,
    stage: string,
    pct: number,
    message?: string
  ): Promise<void> {
    job.progress = { stage, pct, message };
    await this.persist(job);
    this.emit('job:updated', job);
    this.emit(`job:${job.id}`, {
      type: 'progress',
      jobId: job.id,
      job,
      stage,
      pct,
      message,
    });
  }

  private async failJob(job: Job, message: string, terminal: boolean): Promise<void> {
    job.status = terminal ? 'FAILED' : 'FAILED';
    job.error = message;
    job.completedAt = new Date().toISOString();
    job.lease = undefined;
    await this.persist(job);
    this.emit('job:updated', job);
    this.emit(`job:${job.id}`, { type: 'error', jobId: job.id, job, message });
    logger.error('jobs.failed', { jobId: job.id, type: job.type, error: message });
  }

  private async cancelJob(job: Job): Promise<void> {
    job.status = 'CANCELLED';
    job.completedAt = new Date().toISOString();
    job.lease = undefined;
    await this.persist(job);
    this.emit('job:updated', job);
    this.emit(`job:${job.id}`, { type: 'cancelled', jobId: job.id, job });
    logger.info('jobs.cancelled', { jobId: job.id, type: job.type });
  }
}

export interface JobEvent {
  type: 'progress' | 'done' | 'error' | 'retry' | 'cancelled';
  jobId: string;
  job?: Job;
  stage?: string;
  pct?: number;
  message?: string;
  retryAt?: string;
}
