/**
 * 后台任务 API 契约。
 *
 * 分离后试卷诊断等耗时操作转为异步 Job + SSE 进度推送。
 */

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  input?: unknown;
  output?: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  error?: string;
}

export interface JobProgressEvent {
  stage: string;
  pct: number;
  message?: string;
}

export function parseJob(raw: unknown): Job | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.status !== 'string') return null;
  return r as unknown as Job;
}
