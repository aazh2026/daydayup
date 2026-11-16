/**
 * 令牌存储与登录态管理。
 *
 * localStorage 只保留三类数据：token、UI 偏好、只读缓存快照。
 * 业务实体一律存服务端。
 */

const TOKEN_KEY = 'daydayup.auth.token';
const SESSION_KEY = 'daydayup.auth.session';

export interface AuthSession {
  token: string;
  expiresAt: string;
  principalId: string;
  role: 'student' | 'parent' | 'teacher';
  studentIds: string[];
  displayName?: string;
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session.token) return null;
    // 过期即清除
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  try {
    localStorage.setItem(TOKEN_KEY, session.token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // 忽略存储异常
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // 忽略
  }
}

/** 401 事件：API 客户端在令牌失效时触发，UI 层据此跳转登录 */
export const AUTH_EXPIRED_EVENT = 'daydayup:auth-expired';

export function notifyAuthExpired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}
