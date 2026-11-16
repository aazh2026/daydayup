/**
 * 认证 API。
 */
import { api } from './client.ts';
import { saveSession, type AuthSession } from '../store/auth.ts';

export interface LoginResponse {
  token: string;
  expiresAt: string;
  principalId: string;
  role: 'student' | 'parent' | 'teacher';
  studentIds: string[];
  displayName?: string;
}

export async function login(secret: string): Promise<AuthSession> {
  const res = await api.post<LoginResponse>('/api/v1/auth/login', { secret });
  const session: AuthSession = {
    token: res.token,
    expiresAt: res.expiresAt,
    principalId: res.principalId,
    role: res.role,
    studentIds: res.studentIds,
    displayName: res.displayName,
  };
  saveSession(session);
  return session;
}

export async function logout(): Promise<void> {
  const { clearSession } = await import('../store/auth.ts');
  clearSession();
}

/** 服务端是否要求认证（用于决定是否显示登录页） */
export async function isAuthRequired(): Promise<boolean> {
  try {
    const res = await api.get<{ authRequired: boolean }>('/api/v1/health');
    return Boolean(res.authRequired);
  } catch {
    return false;
  }
}
