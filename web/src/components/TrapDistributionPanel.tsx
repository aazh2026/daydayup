/**
 * 错因形态分布面板（报告页）。
 *
 * 与「五维错因失分分析」并排展示，形成两条正交的轴：
 *   - 五维错因（AI 诊断）：错在哪个**环节**（知识/方法/计算/熟练度/审题）
 *   - 陷阱形态（错因资产）：错成了什么**样子**（概念混淆/规则误用/…）
 *
 * 数据来自服务端 `GET /api/v1/students/:id/trap-distribution`
 * （分类在服务端用规则完成，保证可复现、可审计）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Lightbulb, TriangleAlert } from 'lucide-react';
import {
  fetchTrapDistribution,
  type TrapDistribution,
  type TrapTypeBucket,
} from '../api/trap-distribution.ts';

export interface TrapDistributionPanelProps {
  studentId: string;
  /** 点击考点跳转到教练训练 */
  onLaunchCoach?: (knowledgeId: string) => void;
}

/** 形态配色（与五维错因面板区分开：这里用琥珀色系） */
const BUCKET_COLORS: Record<string, string> = {
  概念混淆: 'bg-amber-500',
  规则误用: 'bg-orange-500',
  审题遗漏: 'bg-yellow-500',
  计算失误: 'bg-lime-500',
  表达不规范: 'bg-teal-500',
  知识缺失: 'bg-sky-500',
  其他易错点: 'bg-slate-400',
};

export const TrapDistributionPanel: React.FC<TrapDistributionPanelProps> = ({
  studentId,
  onLaunchCoach,
}) => {
  const [data, setData] = useState<TrapDistribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchTrapDistribution(studentId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '错因形态分布加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const maxCount = useMemo(
    () => Math.max(1, ...(data?.buckets ?? []).map((b) => b.count)),
    [data]
  );

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="text-xs text-slate-500">正在统计错因形态分布…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">错因形态分布</h2>
        <div className="flex items-center gap-1.5 text-xs text-amber-700">
          <TriangleAlert className="w-3.5 h-3.5" />
          {error}
        </div>
      </div>
    );
  }

  if (!data || data.totalErrors === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">错因形态分布</h2>
        <p className="text-xs text-slate-500">
          暂无错题记录 —— 完成一次试卷诊断后，这里会按「错成了什么样子」给出分布。
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">错因形态分布</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            按错因资产（TrapSet）把失分归入具体陷阱形态 —— 与「五维错因」互为补充
          </p>
        </div>
        <div className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
          已归因 {data.attributedErrors}/{data.totalErrors} 题 · 失 -{data.attributedLost} 分
        </div>
      </div>

      {data.unattributedErrors > 0 && (
        <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
          其中 {data.unattributedErrors} 题（失 -{data.unattributedLost} 分）
          尚未匹配到资产化陷阱条目 —— 这些考点还没有可引用的错因资产。
        </div>
      )}

      <div className="space-y-2.5">
        {data.buckets.map((bucket: TrapTypeBucket) => {
          const isExpanded = expanded === bucket.type;
          const barWidth = Math.max(2, Math.round((bucket.count / maxCount) * 100));
          return (
            <div key={bucket.type}>
              <button
                type="button"
                onClick={() =>
                  setExpanded(isExpanded ? null : bucket.type)
                }
                className="w-full text-left p-2.5 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center justify-between text-xs mb-1.5 gap-2">
                  <span className="font-medium text-slate-800 truncate">
                    {bucket.type}
                    <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                      {bucket.label}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {bucket.count} 题 · 失 -{bucket.lost} 分 ({bucket.pct}%)
                  </span>
                </div>
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${BUCKET_COLORS[bucket.type] ?? 'bg-slate-400'} rounded-full transition-all`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </button>

              {isExpanded && bucket.topKnowledge.length > 0 && (
                <div className="mt-1.5 ml-2.5 pl-3 border-l border-slate-200 space-y-1">
                  {bucket.topKnowledge.map((kp) => (
                    <div
                      key={kp.knowledgeId}
                      className="flex items-center justify-between gap-2 text-[11px] text-slate-600"
                    >
                      <span className="truncate flex items-center gap-1">
                        <Lightbulb className="w-3 h-3 text-amber-600 shrink-0" />
                        {kp.knowledgeName}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {kp.count} 题 · -{kp.lost} 分
                      </span>
                      {onLaunchCoach && (
                        <button
                          type="button"
                          onClick={() => onLaunchCoach(kp.knowledgeId)}
                          className="px-2 py-0.5 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap shrink-0"
                        >
                          去训练
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
