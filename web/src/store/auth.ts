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

    /**
     * 逐字段校验。
     *
     * 只查 `session.token` 不够 —— 后续代码会直接访问
     * `session.studentIds[0]`（App.tsx 的水合目标计算）。
     * 若快照缺 `studentIds`（写入被中断 / 旧版本应用 / 外部改过），
     * 那一行会抛 `Cannot read properties of undefined (reading '0')`，
     * 而它在**渲染函数体内** → **整个应用白屏**。
     *
     * 宁可当作「没登录」重新登录，也不让一个坏会话拖垮应用。
     */
    if (typeof session?.token !== 'string' || !session.token) return null;
    if (!Array.isArray(session.studentIds)) return null;
    if (typeof session.role !== 'string') return null;
    if (typeof session.principalId !== 'string') return null;

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
