/**
 * Job 类型定义。
 *
 * 分离后试卷诊断等耗时操作转为异步任务。
 * 设计约束（承接原设计文档 §5）：
 * - 任务持久化到磁盘（重启后可恢复）
 * - 幂等键防重复执行
 * - 失败重试 + 指数退避
 * - 任务租约 + 异常恢复
 * - 优雅退出
 */

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface Job<TInput = unknown, TOutput = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  input: TInput;
  output?: TOutput;
  error?: string;

  /** 已尝试次数 */
  attempts: number;
  /** 最大尝试次数（含首次） */
  maxAttempts: number;

  /** 幂等键：相同 key 的任务不会重复创建 */
  idempotencyKey?: string;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** 下次重试时间（退避） */
  nextRetryAt?: string;

  /** 租约持有者与到期时间 —— 用于异常恢复 */
  lease?: {
    owner: string;
    expiresAt: string;
  };

  /** 进度事件（供 SSE 推送） */
  progress?: {
    stage: string;
    pct: number;
    message?: string;
  };
}

export interface JobContext {
  jobId: string;
  /** 上报进度（会推送给 SSE 订阅者） */
  reportProgress(stage: string, pct: number, message?: string): void;
  /** 检查是否已被取消（长任务应定期检查） */
  isCancelled(): Promise<boolean>;
  signal: AbortSignal;
}

export interface JobHandler<TInput = unknown, TOutput = unknown> {
  execute(input: TInput, context: JobContext): Promise<TOutput>;
}

/** 任务被取消时抛出，Handler 应据此中止 */
export class JobCancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'JobCancelledError';
  }
}
