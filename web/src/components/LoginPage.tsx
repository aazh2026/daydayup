import React, { useState } from 'react';
import { ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import { login } from '../api/auth.ts';
import type { AuthSession } from '../store/auth.ts';

interface LoginPageProps {
  onLoggedIn: (session: AuthSession) => void;
}

/**
 * 登录页。
 *
 * 说明：凭证（学生 PIN / 家长 API Key）在服务端校验，
 * 前端不存储明文凭证，仅保存服务端签发的访问令牌。
 */
export const LoginPage: React.FC<LoginPageProps> = ({ onLoggedIn }) => {
  const [secret, setSecret] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) {
      setError('请输入登录凭证');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const session = await login(secret.trim());
      onLoggedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600 text-white mb-3">
            <ShieldCheck size={24} />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">智学中枢</h1>
          <p className="text-sm text-slate-500 mt-1">
            上海初三 AI 提分系统
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl shadow-sm p-6"
        >
          <label
            htmlFor="login-secret"
            className="block text-sm font-medium text-slate-700 mb-1.5"
          >
            登录凭证
          </label>
          <input
            id="login-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="学生 PIN / 家长或老师 API Key"
            autoComplete="current-password"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            disabled={isLoading}
          />

          {error && (
            <div className="mt-3 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="mt-5 w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg py-2.5 transition-colors"
          >
            {isLoading && <Loader2 size={16} className="animate-spin" />}
            {isLoading ? '登录中…' : '登录'}
          </button>

          <p className="mt-4 text-xs text-slate-400 leading-relaxed">
            学习数据与诊断结论保存在服务端。凭证仅用于换取访问令牌，
            不会存储在浏览器中。
          </p>
        </form>
      </div>
    </div>
  );
};
