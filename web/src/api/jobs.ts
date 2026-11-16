/**
 * 后台任务 API（含 SSE 订阅）。
 *
 * 分离后试卷诊断改为异步：提交 → 拿 jobId → 订阅 SSE 进度。
 */
import { api } from './client.ts';
import { getToken } from '../store/auth.ts';

export interface JobProgress {
  stage: string;
  pct: number;
  message?: string;
}

export interface Job {
  id: string;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  maxAttempts: number;
  progress?: JobProgress;
  error?: string;
  output?: unknown;
  createdAt: string;
  completedAt?: string;
}

export interface EnqueueDiagnosisResponse {
  mode: 'async';
  jobId: string;
  status: string;
  streamUrl: string;
}

export interface DiagnosisJobHandlers {
  onProgress?: (progress: JobProgress) => void;
  onDone?: (job: Job) => void;
  onError?: (message: string) => void;
  onRetry?: (message: string, retryAt?: string) => void;
  onCancelled?: () => void;
}

/**
 * 订阅任务 SSE 进度。
 *
 * 返回取消订阅函数。
 *
 * 说明：EventSource 不支持自定义 header，因此这里用 fetch + ReadableStream
 * 手动解析 SSE 帧，从而能带上 Authorization 头。
 */
export function subscribeJob(
  jobId: string,
  handlers: DiagnosisJobHandlers
): () => void {
  const controller = new AbortController();
  const token = getToken();

  void (async () => {
    try {
      const response = await fetch(`/api/v1/jobs/${jobId}/events`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        handlers.onError?.(`订阅任务进度失败（HTTP ${response.status}）`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔帧
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          handleFrame(frame, handlers);
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      handlers.onError?.(
        err instanceof Error ? err.message : '订阅任务进度失败'
      );
    }
  })();

  return () => controller.abort();
}

function handleFrame(
  frame: string,
  handlers: DiagnosisJobHandlers
): void {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (event) {
    case 'progress':
      handlers.onProgress?.({
        stage: String(payload.stage ?? ''),
        pct: Number(payload.pct ?? 0),
        message: payload.message ? String(payload.message) : undefined,
      });
      break;
    case 'done':
      handlers.onDone?.(payload.job as Job);
      break;
    case 'error':
      handlers.onError?.(String(payload.message ?? '任务失败'));
      break;
    case 'retry':
      handlers.onRetry?.(
        String(payload.message ?? ''),
        payload.retryAt ? String(payload.retryAt) : undefined
      );
      break;
    case 'cancelled':
      handlers.onCancelled?.();
      break;
    default:
      break;
  }
}

/** 轮询降级路径（不支持 SSE 的环境） */
export async function pollJob(
  jobId: string,
  onProgress?: (progress: JobProgress) => void
): Promise<Job> {
  for (;;) {
    const job = await api.get<Job>(`/api/v1/jobs/${jobId}`);
    if (job.progress && onProgress) onProgress(job.progress);

    if (job.status === 'SUCCEEDED') return job;
    if (job.status === 'FAILED') {
      throw new Error(job.error ?? '任务失败');
    }
    if (job.status === 'CANCELLED') {
      throw new Error('任务已取消');
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
