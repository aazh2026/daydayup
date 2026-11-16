import React, { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Layers, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { KNOWLEDGE_MAP, SHANGHAI_CURRICULUM } from '../data/shanghaiCurriculum.ts';
import { MASTERY_ORDER } from '../engine/planner.ts';
import { ALL_SUBJECTS } from '../types.ts';
import type {
  ErrorRecord,
  ErrorType,
  Exam,
  ExamResult,
  LearningAttempt,
  LearningPlan,
  MasteryRecord,
  MasteryTransitionEvent,
  Subject,
  VariantQuestion,
} from '../types.ts';

interface ReportPageProps {
  exams: Exam[];
  examResults: ExamResult[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  masteryHistory: MasteryTransitionEvent[];
  learningAttempts: LearningAttempt[];
  variantQuestions: VariantQuestion[];
  plan: LearningPlan;
  onMarkErrorCorrected: (errorId: string, note: string) => void;
  onLaunchCoach: (knowledgeId: string) => void;
}

type ReportTab = 'evaluation' | 'knowledge' | 'errors';

const ERROR_TYPES: ErrorType[] = [
  '知识问题',
  '方法问题',
  '计算问题',
  '熟练度问题',
  '审题问题',
];

const ERROR_STATUSES: ErrorRecord['status'][] = [
  '未订正',
  '已订正',
  '待复测',
  '已闭环',
];

export const ReportPage: React.FC<ReportPageProps> = ({
  exams,
  examResults,
  errorRecords,
  masteryRecords,
  masteryHistory,
  learningAttempts,
  variantQuestions,
  plan,
  onMarkErrorCorrected,
  onLaunchCoach,
}) => {
  const [activeTab, setActiveTab] = useState<ReportTab>('evaluation');
  const [subjectFilter, setSubjectFilter] = useState<'全部' | Subject>('全部');
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});

  // Mastery Change Analysis Filters (Tab 1)
  const [historyDirectionFilter, setHistoryDirectionFilter] = useState<'all' | 'up' | 'down'>('all');
  const [historySubjectFilter, setHistorySubjectFilter] = useState<'全部' | Subject>('全部');

  // Multi-Dimensional Error Organization Filters (Tab 3)
  const [errorTypeFilter, setErrorTypeFilter] = useState<'全部' | ErrorType>('全部');
  const [statusFilter, setStatusFilter] = useState<'全部' | ErrorRecord['status']>('全部');
  const [examFilter, setExamFilter] = useState<string>('全部');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [errorSortBy, setErrorSortBy] = useState<'recent' | 'scoreLost'>('recent');

  // Layer 1: Learning Process Metrics
  const allWeekTasks = plan.days.flatMap((d) => d.tasks);
  const completedTasks = allWeekTasks.filter((t) => t.status === '已完成');
  const taskCompletionRate =
    allWeekTasks.length > 0
      ? Math.round((completedTasks.length / allWeekTasks.length) * 100)
      : 0;
  const totalMinutesLearned =
    completedTasks.reduce((s, t) => s + t.estimatedMinutes, 0) +
    Math.round(learningAttempts.reduce((s, a) => s + a.timeSpentSeconds, 0) / 60);
  const independentRate =
    learningAttempts.length > 0
      ? Math.round(
          (learningAttempts.filter((a) => a.independent).length / learningAttempts.length) *
            100
        )
      : 0;

  // Layer 2: Ability Change Metrics (Strict verification: only 初步掌握/掌握/稳定掌握 counts)
  const masteryList = Object.values(masteryRecords);
  const repairedCount = masteryList.filter(
    (m) => m.state === '掌握' || m.state === '稳定掌握'
  ).length;
  const preliminaryCount = masteryList.filter((m) => m.state === '初步掌握').length;
  const consolidatedCount = repairedCount + preliminaryCount;
  const consolidatedRatio =
    SHANGHAI_CURRICULUM.length > 0
      ? Math.round((consolidatedCount / SHANGHAI_CURRICULUM.length) * 100)
      : 0;

  const variantAttempts = learningAttempts.filter(
    (a) => a.mode === '变式训练' || a.mode === '迁移应用' || a.mode === '延迟复测'
  );
  const variantAccuracy =
    variantAttempts.length > 0
      ? Math.round(
          (variantAttempts.filter((a) => a.isCorrect).length / variantAttempts.length) * 100
        )
      : 0;

  // Layer 3: Multi-Exam Chronological Matrix
  const chronologicalExams = useMemo(
    () => [...exams].sort((a, b) => a.date.localeCompare(b.date)),
    [exams]
  );

  const subjectTrends = ALL_SUBJECTS.map((sub) => {
    const records = examResults
      .filter((r) => r.subject === sub)
      .sort((a, b) => a.date.localeCompare(b.date));
    const first = records[0];
    const latest = records[records.length - 1];
    const delta = first && latest && records.length > 1 ? latest.score - first.score : 0;
    const perExamScores = chronologicalExams.map((ex) =>
      examResults.find((r) => r.examId === ex.id && r.subject === sub)
    );
    return { subject: sub, first, latest, delta, perExamScores };
  });

  // Mastery Change Trajectory Analysis
  const enrichedHistory = useMemo(() => {
    return [...masteryHistory]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((ev) => {
        const fromIdx = MASTERY_ORDER.indexOf(ev.fromState);
        const toIdx = MASTERY_ORDER.indexOf(ev.toState);
        const stepDelta = toIdx - fromIdx;
        return {
          ...ev,
          stepDelta,
          knowledgeName: KNOWLEDGE_MAP[ev.knowledgeId]?.name ?? ev.knowledgeId,
        };
      });
  }, [masteryHistory]);

  const upgradeCount = enrichedHistory.filter((h) => h.stepDelta > 0).length;
  const regressionCount = enrichedHistory.filter((h) => h.stepDelta < 0).length;

  const filteredHistory = enrichedHistory.filter((ev) => {
    if (historySubjectFilter !== '全部' && ev.subject !== historySubjectFilter) return false;
    if (historyDirectionFilter === 'up' && ev.stepDelta <= 0) return false;
    if (historyDirectionFilter === 'down' && ev.stepDelta >= 0) return false;
    return true;
  });

  const stillWeakList = SHANGHAI_CURRICULUM.filter((kp) => {
    const st = masteryRecords[kp.id]?.state;
    return st === '待学习' || st === '未诊断' || st === '学习中';
  });

  const filteredKps =
    subjectFilter === '全部'
      ? SHANGHAI_CURRICULUM
      : SHANGHAI_CURRICULUM.filter((k) => k.subject === subjectFilter);

  // Error 5-Dimension Loss Distribution & Repeated Mistake Aggregation (Tab 3)
  const errorStatsBase = useMemo(() => {
    return subjectFilter === '全部'
      ? errorRecords
      : errorRecords.filter((e) => e.subject === subjectFilter);
  }, [errorRecords, subjectFilter]);

  const totalLostAcrossBase = errorStatsBase.reduce((s, e) => s + e.scoreLost, 0);

  const errorTypeBreakdown = ERROR_TYPES.map((et) => {
    const matched = errorStatsBase.filter((e) => e.errorType === et);
    const lost = matched.reduce((s, e) => s + e.scoreLost, 0);
    const pct = totalLostAcrossBase > 0 ? Math.round((lost / totalLostAcrossBase) * 100) : 0;
    return { errorType: et, count: matched.length, lost, pct };
  }).sort((a, b) => b.lost - a.lost);

  const repeatedKnowledgeRank = useMemo(() => {
    const map: Record<
      string,
      {
        knowledgeId: string;
        knowledgeName: string;
        subject: Subject;
        count: number;
        totalLost: number;
        examNames: Set<string>;
        unresolvedCount: number;
      }
    > = {};

    for (const err of errorStatsBase) {
      if (!map[err.knowledgeId]) {
        map[err.knowledgeId] = {
          knowledgeId: err.knowledgeId,
          knowledgeName: err.knowledgeName,
          subject: err.subject,
          count: 0,
          totalLost: 0,
          examNames: new Set<string>(),
          unresolvedCount: 0,
        };
      }
      map[err.knowledgeId].count += 1;
      map[err.knowledgeId].totalLost += err.scoreLost;
      map[err.knowledgeId].examNames.add(err.examTitle);
      if (err.status !== '已闭环') {
        map[err.knowledgeId].unresolvedCount += 1;
      }
    }

    return Object.values(map)
      .map((item) => ({
        ...item,
        distinctExams: item.examNames.size,
      }))
      .sort((a, b) => {
        if (b.distinctExams !== a.distinctExams) return b.distinctExams - a.distinctExams;
        if (b.count !== a.count) return b.count - a.count;
        return b.totalLost - a.totalLost;
      })
      .slice(0, 5);
  }, [errorStatsBase]);

  const filteredErrors = useMemo(() => {
    const kw = searchKeyword.trim().toLowerCase();
    const list = errorRecords.filter((e) => {
      if (subjectFilter !== '全部' && e.subject !== subjectFilter) return false;
      if (errorTypeFilter !== '全部' && e.errorType !== errorTypeFilter) return false;
      if (statusFilter !== '全部' && e.status !== statusFilter) return false;
      if (examFilter !== '全部') {
        const matchedExam = exams.find((ex) => ex.id === examFilter);
        if (
          e.examId !== examFilter &&
          (!matchedExam || e.examTitle !== matchedExam.title)
        ) {
          return false;
        }
      }
      if (kw) {
        const hay = `${e.stem} ${e.knowledgeName} ${e.aiAnalysis} ${e.questionNumber} ${e.examTitle}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (errorSortBy === 'scoreLost') {
      return [...list].sort((a, b) => b.scoreLost - a.scoreLost);
    }
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [errorRecords, subjectFilter, errorTypeFilter, statusFilter, examFilter, exams, searchKeyword, errorSortBy]);

  return (
    <div className="space-y-8">
      {/* Header + Segmented Navigation */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            04. 提分效果评估与知识资产档案
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            涵盖多场考试成绩趋势、知识点掌握变化轨迹与五维错因整理分析，所有提分结论均依据独立作答证据
          </p>
        </div>

        <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {[
            { id: 'evaluation' as ReportTab, label: '提分效果与掌握变化' },
            { id: 'knowledge' as ReportTab, label: '知识点档案' },
            { id: 'errors' as ReportTab, label: '错题整理与归因分析' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {activeTab === 'evaluation' && (
        <div className="space-y-6">
          {/* 3-Layer Evaluation Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="text-xs font-medium text-slate-500">
                第一层 · 学习过程指标
              </div>
              <div className="text-3xl font-bold font-mono tabular-nums text-slate-900">
                {taskCompletionRate}%
                <span className="text-xs font-normal text-slate-500 ml-2">周任务完成率</span>
              </div>
              <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 space-y-1 font-mono tabular-nums">
                <div>累计有效学习：{totalMinutesLearned} 分钟</div>
                <div>无提示独立作答率：{independentRate}%</div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="text-xs font-medium text-slate-500">
                第二层 · 能力变化指标（需变式/复测验证）
              </div>
              <div className="text-3xl font-bold font-mono tabular-nums text-emerald-700">
                {repairedCount}
                <span className="text-xs font-normal text-slate-500 ml-2">
                  个漏洞已验证修复（另 {preliminaryCount} 个初步掌握）
                </span>
              </div>
              <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 space-y-1 font-mono tabular-nums">
                <div>变式与迁移测试正确率：{variantAccuracy}%</div>
                <div>累计验证作答：{learningAttempts.length} 次</div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="text-xs font-medium text-slate-500">
                第三层 · 考试成绩转化（最近对比）
              </div>
              <div className="space-y-2 pt-1">
                {subjectTrends.map((t) => (
                  <div
                    key={t.subject}
                    className="flex items-center justify-between text-xs border-b border-slate-100 pb-1.5 last:border-b-0"
                  >
                    <span className="font-medium text-slate-800">{t.subject}</span>
                    <div className="font-mono tabular-nums flex items-center gap-2">
                      <span className="text-slate-900 font-semibold">
                        {t.latest?.score ?? 0}/{t.latest?.fullScore ?? 100}
                      </span>
                      {t.delta !== 0 && (
                        <span className={t.delta > 0 ? 'text-emerald-700' : 'text-red-700'}>
                          {t.delta > 0 ? `+${t.delta}` : t.delta}
                        </span>
                      )}
                      <span className="text-slate-400">
                        目标 {t.latest?.targetScore ?? 90}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Multi-Exam Chronological Score Trend Matrix */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  全科历次考试成绩趋势对比矩阵（共 {chronologicalExams.length} 场考试）
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  按时间顺序横向追踪各科在每次月考、期中或诊断中的得分变化与目标差距
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-500">
                    <th className="py-3 px-6 font-medium">学科</th>
                    {chronologicalExams.map((ex) => (
                      <th key={ex.id} className="py-3 px-4 font-medium font-mono tabular-nums">
                        <div>{ex.date}</div>
                        <div className="text-slate-800 font-sans font-semibold">{ex.title}</div>
                      </th>
                    ))}
                    <th className="py-3 px-4 font-medium text-right">累计变化</th>
                    <th className="py-3 px-4 font-medium text-right">阶段目标</th>
                    <th className="py-3 px-6 font-medium text-right">距目标</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {subjectTrends.map((row) => {
                    const gap = row.latest
                      ? Math.max(0, row.latest.targetScore - row.latest.score)
                      : null;
                    return (
                      <tr key={row.subject} className="hover:bg-slate-50/50">
                        <td className="py-3.5 px-6 font-sans font-semibold text-slate-900">
                          {row.subject}
                        </td>
                        {row.perExamScores.map((res, idx) => (
                          <td key={chronologicalExams[idx].id} className="py-3.5 px-4 text-slate-700">
                            {res ? `${res.score} / ${res.fullScore}` : '--'}
                          </td>
                        ))}
                        <td className="py-3.5 px-4 text-right font-semibold">
                          {row.delta > 0 ? (
                            <span className="text-emerald-700">+{row.delta}分</span>
                          ) : row.delta < 0 ? (
                            <span className="text-red-700">{row.delta}分</span>
                          ) : (
                            <span className="text-slate-400">0分</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right text-blue-700 font-semibold">
                          {row.latest?.targetScore ?? '--'}
                        </td>
                        <td className="py-3.5 px-6 text-right text-slate-900">
                          {gap !== null ? `${gap}分` : '--'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Knowledge Mastery Change Trajectory Analysis */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    知识点掌握变化分析（6阶状态跃迁与回退轨迹）
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    追踪每次试卷诊断、基础/变式训练及延迟复测引起的知识点状态升降与净进步阶梯
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    {[
                      { id: 'all' as const, label: '全部变化' },
                      { id: 'up' as const, label: '仅看提升' },
                      { id: 'down' as const, label: '仅看回退/新暴露' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setHistoryDirectionFilter(opt.id)}
                        className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                          historyDirectionFilter === opt.id
                            ? 'bg-white text-slate-900 font-medium shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <select
                    value={historySubjectFilter}
                    onChange={(e) =>
                      setHistorySubjectFilter(e.target.value as '全部' | Subject)
                    }
                    className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                  >
                    <option value="全部">全部学科</option>
                    {ALL_SUBJECTS.map((sub) => (
                      <option key={sub} value={sub}>
                        {sub}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between">
                  <span className="text-slate-600">累计状态跃迁提升</span>
                  <span className="font-mono tabular-nums font-bold text-emerald-700 text-sm">
                    +{upgradeCount} 次
                  </span>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between">
                  <span className="text-slate-600">回退 / 考试新暴露漏洞</span>
                  <span className="font-mono tabular-nums font-bold text-amber-700 text-sm">
                    {regressionCount} 次
                  </span>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between">
                  <span className="text-slate-600">全科已巩固知识点占比</span>
                  <span className="font-mono tabular-nums font-bold text-blue-700 text-sm">
                    {consolidatedCount}/{SHANGHAI_CURRICULUM.length} ({consolidatedRatio}%)
                  </span>
                </div>
              </div>
            </div>

            {filteredHistory.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                当前筛选条件下暂无知识点状态变化记录。
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredHistory.map((ev) => {
                  const isUpgrade = ev.stepDelta > 0;
                  return (
                    <div
                      key={ev.id}
                      className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs hover:bg-slate-50/50"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-slate-500">
                          <span className="font-mono tabular-nums">
                            {ev.timestamp.slice(0, 10)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-slate-900">
                            {ev.subject} · {ev.knowledgeName}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-slate-700">
                            {ev.fromState} → {ev.toState}
                          </span>
                          <span
                            className={`inline-flex items-center gap-0.5 font-mono tabular-nums font-semibold ${
                              isUpgrade ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {isUpgrade ? (
                              <TrendingUp className="w-3.5 h-3.5" />
                            ) : (
                              <TrendingDown className="w-3.5 h-3.5" />
                            )}
                            {isUpgrade ? `+${ev.stepDelta}阶` : `${ev.stepDelta}阶`}
                          </span>
                        </div>
                        <div className="text-slate-600">{ev.trigger}</div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onLaunchCoach(ev.knowledgeId)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap self-start sm:self-auto"
                      >
                        去训练
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Parent & Student Summary */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                家长与学生周报摘要（真实证据驱动）
              </h2>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-xs leading-relaxed">
              <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl space-y-2">
                <div className="font-semibold text-slate-900">1. 已通过测试验证修复的漏洞</div>
                <ul className="space-y-1.5 text-slate-700">
                  {SHANGHAI_CURRICULUM.filter((kp) => {
                    const st = masteryRecords[kp.id]?.state;
                    return st === '初步掌握' || st === '掌握' || st === '稳定掌握';
                  }).map((kp) => (
                    <li key={kp.id} className="flex items-center justify-between gap-2">
                      <span>
                        {kp.subject} · {kp.name}
                      </span>
                      <span className="font-medium text-emerald-700 shrink-0">
                        {masteryRecords[kp.id]?.state}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl space-y-2">
                <div className="font-semibold text-slate-900">2. 仍需继续关注与巩固的薄弱点</div>
                <ul className="space-y-1.5 text-slate-700">
                  {stillWeakList.slice(0, 5).map((kp) => (
                    <li key={kp.id} className="flex items-center justify-between gap-2">
                      <span>
                        {kp.subject} · {kp.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => onLaunchCoach(kp.id)}
                        className="text-blue-700 hover:underline shrink-0"
                      >
                        去攻克
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl space-y-2">
                <div className="font-semibold text-slate-900">3. 下周学习计划调整依据</div>
                <p className="text-slate-700">
                  {plan.priorities[0]
                    ? `优先将时间配置给「${plan.priorities[0].subject} · ${plan.priorities[0].knowledgeName}」（预期投入 ${plan.priorities[0].learningCostHours} 小时可恢复 +${plan.priorities[0].expectedGain} 分）。`
                    : '核心考点已基本达标，下周转入延迟复测阶段。'}
                </p>
                <p className="text-slate-600">
                  每日预算严格控制在 {plan.effectiveDailyBudget} 分钟内，确保与学校作业不冲突，并通过变式题独立复测确认得分转化。
                </p>
              </div>
            </div>
          </section>

          {/* Recent Learning Attempts Trace */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200">
              <h2 className="text-sm font-semibold text-slate-900">
                近期独立评测与作答事件轨迹（LearningAttempt）
              </h2>
            </div>
            <div className="divide-y divide-slate-100">
              {learningAttempts.slice(0, 8).map((att) => (
                <div
                  key={att.id}
                  className="px-6 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-slate-500">
                      <span className="font-medium text-slate-800">{att.subject}</span>
                      <span aria-hidden="true">·</span>
                      <span>{att.mode}</span>
                      <span aria-hidden="true">·</span>
                      <span>{att.independent ? '无提示独立完成' : `使用 ${att.hintsUsed} 次提示`}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{att.timeSpentSeconds}秒</span>
                    </div>
                    <div className="text-slate-900">{att.questionStem}</div>
                    <div className="text-slate-500">{att.aiFeedback}</div>
                  </div>
                  <div
                    className={`font-semibold shrink-0 ${
                      att.isCorrect ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {att.isCorrect ? '通过' : '未通过'}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* Subject filter bar for Knowledge & Error Asset Tabs */}
      {(activeTab === 'knowledge' || activeTab === 'errors') && (
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto">
            {(['全部', ...ALL_SUBJECTS] as const).map((sub) => (
              <button
                key={sub}
                type="button"
                onClick={() => setSubjectFilter(sub)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  subjectFilter === sub
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sub}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tab 2: Knowledge Point Archive (Module 05A) */}
      {activeTab === 'knowledge' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {filteredKps.map((kp) => {
            const rec = masteryRecords[kp.id];
            return (
              <article
                key={kp.id}
                className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {kp.subject} · {kp.chapter} · {kp.domain}
                    </span>
                    <span className="font-semibold text-blue-700">
                      {rec?.state ?? '未诊断'}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-slate-900">{kp.name}</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">{kp.definition}</p>

                  <div className="text-xs space-y-1.5 pt-2 border-t border-slate-100">
                    <div>
                      <span className="font-medium text-slate-800">常见考法：</span>
                      <span className="text-slate-600">{kp.commonExamForms.join('、')}</span>
                    </div>
                    <div>
                      <span className="font-medium text-slate-800">高频易错点：</span>
                      <span className="text-slate-600">{kp.commonTraps.join('；')}</span>
                    </div>
                    <div>
                      <span className="font-medium text-slate-800">学习证据：</span>
                      <span className="text-slate-600">
                        {rec?.evidenceLogs[0] ?? '待采集'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs text-slate-500 font-mono tabular-nums">
                    变式通过：{rec?.variantPassed ? '是' : '待完成'} · 延迟复测：
                    {rec?.delayedRetestPassed ? '是' : '待完成'}
                  </span>
                  <button
                    type="button"
                    onClick={() => onLaunchCoach(kp.id)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800"
                  >
                    <span>进入训练</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Tab 3: Error Organization, 5-Dimension Analysis & Variant Archive (Module 05B & 05C) */}
      {activeTab === 'errors' && (
        <div className="space-y-6">
          {/* 5-Dimension Error Distribution + Repeated Mistake Analytics */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">
                  五维错因失分分析（{subjectFilter === '全部' ? '全科' : subjectFilter}共 {errorStatsBase.length} 题 · -{totalLostAcrossBase} 分）
                </h2>
                {errorTypeFilter !== '全部' && (
                  <button
                    type="button"
                    onClick={() => setErrorTypeFilter('全部')}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    清除错因筛选
                  </button>
                )}
              </div>

              <div className="space-y-2.5">
                {errorTypeBreakdown.map((item) => {
                  const isActive = errorTypeFilter === item.errorType;
                  return (
                    <button
                      key={item.errorType}
                      type="button"
                      onClick={() =>
                        setErrorTypeFilter(isActive ? '全部' : item.errorType)
                      }
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                        isActive
                          ? 'border-blue-600 bg-blue-50/50'
                          : 'border-slate-100 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-medium text-slate-800">{item.errorType}</span>
                        <span className="font-mono tabular-nums text-slate-600">
                          {item.count} 题 · 失 {item.lost} 分 ({item.pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-700 rounded-full transition-all"
                          style={{ width: `${item.pct}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  跨考试高频重复失分知识点排行
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  识别在多次考试中反复丢分的顽固漏洞，优先进入变式闭环训练
                </p>
              </div>

              {repeatedKnowledgeRank.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">暂无错题聚合数据</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {repeatedKnowledgeRank.map((rk) => (
                    <div
                      key={rk.knowledgeId}
                      className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="font-semibold text-slate-900">
                          {rk.subject} · {rk.knowledgeName}
                        </div>
                        <div className="text-slate-500 font-mono tabular-nums">
                          {rk.distinctExams > 1
                            ? `跨 ${rk.distinctExams} 场考试重复出错 · `
                            : ''}
                          累计 {rk.count} 题 · 共失 -{rk.totalLost} 分 ·{' '}
                          {rk.unresolvedCount > 0 ? (
                            <span className="text-amber-700 font-medium">
                              待闭环 {rk.unresolvedCount} 题
                            </span>
                          ) : (
                            <span className="text-emerald-700 font-medium">已全部闭环</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onLaunchCoach(rk.knowledgeId)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        去训练
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Multi-Dimensional Error Organizer Controls */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-900">
                多维错题整理与订正闭环（筛选结果 {filteredErrors.length} / {errorRecords.length} 道）
              </h2>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    placeholder="搜索题干、知识点或解析..."
                    className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg w-52 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <select
                  value={examFilter}
                  onChange={(e) => setExamFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                >
                  <option value="全部">全部考试场次</option>
                  {chronologicalExams.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.date} · {ex.title}
                    </option>
                  ))}
                </select>

                <select
                  value={errorTypeFilter}
                  onChange={(e) =>
                    setErrorTypeFilter(e.target.value as '全部' | ErrorType)
                  }
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                >
                  <option value="全部">全部错因类型</option>
                  {ERROR_TYPES.map((et) => (
                    <option key={et} value={et}>
                      {et}
                    </option>
                  ))}
                </select>

                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as '全部' | ErrorRecord['status'])
                  }
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                >
                  <option value="全部">全部订正状态</option>
                  {ERROR_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>

                <select
                  value={errorSortBy}
                  onChange={(e) =>
                    setErrorSortBy(e.target.value as 'recent' | 'scoreLost')
                  }
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                >
                  <option value="recent">按时间最新排序</option>
                  <option value="scoreLost">按失分从高到低</option>
                </select>
              </div>
            </div>
          </div>

          {/* Filtered Error Cards */}
          <div className="space-y-4">
            {filteredErrors.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
                当前筛选条件下暂无匹配错题，可放宽错因、状态或关键词条件。
              </div>
            ) : (
              filteredErrors.map((err) => {
                const linkedVariants = variantQuestions.filter(
                  (v) => v.sourceErrorId === err.id || v.knowledgeId === err.knowledgeId
                );
                const draft = correctionDrafts[err.id] ?? err.correctionNote ?? '';

                return (
                  <div
                    key={err.id}
                    className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono tabular-nums">{err.createdAt.slice(0, 10)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-900">
                          {err.subject} · {err.examTitle} {err.questionNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{err.knowledgeName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-red-700 font-medium">{err.errorType}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-700">
                          失分 -{err.scoreLost}分
                        </span>
                      </div>
                      <span
                        className={`font-semibold ${
                          err.status === '已闭环' || err.status === '已订正'
                            ? 'text-emerald-700'
                            : 'text-amber-700'
                        }`}
                      >
                        状态：{err.status}
                      </span>
                    </div>

                    <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg text-sm text-slate-900">
                      {err.stem}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 border border-slate-100 rounded-lg">
                        <span className="text-slate-500">学生原答：</span>
                        <span className="text-slate-800">{err.studentAnswer}</span>
                      </div>
                      <div className="p-3 border border-slate-100 rounded-lg">
                        <span className="text-slate-500">规范参考：</span>
                        <span className="text-emerald-800 font-medium">{err.correctAnswer}</span>
                      </div>
                    </div>

                    <div className="text-xs text-slate-700 space-y-1">
                      <div>
                        <span className="font-semibold text-slate-900">AI 分析：</span>
                        {err.aiAnalysis}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-900">关联变式题资产：</span>
                        {linkedVariants.length} 道（可验证同型迁移）
                      </div>
                    </div>

                    <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                      <input
                        type="text"
                        value={draft}
                        onChange={(e) =>
                          setCorrectionDrafts((prev) => ({
                            ...prev,
                            [err.id]: e.target.value,
                          }))
                        }
                        placeholder="记录你的订正心得（例如：下次先写分母不为0的条件）..."
                        className="flex-1 px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => onMarkErrorCorrected(err.id, draft)}
                          className="inline-flex items-center gap-1 px-3.5 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors whitespace-nowrap"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>标记已订正</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onLaunchCoach(err.knowledgeId)}
                          className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap"
                        >
                          去练变式题
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
