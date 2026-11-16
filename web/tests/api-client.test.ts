/**
 * API 客户端层测试。
 *
 * 这是前后端分离的**契约边界** —— 所有前端请求都从这里出去。
 * 一旦这层的语义漂移（错误码丢失、重试策略变化、令牌没带上），
 * 上层所有组件的差异化处理都会失效。
 *
 * 覆盖：
 * - 令牌注入 / 缺失
 * - 错误码透出与标准化（非标准错误体兜底）
 * - 401 触发登录失效事件
 * - 重试策略（GET 重试、写操作不重试）
 * - 超时 → AI_TIMEOUT
 * - 网络异常 → NETWORK_ERROR
 * - AbortSignal 联动
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers/local-storage.ts';
import { saveSession, clearSession } from '../src/store/auth.ts';

// ---- fetch 打桩 ----
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: FetchCall[] = [];
let restoreStorage: () => void;

/** 构造一个 Response 替身 */
function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
  } as unknown as Response;
}

/** 标准错误体 */
function apiError(code: string, message = '出错') {
  return {
    error: { code, message },
    requestId: 'req_test',
  };
}

beforeEach(() => {
  calls = [];
  const installed = installLocalStorage();
  restoreStorage = installed.restore;
  clearSession();
});

afterEach(() => {
  restoreStorage();
  clearSession();
});

/** 安装 fetch 打桩 */
function stubFetch(handler: (call: FetchCall, attempt: number) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 动态导入 client（必须在装好 localStorage 之后） */
async function loadClient() {
  return import('../src/api/client.ts');
}

describe('令牌注入', () => {
  test('有令牌时带上 Authorization 头', async () => {
    saveSession({
      token: 'tok-abc',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      principalId: 'p1',
      role: 'student',
      studentIds: ['s1'],
    });

    const restore = stubFetch(() => jsonResponse(200, { ok: true }));
    try {
      const { api } = await loadClient();
      await api.get('/api/v1/students');
    } finally {
      restore();
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-abc');
  });

  test('无令牌时不带 Authorization 头', async () => {
    const restore = stubFetch(() => jsonResponse(200, { ok: true }));
    try {
      const { api } = await loadClient();
      await api.get('/api/v1/students');
    } finally {
      restore();
    }

    assert.equal(calls[0].headers.Authorization, undefined);
  });

  test('请求体被 JSON 序列化', async () => {
    const restore = stubFetch(() => jsonResponse(200, { ok: true }));
    try {
      const { api } = await loadClient();
      await api.post('/api/v1/x', { a: 1, b: 'z' });
    } finally {
      restore();
    }

    assert.equal(calls[0].body, JSON.stringify({ a: 1, b: 'z' }));
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
  });
});

describe('错误标准化', () => {
  test('标准错误体透出错误码与 requestId', async () => {
    const restore = stubFetch(() =>
      jsonResponse(403, apiError('FORBIDDEN', '无权访问该学生数据'))
    );
    try {
      const { api, ApiRequestError } = await loadClient();
      await assert.rejects(
        () => api.get('/api/v1/students/x/mastery'),
        (err: InstanceType<typeof ApiRequestError>) => {
          assert.equal(err.code, 'FORBIDDEN');
          assert.equal(err.message, '无权访问该学生数据');
          assert.equal(err.status, 403);
          assert.equal(err.requestId, 'req_test');
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  test('非标准错误体兜底为 INTERNAL_ERROR', async () => {
    const restore = stubFetch(() => jsonResponse(500, { error: '服务器炸了' }));
    try {
      const { api } = await loadClient();
      await assert.rejects(
        () => api.get('/api/v1/x'),
        (err: { code: string; message: string; status?: number }) => {
          assert.equal(err.code, 'INTERNAL_ERROR');
          // 旧的 `{ error: string }` 结构仍要能提取出消息
          assert.equal(err.message, '服务器炸了');
          assert.equal(err.status, 500);
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  test('完全无法解析的错误体给出兜底消息', async () => {
    const restore = stubFetch(() => jsonResponse(502, undefined));
    try {
      const { api } = await loadClient();
      await assert.rejects(
        () => api.get('/api/v1/x'),
        (err: { code: string; message: string }) => {
          assert.equal(err.code, 'INTERNAL_ERROR');
          assert.match(err.message, /HTTP 502/);
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  test('401 触发令牌失效事件（UI 据此跳登录页）', async () => {
    const received: string[] = [];
    const listener = (e: Event) => received.push((e as CustomEvent).type);
    globalThis.window = {
      dispatchEvent: listener,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis;

    const restore = stubFetch(() => jsonResponse(401, apiError('UNAUTHORIZED')));
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.get('/api/v1/x'));
    } finally {
      restore();
    }

    assert.ok(
      received.includes('daydayup:auth-expired'),
      '401 应触发 daydayup:auth-expired 事件'
    );
  });

  test('403 不触发令牌失效事件（不是登录态问题）', async () => {
    const received: string[] = [];
    globalThis.window = {
      dispatchEvent: (e: Event) => {
        received.push((e as CustomEvent).type);
        return true;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis;

    const restore = stubFetch(() => jsonResponse(403, apiError('FORBIDDEN')));
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.get('/api/v1/x'));
    } finally {
      restore();
    }

    assert.equal(received.length, 0, '403 不应触发登录失效事件');
  });
});

describe('重试策略', () => {
  test('GET 遇到 500 会重试（最多 2 次）', async () => {
    const restore = stubFetch(() => jsonResponse(500, apiError('INTERNAL_ERROR')));
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.get('/api/v1/x'));
    } finally {
      restore();
    }

    // 首次 + 2 次重试 = 3 次
    assert.equal(calls.length, 3);
  });

  test('POST 遇到 500 不重试（写操作不可重复提交）', async () => {
    const restore = stubFetch(() => jsonResponse(500, apiError('INTERNAL_ERROR')));
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.post('/api/v1/x', { a: 1 }));
    } finally {
      restore();
    }

    assert.equal(calls.length, 1, '写操作不应自动重试');
  });

  test('GET 成功时不重试', async () => {
    const restore = stubFetch(() => jsonResponse(200, { ok: true }));
    try {
      const { api } = await loadClient();
      await api.get('/api/v1/x');
    } finally {
      restore();
    }

    assert.equal(calls.length, 1);
  });

  test('400 校验失败不重试（重试也不会变好）', async () => {
    const restore = stubFetch(() =>
      jsonResponse(400, apiError('VALIDATION_FAILED', '参数错误'))
    );
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.get('/api/v1/x'));
    } finally {
      restore();
    }

    assert.equal(calls.length, 1);
  });

  test('重试成功后返回结果', async () => {
    const restore = stubFetch((_call, attempt) =>
      attempt === 0
        ? jsonResponse(500, apiError('INTERNAL_ERROR'))
        : jsonResponse(200, { recovered: true })
    );
    try {
      const { api } = await loadClient();
      const result = await api.get<{ recovered: boolean }>('/api/v1/x');
      assert.equal(result.recovered, true);
    } finally {
      restore();
    }

    assert.equal(calls.length, 2);
  });

  test('可显式指定重试次数', async () => {
    const restore = stubFetch(() => jsonResponse(500, apiError('INTERNAL_ERROR')));
    try {
      const { api } = await loadClient();
      await assert.rejects(() => api.get('/api/v1/x', { retries: 0 }));
    } finally {
      restore();
    }

    assert.equal(calls.length, 1);
  });
});

describe('可重试性判定', () => {
  test('AI_TIMEOUT 可重试', async () => {
    const { ApiRequestError } = await loadClient();
    const err = new ApiRequestError('AI_TIMEOUT', '超时');
    assert.equal(err.isRetryable, true);
  });

  test('NETWORK_ERROR 可重试', async () => {
    const { ApiRequestError } = await loadClient();
    assert.equal(new ApiRequestError('NETWORK_ERROR', 'x').isRetryable, true);
  });

  test('VALIDATION_FAILED 不可重试', async () => {
    const { ApiRequestError } = await loadClient();
    assert.equal(new ApiRequestError('VALIDATION_FAILED', 'x').isRetryable, false);
  });

  test('FORBIDDEN 不可重试', async () => {
    const { ApiRequestError } = await loadClient();
    assert.equal(new ApiRequestError('FORBIDDEN', 'x').isRetryable, false);
  });
});

describe('超时与网络异常', () => {
  test('超时报错映射为 AI_TIMEOUT', async () => {
    const restore = stubFetch((_call) => {
      // 模拟 fetch 被 AbortController 中断
      return new Promise<Response>((_resolve, reject) => {
        const err = new DOMException('The operation was aborted.', 'AbortError');
        setTimeout(() => reject(err), 5);
      });
    });
    try {
      const { api } = await loadClient();
      await assert.rejects(
        () => api.get('/api/v1/x', { timeoutMs: 10, retries: 0 }),
        (err: { code: string }) => {
          assert.equal(err.code, 'AI_TIMEOUT');
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  test('网络异常映射为 NETWORK_ERROR', async () => {
    const restore = stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    try {
      const { api } = await loadClient();
      await assert.rejects(
        () => api.get('/api/v1/x', { retries: 0 }),
        (err: { code: string }) => {
          assert.equal(err.code, 'NETWORK_ERROR');
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  test('外部 AbortSignal 能中断请求', async () => {
    const controller = new AbortController();
    const restore = stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(
            () => reject(new DOMException('aborted', 'AbortError')),
            50
          );
        })
    );
    try {
      const { api } = await loadClient();
      const promise = api.get('/api/v1/x', {
        signal: controller.signal,
        retries: 0,
        timeoutMs: 5000,
      });
      controller.abort();
      await assert.rejects(() => promise);
    } finally {
      restore();
    }
  });
});

describe('成功响应', () => {
  test('返回解析后的 JSON', async () => {
    const restore = stubFetch(() =>
      jsonResponse(200, { studentId: 's1', records: {} })
    );
    try {
      const { api } = await loadClient();
      const result = await api.get<{ studentId: string }>('/api/v1/x');
      assert.equal(result.studentId, 's1');
    } finally {
      restore();
    }
  });

  test('空响应体返回 undefined', async () => {
    const restore = stubFetch(() => jsonResponse(204, undefined));
    try {
      const { api } = await loadClient();
      const result = await api.get('/api/v1/x');
      assert.equal(result, undefined);
    } finally {
      restore();
    }
  });

  test('非 JSON 响应体不抛错', async () => {
    const restore = stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () => 'not json',
    }) as unknown as Response);
    try {
      const { api } = await loadClient();
      const result = await api.get('/api/v1/x');
      assert.equal(result, undefined);
    } finally {
      restore();
    }
  });
});
