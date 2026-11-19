/**
 * 三态自适应诊断面板（服务端权威）。
 *
 * ── 为什么不再用本地兜底微测 ──────────────────────────────────────────
 *
 * 旧实现的 Tab4「主动诊断微测」用的是组件内写死的 3 道题 + 前端本地判对错，
 * 再调 `onVerifyKnowledge` 让服务端迁移掌握度。问题有三个：
 *
 * 1. **题目是假的**（写死的常量），与学生当前薄弱点无关；
 * 2. **判题在前端**，答错/答对的判定逻辑可以被改写；
 * 3. **结论不是三态**，只有「对/错」两态，没有「会但不稳」这一中间态。
 *
 * 现在改成调用服务端 `diagnosis-engine`：出题、判题、三态判定、
 * 掌握度落库全在服务端完成，前端只负责发请求和展示结论。
 *
 * ── 前端不做什么 ──────────────────────────────────────────────────────
 *
 * - 不下发/不缓存 standardAnswer（会话视图里没有答案字段）；
 * - 不本地判对错（`judged` 来自服务端）；
 * - 不本地推导掌握度状态（finalize 后由服务端写库，前端再刷新权威值）。
 */
import React, { useCallback, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, PlayCircle, Target } from 'lucide-react';
import { MathText } from './MathText.tsx';
import {
  finalizeAdaptiveDiagnosis,
  startAdaptiveDiagnosis,
  submitAdaptiveAnswer,
  type AdaptiveSessionView,
  type AdaptiveSummary,
} from '../api/adaptive-diagnosis.ts';
import type { Subject } from '../types.ts';

export interface AdaptiveDiagnosisPanelProps {
  studentId: string;
  /** 待验证知识点（前端筛出的高优先考点） */
  targetKnowledgeIds: string[];
  /** 知识点 id → 名称（用于展示结论） */
  knowledgeNames?: Record<string, string>;
  /** 结论回写后刷新服务端权威掌握度 */
  onMasteryUpdated?: () => void | Promise<void>;
  /** 「去训练」：把薄弱点送到 AI 教练 */
  onLaunchCoach?: (knowledgeId: string) => void;
}

type Phase = 'idle' | 'loading' | 'question' | 'judging' | 'summary' | 'error';

/** 从选项里提取字母（'A. 4' → 'A'；'（C）3' → 'C'；'D' → 'D'） */
export function extractOptionLetter(text: string): string {
  const m = /^\s*[（(【\[]?\s*([A-Da-d])\s*[)）】\.]?/.exec(text);
  if (m) return m[1].toUpperCase();
  return '';
}

/** 从题干里抽出「选项字母」提示（没有 options 时用不上，保留给未来题干内嵌选项） */
export function isChoiceQuestion(options?: string[]): boolean {
  return Array.isArray(options) && options.length > 0;
}

export const AdaptiveDiagnosisPanel: React.FC<AdaptiveDiagnosisPanelProps> = ({
  studentId,
  targetKnowledgeIds,
  knowledgeNames,
  onMasteryUpdated,
  onLaunchCoach,
}) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<AdaptiveSessionView | null>(null);
  const [summary, setSummary] = useState<AdaptiveSummary | null>(null);
  const [answer, setAnswer] = useState<string>('');
  const [feedback, setFeedback] = useState<{
    isCorrect: boolean;
    text?: string;
    errorType?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = useCallback(
    (kid: string) => knowledgeNames?.[kid] ?? kid,
    [knowledgeNames]
  );

  const handleStart = async () => {
    if (targetKnowledgeIds.length === 0) {
      setError('当前没有待验证的知识点，先在前几个标签页录入诊断数据。');
      setPhase('error');
      return;
    }
    setPhase('loading');
    setError(null);
    setFeedback(null);
    setAnswer('');
    setSummary(null);
    try {
      const view = await startAdaptiveDiagnosis(studentId, {
        knowledgeIds: targetKnowledgeIds.slice(0, 12),
        mode: 'screen',
        limit: 12,
      });
      setSession(view);
      setPhase(view.item ? 'question' : 'summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动自适应诊断失败');
      setPhase('error');
    }
  };

  const handleSubmit = async () => {
    if (!session?.item) return;
    const trimmed = answer.trim();
    if (!trimmed) return;
    setPhase('judging');
    setError(null);
    try {
      const result = await submitAdaptiveAnswer(studentId, {
        sessionId: session.sessionId,
        knowledgeId: session.item.knowledgeId,
        answer: trimmed,
        qid: session.item.question.id,
      });
      setSession(result);
      setFeedback({
        isCorrect: result.judged.isCorrect,
        text: result.judged.feedback,
        errorType: result.judged.errorType,
      });
      setAnswer('');
      setPhase(result.finished ? 'summary' : 'question');
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交作答失败');
      setPhase('error');
    }
  };

  const handleFinalize = async () => {
    if (!session) return;
    setPhase('loading');
    setError(null);
    try {
      const s = await finalizeAdaptiveDiagnosis(studentId, session.sessionId);
      setSummary(s);
      setPhase('summary');
      await onMasteryUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '结束诊断失败');
      setPhase('error');
    }
  };

  const item = session?.item ?? null;
  const options = item?.question.options;

  return (
    <div className="space-y-4">
      {/* 头部：状态 + 开始按钮 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-xs text-slate-600">
          {session ? (
            <>
              服务端自适应诊断已作答{' '}
              <span className="font-semibold text-slate-900">{session.answered}</span>/
              <span className="font-semibold text-slate-900">{session.limit}</span> 题 ·
              当前考点：
              <span className="font-semibold text-slate-900">
                {nameOf(item?.knowledgeId ?? '')}
              </span>
            </>
          ) : (
            <>
              按服务端三态诊断引擎（掌握 / 不稳 / 薄弱）抽题作答，
              判题与掌握度落库均由服务端完成。当前待验证考点{' '}
              <span className="font-semibold text-slate-900">
                {targetKnowledgeIds.length}
              </span>{' '}
              个。
            </>
          )}
        </p>
        <button
          type="button"
          disabled={phase === 'loading' || phase === 'judging'}
          onClick={handleStart}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors whitespace-nowrap self-start sm:self-auto"
        >
          {phase === 'loading' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <PlayCircle className="w-3.5 h-3.5" />
          )}
          <span>{session ? '重新开始诊断' : '开始自适应诊断'}</span>
        </button>
      </div>

      {error && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2.5 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
          <span>{error}</span>
        </div>
      )}

      {/* 当前题 */}
      {item && phase !== 'summary' && (
        <div className="p-4 border border-slate-200 rounded-xl bg-slate-50/50 space-y-3">
          <div className="text-xs text-slate-500">
            {item.question.questionType} · {item.question.level} · 第 {item.attempt} 次
          </div>
          <p className="text-sm font-medium text-slate-900 leading-relaxed">
            {item.question.stem}
          </p>

          {isChoiceQuestion(options) ? (
            <div className="space-y-1.5">
              {(options ?? []).map((opt, oIdx) => {
                const letter = extractOptionLetter(opt) || String.fromCharCode(65 + oIdx);
                const chosen = answer === letter;
                return (
                  <button
                    key={`${letter}-${oIdx}`}
                    type="button"
                    disabled={phase === 'judging'}
                    onClick={() => setAnswer(letter)}
                    className={`w-full text-left px-3 py-2 text-xs rounded-lg border transition-colors ${
                      chosen
                        ? 'border-blue-600 bg-blue-50 text-blue-900 font-medium'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <MathText text={opt} />
                  </button>
                );
              })}
            </div>
          ) : (
            <textarea
              value={answer}
              disabled={phase === 'judging'}
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
              placeholder="输入你的答案（服务端按确定性引擎判题，判不了记为未判定）"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-800 focus:border-blue-600 focus:outline-none"
            />
          )}

          <button
            type="button"
            disabled={!answer.trim() || phase === 'judging'}
            onClick={handleSubmit}
            className="w-full py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors"
          >
            {phase === 'judging' ? '判题中…' : '提交作答'}
          </button>

          {feedback && (
            <div
              className={`p-2.5 rounded-lg text-xs border ${
                feedback.isCorrect
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <div className="font-semibold">
                {feedback.isCorrect ? '本题正确' : '本题未通过'}
                {feedback.errorType && feedback.errorType !== '无'
                  ? ` · 错因：${feedback.errorType}`
                  : ''}
              </div>
              {feedback.text && <div className="mt-1 text-slate-700">{feedback.text}</div>}
            </div>
          )}
        </div>
      )}

      {/* 结论 */}
      {phase === 'summary' && summary && (
        <div className="p-4 border border-slate-200 rounded-xl bg-white space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Target className="w-4 h-4 text-blue-600" />
            三态诊断结论（已写入服务端掌握度）
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: '掌握', ids: summary.mastered, cls: 'emerald' },
              { label: '不稳', ids: summary.shaky, cls: 'amber' },
              { label: '薄弱', ids: summary.weak, cls: 'red' },
            ].map((bucket) => (
              <div
                key={bucket.label}
                className={`p-3 rounded-lg border text-xs ${
                  bucket.cls === 'emerald'
                    ? 'bg-emerald-50 border-emerald-200'
                    : bucket.cls === 'amber'
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-red-50 border-red-200'
                }`}
              >
                <div className="font-semibold text-slate-900">
                  {bucket.label} · {bucket.ids.length}
                </div>
                <div className="mt-1.5 space-y-1">
                  {bucket.ids.length === 0 ? (
                    <div className="text-slate-500">无</div>
                  ) : (
                    bucket.ids.map((kid) => (
                      <button
                        key={kid}
                        type="button"
                        onClick={() => onLaunchCoach?.(kid)}
                        className="block text-left text-slate-700 hover:text-blue-700 underline decoration-dotted"
                      >
                        {nameOf(kid)}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>

          {summary.backtrack.length > 0 && (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
              <div className="font-semibold text-slate-900">建议回退补强的先修点</div>
              <ul className="mt-1.5 space-y-1 text-slate-700">
                {summary.backtrack.map((b) => (
                  <li key={b.knowledgeId}>
                    · {b.name}（被 {b.dependedBy} 个薄弱点依赖）
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            共作答 {summary.answered}/{summary.limit} 题 · 掌握度已由服务端 MasteryEngine 落库
          </div>
        </div>
      )}

      {phase === 'summary' && !summary && (
        <button
          type="button"
          onClick={handleFinalize}
          className="w-full py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors"
        >
          结束诊断并写入掌握度
        </button>
      )}

      {/* 会话进行中：允许提前收尾，把已答证据落库成三态结论 */}
      {phase === 'question' && session && (
        <button
          type="button"
          onClick={handleFinalize}
          className="w-full py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
        >
          提前结束并写入掌握度（已答 {session.answered}/{session.limit} 题）
        </button>
      )}
    </div>
  );
};

/** 供展示用：把三态 id 列表按学科分组（纯函数，便于单测） */
export function groupBySubject(
  ids: string[],
  subjectOf: (knowledgeId: string) => Subject | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const sub = subjectOf(id) ?? '其他';
    (out[sub] ??= []).push(id);
  }
  return out;
}
