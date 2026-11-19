/**
 * AI 设置页（老师/管理员专属）。
 *
 * 这是「AI 配置能力」的前端入口：
 * - 读取当前生效的 AI 配置（API Key 只显示掩码）
 * - 修改 API Key / 模型 / 温度 / 超时 / 重试 / 每日配额 / 启用开关
 * - 一键测试连通性（返回耗时与错误原因）
 * - 一键恢复环境变量默认值
 *
 * 设计约束：
 * - **明文 Key 不回显**：输入框留空表示「不修改已有 Key」，
 *   服务端保留原值（否则前端每次回显掩码都会把真 Key 擦掉）。
 * - **保存即生效**：服务端写入后立即热更新 Provider，无需重启。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Settings2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Cpu,
  Gauge,
  RotateCcw,
  PlugZap,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api/client.ts';
import {
  AI_CONFIG_LIMITS,
  AI_MODEL_OPTIONS,
  type AIConfig,
  type TestAIConnectionResult,
} from '@daydayup/contracts';

interface AISettingsPageProps {
  onNavigate?: (page: 'teacher' | 'settings') => void;
}

interface FormState {
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  dailyQuota: number;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  apiKey: '',
  model: AI_MODEL_OPTIONS[0],
  temperature: 0.2,
  timeoutMs: 120000,
  maxRetries: 3,
  dailyQuota: 0,
  enabled: true,
};

export const AISettingsPage: React.FC<AISettingsPageProps> = ({ onNavigate }) => {
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestAIConnectionResult | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get<{
        config: AIConfig;
        models: readonly string[];
      }>('/api/v1/admin/ai-settings');

      setConfig(response.config);
      setForm({
        // Key 留空：服务端不返回明文，留空即「不修改」
        apiKey: '',
        model: response.config.model,
        temperature: response.config.temperature,
        timeoutMs: response.config.timeoutMs,
        maxRetries: response.config.maxRetries,
        dailyQuota: response.config.dailyQuota,
        enabled: response.config.enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 AI 配置失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const payload: Record<string, unknown> = {
        model: form.model,
        temperature: form.temperature,
        timeoutMs: form.timeoutMs,
        maxRetries: form.maxRetries,
        dailyQuota: form.dailyQuota,
        enabled: form.enabled,
      };
      // 只有填了新的 Key 才提交，避免空值覆盖已有 Key
      if (form.apiKey.trim().length > 0) {
        payload.apiKey = form.apiKey.trim();
      }

      const response = await api.put<{ config: AIConfig }>(
        '/api/v1/admin/ai-settings',
        payload
      );
      setConfig(response.config);
      setForm((prev) => ({ ...prev, apiKey: '' }));
      setNotice('配置已保存并立即生效（无需重启服务）');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.post<TestAIConnectionResult>(
        '/api/v1/admin/ai-settings/test'
      );
      setTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '测试失败');
    } finally {
      setIsTesting(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const response = await api.post<{ config: AIConfig }>(
        '/api/v1/admin/ai-settings/reset'
      );
      setConfig(response.config);
      setForm({
        apiKey: '',
        model: response.config.model,
        temperature: response.config.temperature,
        timeoutMs: response.config.timeoutMs,
        maxRetries: response.config.maxRetries,
        dailyQuota: response.config.dailyQuota,
        enabled: response.config.enabled,
      });
      setNotice('已恢复为环境变量默认值');
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />
        正在加载 AI 配置…
      </div>
    );
  }

  const limits = AI_CONFIG_LIMITS;

  return (
    <div className="space-y-5">
      <header className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Settings2 size={18} className="text-blue-600" />
          <h2 className="text-base font-semibold text-slate-900">AI 配置</h2>
          {config?.enabled === false && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-100">
              已停用
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">
          配置服务端 AI 能力：API Key、模型、采样参数与每日配额。保存后立即生效，无需重启服务。
        </p>

        {/* 状态条 */}
        {config && (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
              <ShieldCheck size={12} className="text-slate-400" />
              配置来源：{config.source === 'runtime' ? '后台设置' : '环境变量'}
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
              <KeyRound size={12} className="text-slate-400" />
              API Key：{config.hasApiKey ? config.apiKeyMasked : '未配置'}
            </span>
            {config.updatedAt && (
              <span className="text-slate-400">
                最近修改：{new Date(config.updatedAt).toLocaleString('zh-CN')}
                {config.updatedBy ? `（${config.updatedBy}）` : ''}
              </span>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-4 py-3">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ---- 接入配置 ---- */}
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound size={15} className="text-blue-600" />
            <h3 className="text-sm font-semibold text-slate-900">接入配置</h3>
          </div>

          <div>
            <label
              htmlFor="ai-api-key"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              API Key
              <span className="ml-2 text-slate-400 font-normal">
                留空表示不修改（当前：
                {config?.hasApiKey ? config.apiKeyMasked : '未配置'}）
              </span>
            </label>
            <input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
              placeholder="粘贴新的 Gemini API Key"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              明文 Key 只保存在服务端，不会回显到浏览器。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="ai-model"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                模型
              </label>
              <select
                id="ai-model"
                value={form.model}
                onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
              >
                {(AI_MODEL_OPTIONS as readonly string[]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="ai-enabled"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                AI 能力开关
              </label>
              <button
                id="ai-enabled"
                type="button"
                role="switch"
                aria-checked={form.enabled}
                onClick={() => setForm((p) => ({ ...p, enabled: !p.enabled }))}
                className={`w-full px-3 py-2 text-sm border rounded-lg transition-colors ${
                  form.enabled
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : 'bg-slate-50 border-slate-200 text-slate-500'
                }`}
              >
                {form.enabled ? '已启用' : '已停用（所有 AI 功能不可用）'}
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label
                htmlFor="ai-temperature"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                采样温度
              </label>
              <input
                id="ai-temperature"
                type="number"
                step="0.1"
                min={limits.temperature.min}
                max={limits.temperature.max}
                value={form.temperature}
                onChange={(e) =>
                  setForm((p) => ({ ...p, temperature: Number(e.target.value) }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                越低越稳定（诊断建议 0.2）
              </p>
            </div>

            <div>
              <label
                htmlFor="ai-timeout"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                超时（秒）
              </label>
              <input
                id="ai-timeout"
                type="number"
                step="5"
                min={Math.ceil(limits.timeoutMs.min / 1000)}
                max={Math.ceil(limits.timeoutMs.max / 1000)}
                value={Math.round(form.timeoutMs / 1000)}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    timeoutMs: Number(e.target.value) * 1000,
                  }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                单次调用最长等待时间
              </p>
            </div>

            <div>
              <label
                htmlFor="ai-retries"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                最大尝试次数
              </label>
              <input
                id="ai-retries"
                type="number"
                step="1"
                min={limits.maxRetries.min}
                max={limits.maxRetries.max}
                value={form.maxRetries}
                onChange={(e) =>
                  setForm((p) => ({ ...p, maxRetries: Number(e.target.value) }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                失败后指数退避重试
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle2 size={14} />
              )}
              保存配置
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={isTesting}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isTesting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <PlugZap size={14} />
              )}
              测试连通性
            </button>

            <button
              type="button"
              onClick={handleReset}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw size={14} />
              恢复默认
            </button>
          </div>
        </section>

        {/* ---- 运行状态 ---- */}
        <aside className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={15} className="text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">当前生效配置</h3>
            </div>
            <dl className="space-y-2 text-xs">
              {[
                ['模型', config?.model ?? '—'],
                ['温度', String(config?.temperature ?? '—')],
                ['超时', `${Math.round((config?.timeoutMs ?? 0) / 1000)} 秒`],
                ['最大重试', String(config?.maxRetries ?? '—')],
                [
                  '每日配额',
                  (config?.dailyQuota ?? 0) > 0
                    ? `${config?.dailyQuota} 次/天`
                    : '不限制',
                ],
                ['状态', config?.enabled ? '已启用' : '已停用'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 py-1 border-b border-slate-100 last:border-0"
                >
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="font-medium text-slate-900 text-right break-all">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Gauge size={15} className="text-blue-600" />
              <h3 className="text-sm font-semibold text-slate-900">连通性测试</h3>
            </div>

            {testResult ? (
              <div
                className={`text-xs rounded-lg border px-3 py-2.5 ${
                  testResult.ok
                    ? 'bg-emerald-50 border-emerald-100 text-emerald-700'
                    : 'bg-red-50 border-red-100 text-red-600'
                }`}
              >
                <div className="font-medium">
                  {testResult.ok ? '连接正常' : '连接失败'}
                  {testResult.latencyMs > 0 && ` · ${testResult.latencyMs} ms`}
                </div>
                {testResult.error && (
                  <div className="mt-1 break-words opacity-90">{testResult.error}</div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-400 leading-relaxed">
                发送一次最小请求验证 API Key、模型与网络是否可用。
              </p>
            )}

            <button
              type="button"
              onClick={handleTest}
              disabled={isTesting}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-full justify-center"
            >
              {isTesting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <PlugZap size={14} />
              )}
              {testResult ? '重新测试' : '开始测试'}
            </button>
          </section>

          <section className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <h3 className="text-xs font-semibold text-slate-700 mb-2">说明</h3>
            <ul className="space-y-1.5 text-[11px] text-slate-500 leading-relaxed">
              <li>• 环境变量作为默认值，后台保存后以运行时配置为准。</li>
              <li>• 停用 AI 后，所有诊断/教练/出题接口会返回明确提示。</li>
              <li>• 每日配额按账号统计，0 表示不限制。</li>
              <li>• 每次修改都会写入审计日志（不含明文 Key）。</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
};
