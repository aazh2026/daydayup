/**
 * 登录态存储测试。
 *
 * 令牌存放在 localStorage，是前后端分离后前端**唯一必须本地持有**的东西。
 * 这里的过期判定尤其关键：
 * 过期令牌若被继续使用，会在每个请求上触发 401 → 前端反复跳登录页；
 * 若过期判定过严，用户会被无谓地踢出。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, type MemoryStorage } from './helpers/local-storage.ts';
import {
  loadSession,
  saveSession,
  getToken,
  clearSession,
  notifyAuthExpired,
  AUTH_EXPIRED_EVENT,
  type AuthSession,
} from '../src/store/auth.ts';

const TOKEN_KEY = 'daydayup.auth.token';
const SESSION_KEY = 'daydayup.auth.session';

let storage: MemoryStorage;
let restore: () => void;

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    token: 'tok-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    principalId: 'p-1',
    role: 'student',
    studentIds: ['stu-1'],
    ...overrides,
  };
}

beforeEach(() => {
  const installed = installLocalStorage();
  storage = installed.storage;
  restore = installed.restore;
});

afterEach(() => {
  restore();
});

describe('会话读写', () => {
  test('保存后能读回完整会话', () => {
    const s = session({ displayName: '张伟' });
    saveSession(s);

    const loaded = loadSession();
    assert.ok(loaded);
    assert.equal(loaded.token, 'tok-1');
    assert.equal(loaded.principalId, 'p-1');
    assert.equal(loaded.role, 'student');
    assert.deepEqual(loaded.studentIds, ['stu-1']);
    assert.equal(loaded.displayName, '张伟');
  });

  test('同时写入独立的 token 键（供请求头快速读取）', () => {
    saveSession(session({ token: 'abc123' }));
    assert.equal(storage.getItem(TOKEN_KEY), 'abc123');
    assert.equal(getToken(), 'abc123');
  });

  test('无会话时返回 null', () => {
    assert.equal(loadSession(), null);
    assert.equal(getToken(), null);
  });

  test('清除会话同时清掉两个键', () => {
    saveSession(session());
    clearSession();
    assert.equal(storage.getItem(TOKEN_KEY), null);
    assert.equal(storage.getItem(SESSION_KEY), null);
    assert.equal(loadSession(), null);
    assert.equal(getToken(), null);
  });
});

describe('过期判定', () => {
  test('已过期的会话被判定为无效并清除', () => {
    const expired = session({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    storage.setItem(SESSION_KEY, JSON.stringify(expired));

    assert.equal(loadSession(), null);
    assert.equal(storage.getItem(SESSION_KEY), null, '过期会话应被清除');
  });

  test('未过期的会话有效', () => {
    saveSession(session({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    assert.ok(loadSession());
  });

  test('恰好到期的边界视为过期', () => {
    const now = Date.now();
    storage.setItem(
      SESSION_KEY,
      JSON.stringify(session({ expiresAt: new Date(now - 1).toISOString() }))
    );
    assert.equal(loadSession(), null);
  });

  test('expiresAt 为空字符串时不按过期处理', () => {
    // 开发模式会话没有 expiresAt
    storage.setItem(SESSION_KEY, JSON.stringify(session({ expiresAt: '' })));
    const loaded = loadSession();
    assert.ok(loaded, '无过期时间应视为不过期');
  });

  test('token 为空时无效', () => {
    storage.setItem(SESSION_KEY, JSON.stringify(session({ token: '' })));
    assert.equal(loadSession(), null);
  });

  test('内容非法时不抛错', () => {
    storage.setItem(SESSION_KEY, '{broken json');
    assert.equal(loadSession(), null);
  });

  test('非对象内容时不抛错', () => {
    storage.setItem(SESSION_KEY, '"just a string"');
    assert.equal(loadSession(), null);
  });
});

describe('容错', () => {
  test('存储异常时读操作安全返回 null', () => {
    restore();
    const globalRef = globalThis as unknown as { localStorage?: unknown };
    globalRef.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    assert.equal(loadSession(), null);
    assert.equal(getToken(), null);

    delete globalRef.localStorage;
  });

  test('存储异常时写操作不抛错', () => {
    restore();
    const failing = installLocalStorage({ failOnWrite: true });
    try {
      assert.doesNotThrow(() => saveSession(session()));
      assert.doesNotThrow(() => clearSession());
    } finally {
      failing.restore();
    }
  });
});

describe('令牌失效事件', () => {
  test('派发 daydayup:auth-expired 事件', () => {
    const received: string[] = [];
    globalThis.window = {
      dispatchEvent: (e: Event) => {
        received.push((e as CustomEvent).type);
        return true;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis;

    notifyAuthExpired();

    assert.deepEqual(received, [AUTH_EXPIRED_EVENT]);
  });
});
