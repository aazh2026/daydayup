/**
 * API 客户端层。
 *
 * 现状痛点：各组件直接 `fetch('/api/xxx')`，错误处理各自为政
 * （`throw new Error(data.error || 'AI教练响应失败')`），无法区分
 * 「模型超时该重试」与「参数错误该改 UI」。
 *
 * 本模块统一：超时、错误标准化、错误码透出。
 */
import { isApiErrorResponse, type ApiErrorCode } from '@daydayup/contracts';
import { getToken, notifyAuthExpired } from '../store/auth.ts';

const BASE_URL = import.meta.env.VITE_API_BASE ?? '';

export class ApiRequestError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'CONTRACT_MISMATCH',
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** 是否值得自动重试 */
  get isRetryable(): boolean {
    return (
      this.code === 'AI_TIMEOUT' ||
      this.code === 'NETWORK_ERROR' ||
      this.code === 'INTERNAL_ERROR'
    );
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.retries ?? (method === 'GET' ? 2 : 0);

  let lastError: ApiRequestError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // 外部 signal 联动
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort);

    try {
      const token = getToken();
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed: unknown = undefined;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
      }

      if (!response.ok) {
        if (isApiErrorResponse(parsed)) {
          // 401：令牌失效或缺失 —— 通知 UI 层跳转登录
          if (parsed.error.code === 'UNAUTHORIZED') {
            notifyAuthExpired();
          }
          throw new ApiRequestError(
            parsed.error.code,
            parsed.error.message,
            response.status,
            parsed.error.details,
            parsed.requestId
          );
        }
        throw new ApiRequestError(
          'INTERNAL_ERROR',
          typeof (parsed as { error?: unknown })?.error === 'string'
            ? String((parsed as { error: string }).error)
            : `请求失败（HTTP ${response.status}）`,
          response.status
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        lastError = err;
        if (!err.isRetryable || attempt >= maxRetries) throw err;
      } else if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new ApiRequestError('AI_TIMEOUT', '请求超时，请重试');
        if (attempt >= maxRetries) throw lastError;
      } else {
        lastError = new ApiRequestError(
          'NETWORK_ERROR',
          err instanceof Error ? err.message : '网络异常'
        );
        if (attempt >= maxRetries) throw lastError;
      }

      // 指数退避
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * 2 ** attempt, 4000))
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError ?? new ApiRequestError('INTERNAL_ERROR', '请求失败');
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

export type { ApiErrorCode };
