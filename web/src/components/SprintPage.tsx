/**
 * 30 天冲刺页。
 *
 * 数据来自服务端 `GET /api/v1/students/:id/sprint-plan`（冲刺引擎 sprint.v1）。
 * 前端不做任何重排 —— 阶段划分、每日任务、限时与验收标准都来自资产。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Flag, Target, Timer } from 'lucide-react';
import { MathText } from './MathText.tsx';
import type { SprintPlan } from '@daydayup/contracts';
import { fetchSprintPlan } from '../api/sprint.ts';
import { groupSprintStages, summarizeSprintPlan } from '../utils/sprint.ts';

interface SprintPageProps {
  studentId: string;
  /** 跳转到该知识点的训练页 */
  onLaunchCoach: (knowledgeId: string) => void;
}

export const SprintPage: React.FC<SprintPageProps> = ({
  studentId,
  onLaunchCoach,
}) => {
  const [plan, setPlan] = useState<SprintPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchSprintPlan(studentId)
      .then((res) => {
        if (cancelled) return;
        setPlan(res);
        setError(null);
        setSelectedDay(res.days[0]?.dayIndex ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '冲刺计划加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  /** 按阶段分组，用于阶段筛选条 */
  const stages = useMemo(() => groupSprintStages(plan?.days ?? []), [plan]);

  /** 计划结构统计（绑定率 / 平均时长 / 预算合规） */
  const summary = useMemo(
    () =>
      plan
        ? summarizeSprintPlan(plan.days, plan.effectiveDailyBudget)
        : null,
    [plan]
  );

  const activeDay = useMemo(() => {
    if (!plan) return null;
    return plan.days.find((d) => d.dayIndex === selectedDay) ?? plan.days[0];
  }, [plan, selectedDay]);

  if (loading) {
    return (
      <div className="text-sm text-slate-500 py-10 text-center">正在加载 30 天冲刺计划…</div>
    );
  }

  if (error || !plan) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        {error ?? '冲刺计划不可用'}
      </div>
    );
  }

  const stageName = activeDay?.stage ?? '';

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-slate-900">30 天冲刺计划</h1>
            <p className="text-xs text-slate-500 leading-relaxed">
              计划由服务端冲刺引擎（{plan.engineVersion}）生成，共 {plan.totalDays} 天，
              每日总时长不超过 {plan.effectiveDailyBudget} 分钟。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-slate-500">总天数</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {plan.totalDays}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">当前阶段</div>
              <div className="mt-1 text-sm font-semibold text-blue-700">{stageName}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">每日预算</div>
              <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {plan.effectiveDailyBudget}
                <span className="text-xs font-normal text-slate-500 ml-1">分钟</span>
              </div>
            </div>
          </div>
        </div>

        {summary && (
          <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="text-slate-500">已绑定知识点</div>
              <div className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900">
                {summary.boundDays} / {plan.totalDays}
              </div>
            </div>
            <div>
              <div className="text-slate-500">平均每日时长</div>
              <div className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900">
                {summary.averageMinutes} 分钟
              </div>
            </div>
            <div>
              <div className="text-slate-500">关联训练任务</div>
              <div className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900">
                {summary.totalTasks} 项
              </div>
            </div>
            <div>
              <div className="text-slate-500">超预算天数</div>
              <div
                className={`mt-0.5 font-mono tabular-nums font-semibold ${
                  summary.overBudgetDays === 0 ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {summary.overBudgetDays} 天
              </div>
            </div>
          </div>
        )}

        {/* 阶段筛选条 */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-1.5">
          {stages.map((stage) => (
            <button
              key={stage.name}
              type="button"
              onClick={() => setSelectedDay(stage.days[0])}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                stage.name === stageName
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-slate-50 text-slate-600 hover:text-slate-900 border border-transparent'
              }`}
            >
              {stage.name}（第 {stage.fromDay}–{stage.toDay} 天）
            </button>
          ))}
        </div>
      </section>

      {/* 天数选择 */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-slate-700" />
          <h2 className="text-base font-semibold text-slate-900">选择冲刺日</h2>
        </div>
        <div className="grid grid-cols-10 gap-1.5">
          {plan.days.map((day) => (
            <button
              key={day.dayIndex}
              type="button"
              onClick={() => setSelectedDay(day.dayIndex)}
              className={`py-1.5 text-xs font-mono tabular-nums rounded-md transition-colors ${
                day.dayIndex === activeDay?.dayIndex
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {day.dayIndex}
            </button>
          ))}
        </div>
      </section>

      {activeDay && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2">
              <Flag className="w-4 h-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                {activeDay.dayLabel} · {activeDay.stage}
              </h2>
            </div>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Timer className="w-3.5 h-3.5" />
              当日排期 {activeDay.totalMinutes} 分钟
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 rounded-lg bg-slate-50 border border-slate-200 p-4">
              <div className="text-xs font-medium text-slate-500 mb-1">当日任务</div>
              <p className="text-sm text-slate-800 leading-relaxed"><MathText text={activeDay.task} /></p>
              <div className="mt-3 text-xs text-slate-500"><MathText text={activeDay.timeLimit} /></div>
            </div>
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4">
              <div className="flex items-center gap-1 text-xs font-medium text-emerald-800 mb-1">
                <Target className="w-3.5 h-3.5" />
                验收标准
              </div>
              <p className="text-xs text-emerald-900 leading-relaxed">
                <MathText text={activeDay.acceptanceCriteria} />
              </p>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4 space-y-2">
            <div className="text-xs font-medium text-slate-500">
              关联训练（{activeDay.tasks.length} 项）
            </div>
            {activeDay.tasks.length === 0 && (
              <div className="text-xs text-slate-400">当日未绑定具体知识点。</div>
            )}
            {activeDay.tasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium text-slate-900"><MathText text={task.title} /></div>
                  <div className="mt-0.5 text-xs text-slate-500"><MathText text={task.objective} /></div>
                </div>
                <button
                  type="button"
                  onClick={() => onLaunchCoach(task.knowledgeId)}
                  className="self-start sm:self-auto px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap"
                >
                  去训练
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
