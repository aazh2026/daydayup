import React, { useEffect, useState } from 'react';
import { Users, Loader2, AlertTriangle, ShieldCheck, TrendingUp } from 'lucide-react';
import { api } from '../api/client.ts';
import type { MasteryRecord, PriorityOpportunity } from '@daydayup/contracts';

interface StudentSummary {
  studentId: string;
  displayName: string;
  state: string;
  masteryCount: number;
  masteredCount: number;
  topOpportunity?: {
    knowledgeName: string;
    priorityScore: number;
    expectedGain: number;
  };
}

interface TeacherDashboardProps {
  studentIds: string[];
  onSelectStudent: (studentId: string) => void;
}

/**
 * 教师工作台。
 *
 * 老师角色可访问全部学生（服务端按 role=teacher 放行）。
 * 此页汇总各学生的掌握概况与最高优先级提分点。
 */
export const TeacherDashboard: React.FC<TeacherDashboardProps> = ({
  studentIds,
  onSelectStudent,
}) => {
  const [summaries, setSummaries] = useState<StudentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setIsLoading(true);
      setError(null);

      try {
        const results = await Promise.all(
          studentIds.map(async (studentId) => {
            const [mastery, opportunities] = await Promise.all([
              api.get<{ records: Record<string, MasteryRecord> }>(
                `/api/v1/students/${studentId}/mastery`
              ),
              api.get<{ opportunities: PriorityOpportunity[] }>(
                `/api/v1/students/${studentId}/opportunities`
              ),
            ]);

            const records = Object.values(mastery.records ?? {});
            const mastered = records.filter(
              (r) => r.state === '掌握' || r.state === '稳定掌握'
            ).length;
            const top = opportunities.opportunities?.[0];

            return {
              studentId,
              displayName: studentId,
              state: '在读',
              masteryCount: records.length,
              masteredCount: mastered,
              topOpportunity: top
                ? {
                    knowledgeName: top.knowledgeName,
                    priorityScore: top.priorityScore,
                    expectedGain: top.expectedGain,
                  }
                : undefined,
            } satisfies StudentSummary;
          })
        );

        if (!cancelled) setSummaries(results);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载学生列表失败');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studentIds]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />
        正在加载学生数据…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={18} className="text-blue-600" />
          <h2 className="text-base font-semibold text-slate-900">教师工作台</h2>
        </div>
        <p className="text-xs text-slate-500">
          共 {summaries.length} 名学生 · 点击卡片进入该学生的诊断与规划
        </p>
      </header>

      {summaries.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-400 text-sm">
          暂无可管理的学生
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map((s) => {
            const ratio =
              s.masteryCount > 0
                ? Math.round((s.masteredCount / s.masteryCount) * 100)
                : 0;

            return (
              <button
                key={s.studentId}
                type="button"
                onClick={() => onSelectStudent(s.studentId)}
                className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-blue-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Users size={15} className="text-slate-400" />
                  <span className="text-sm font-semibold text-slate-900 truncate">
                    {s.displayName}
                  </span>
                </div>

                <div className="flex items-baseline gap-1 mb-3">
                  <span className="text-2xl font-bold text-slate-900">
                    {ratio}
                  </span>
                  <span className="text-xs text-slate-400">% 已掌握</span>
                  <span className="ml-auto text-xs text-slate-400">
                    {s.masteredCount}/{s.masteryCount} 知识点
                  </span>
                </div>

                {s.topOpportunity ? (
                  <div className="flex items-start gap-1.5 text-xs text-slate-500">
                    <TrendingUp
                      size={13}
                      className="mt-0.5 shrink-0 text-blue-500"
                    />
                    <span className="leading-relaxed">
                      优先提升「{s.topOpportunity.knowledgeName}」
                      <span className="text-slate-400">
                        （优先级 {s.topOpportunity.priorityScore}，预计+
                        {s.topOpportunity.expectedGain}分）
                      </span>
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">
                    暂无提分机会数据
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
