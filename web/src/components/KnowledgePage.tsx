import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Circle,
  Compass,
  Filter,
  GitBranch,
  Layers,
  Search,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { ALL_SUBJECTS, MASTERY_ORDER } from '../types.ts';
import { Pagination } from './Pagination.tsx';
import { paginateList } from '../utils/pagination.ts';
import { SubjectKnowledgeMindMap } from './SubjectKnowledgeMindMap.tsx';
import {
  fetchBlockingSummary,
  type BlockingSummary,
} from '../api/prerequisite.ts';
import type {
  ErrorRecord,
  Exam,
  ExamPaper,
  KnowledgePoint,
  MasteryRecord,
  MasteryState,
  Subject,
} from '../types.ts';

export interface KnowledgePageProps {
  studentId: string;
  exams: Exam[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  onLaunchCoach: (knowledgeId: string) => void;
  initialSubject?: Subject;
  initialKnowledgeId?: string;
}

type ViewMode = 'graph' | 'matrix' | 'prereq';

export const KnowledgePage: React.FC<KnowledgePageProps> = ({
  studentId,
  exams,
  examPapers,
  errorRecords,
  masteryRecords,
  onLaunchCoach,
  initialSubject,
  initialKnowledgeId,
}) => {
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: KNOWLEDGE_POINTS,
  } = useCurriculum();

  const [selectedSubject, setSelectedSubject] = useState<Subject>(
    initialSubject ?? '数学'
  );
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [selectedPaperId, setSelectedPaperId] = useState<string>('all');
  const [selectedGrade, setSelectedGrade] = useState<string>('all');

  // Matrix view filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<string>('all');
  const [selectedStateFilter, setSelectedStateFilter] = useState<string>('all');
  const [onlyProblemPoints, setOnlyProblemPoints] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);

  // Prerequisite blockers data
  const [blockingSummary, setBlockingSummary] = useState<BlockingSummary | null>(null);
  const [blockingLoading, setBlockingLoading] = useState(false);

  // Load prerequisite blocking summary
  useEffect(() => {
    let cancelled = false;
    setBlockingLoading(true);
    fetchBlockingSummary(studentId)
      .then((data) => {
        if (!cancelled) setBlockingSummary(data);
      })
      .catch((err) => {
        console.warn('获取先修阻断分析失败:', err);
      })
      .finally(() => {
        if (!cancelled) setBlockingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Knowledge points of the selected subject
  const subjectKps = useMemo(
    () => KNOWLEDGE_POINTS.filter((kp) => kp.subject === selectedSubject),
    [KNOWLEDGE_POINTS, selectedSubject]
  );

  // Distinct domains for current subject
  const availableDomains = useMemo(() => {
    const set = new Set<string>();
    for (const kp of subjectKps) {
      if (kp.domain) set.add(kp.domain);
    }
    return Array.from(set);
  }, [subjectKps]);

  // Statistics for current subject
  const stats = useMemo(() => {
    let masteredCount = 0;
    let inProgressCount = 0;
    let pendingCount = 0;
    let unDiagnosedCount = 0;
    let totalLostScore = 0;
    let problemPointsCount = 0;

    for (const kp of subjectKps) {
      const rec = masteryRecords[kp.id];
      const state = rec?.state ?? '未诊断';
      if (state === '稳定掌握' || state === '掌握') {
        masteredCount++;
      } else if (state === '初步掌握' || state === '学习中') {
        inProgressCount++;
      } else if (state === '待学习') {
        pendingCount++;
      } else {
        unDiagnosedCount++;
      }

      if (rec && rec.lostScoreEvidence > 0) {
        totalLostScore += rec.lostScoreEvidence;
        problemPointsCount++;
      }
    }

    const total = subjectKps.length;
    const masteryRate = total > 0 ? Math.round((masteredCount / total) * 100) : 0;

    return {
      total,
      masteredCount,
      inProgressCount,
      pendingCount,
      unDiagnosedCount,
      masteryRate,
      totalLostScore,
      problemPointsCount,
    };
  }, [subjectKps, masteryRecords]);

  // Filtered knowledge points for matrix view
  const filteredKps = useMemo(() => {
    return subjectKps.filter((kp) => {
      if (selectedDomain !== 'all' && kp.domain !== selectedDomain) return false;

      const rec = masteryRecords[kp.id];
      const state: MasteryState = rec?.state ?? '未诊断';

      if (selectedStateFilter !== 'all' && state !== selectedStateFilter) {
        return false;
      }

      if (onlyProblemPoints) {
        const hasLostScore = (rec?.lostScoreEvidence ?? 0) > 0;
        const isProblem = state === '待学习' || state === '学习中' || hasLostScore;
        if (!isProblem) return false;
      }

      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const matchName = kp.name.toLowerCase().includes(query);
        const matchDomain = kp.domain.toLowerCase().includes(query);
        const matchChapter = (kp.chapter ?? '').toLowerCase().includes(query);
        const matchSub = (kp.subSkills ?? []).some((s) =>
          s.toLowerCase().includes(query)
        );
        if (!matchName && !matchDomain && !matchChapter && !matchSub) {
          return false;
        }
      }

      return true;
    });
  }, [
    subjectKps,
    selectedDomain,
    selectedStateFilter,
    onlyProblemPoints,
    searchQuery,
    masteryRecords,
  ]);

  const { pageItems: paginatedKps, pagination } = paginateList(
    filteredKps,
    page,
    pageSize
  );

  // Subject blocking root causes
  const subjectRootCauses = useMemo(() => {
    if (!blockingSummary) return [];
    return blockingSummary.rootCauses.filter((rc) => rc.subject === selectedSubject);
  }, [blockingSummary, selectedSubject]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header with Title & Subject Navigation */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 bg-blue-50 text-blue-700 rounded-xl">
              <GitBranch className="w-5 h-5" />
            </span>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              学科知识图谱与考点全景
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            覆盖上海初中学科大纲，多维可视化知识脉络层级、前置依赖链及动态掌握度
          </p>
        </div>

        {/* View Mode Switcher */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl self-start md:self-auto shrink-0 border border-slate-200">
          <button
            type="button"
            onClick={() => setViewMode('graph')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewMode === 'graph'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>知识图谱导图</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('matrix')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewMode === 'matrix'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>考点掌握矩阵</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('prereq')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewMode === 'prereq'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            <span>先修阻断溯源</span>
            {subjectRootCauses.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 bg-amber-100 text-amber-700 text-[10px] rounded-full font-semibold">
                {subjectRootCauses.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Subject Selector Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        {ALL_SUBJECTS.map((sub) => {
          const isSelected = selectedSubject === sub;
          const count = KNOWLEDGE_POINTS.filter((k) => k.subject === sub).length;
          return (
            <button
              key={sub}
              type="button"
              onClick={() => {
                setSelectedSubject(sub);
                setPage(1);
                setSelectedDomain('all');
              }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap border ${
                isSelected
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span>{sub}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  isSelected
                    ? 'bg-blue-700/60 text-white'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {count} 点
              </span>
            </button>
          );
        })}
      </div>

      {/* Key Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 font-medium">考点总数</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900 font-mono">
              {stats.total}
            </span>
            <span className="text-xs text-slate-400">个知识点</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            涵盖中考高频核心考点
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 font-medium">综合掌握率</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-emerald-700 font-mono">
              {stats.masteryRate}%
            </span>
            <span className="text-xs text-emerald-600">
              已稳固 {stats.masteredCount} 点
            </span>
          </div>
          <div className="mt-2 w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-300"
              style={{ width: `${stats.masteryRate}%` }}
            />
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 font-medium">待攻克薄弱点</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-700 font-mono">
              {stats.problemPointsCount}
            </span>
            <span className="text-xs text-amber-600">
              失分空间 -{stats.totalLostScore}分
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            学习中 {stats.inProgressCount} · 待学习 {stats.pendingCount}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 font-medium">先修阻断根因</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-indigo-700 font-mono">
              {subjectRootCauses.length}
            </span>
            <span className="text-xs text-indigo-600">个前置堵塞</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            需优先回溯夯实底层基础
          </div>
        </div>
      </div>

      {/* VIEW 1: Knowledge Graph Mind Map */}
      {viewMode === 'graph' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <SubjectKnowledgeMindMap
            subject={selectedSubject}
            examPapers={examPapers}
            exams={exams}
            errorRecords={errorRecords}
            masteryRecords={masteryRecords}
            selectedPaperId={selectedPaperId}
            onSelectPaperId={setSelectedPaperId}
            selectedGrade={selectedGrade}
            onSelectGrade={setSelectedGrade}
            onLaunchCoach={onLaunchCoach}
          />
        </div>
      )}

      {/* VIEW 2: Knowledge Point Mastery Matrix */}
      {viewMode === 'matrix' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              {/* Search */}
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="搜索知识点名称、领域板块、章节或子技能..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
                />
              </div>

              {/* State Filter */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <Filter className="w-3 h-3" />
                  状态：
                </span>
                {['all', '待学习', '学习中', '初步掌握', '掌握', '稳定掌握', '未诊断'].map(
                  (st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => {
                        setSelectedStateFilter(st);
                        setPage(1);
                      }}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                        selectedStateFilter === st
                          ? 'bg-blue-100 text-blue-700 font-medium'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {st === 'all' ? '全部' : st}
                    </button>
                  )
                )}

                <button
                  type="button"
                  onClick={() => {
                    setOnlyProblemPoints(!onlyProblemPoints);
                    setPage(1);
                  }}
                  className={`ml-2 px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                    onlyProblemPoints
                      ? 'bg-amber-50 text-amber-800 border-amber-300 font-medium'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  ⚠️ 仅看薄弱点
                </button>
              </div>
            </div>

            {/* Domain Filter Pills */}
            {availableDomains.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-slate-100">
                <span className="text-xs text-slate-500">板块：</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDomain('all');
                    setPage(1);
                  }}
                  className={`px-2 py-0.5 text-xs rounded-md ${
                    selectedDomain === 'all'
                      ? 'bg-slate-800 text-white font-medium'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  全部板块 ({subjectKps.length})
                </button>
                {availableDomains.map((dom) => {
                  const count = subjectKps.filter((k) => k.domain === dom).length;
                  return (
                    <button
                      key={dom}
                      type="button"
                      onClick={() => {
                        setSelectedDomain(dom);
                        setPage(1);
                      }}
                      className={`px-2 py-0.5 text-xs rounded-md ${
                        selectedDomain === dom
                          ? 'bg-slate-800 text-white font-medium'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {dom} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Knowledge Point Matrix Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  知识点状态机清单（共 {filteredKps.length} 项）
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  标准迁移路径：未诊断 → 待学习 → 学习中 → 初步掌握 → 掌握 → 稳定掌握
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewMode('graph')}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
              >
                在导图中查看全景拓扑 <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {filteredKps.length === 0 ? (
              <div className="p-12 text-center text-xs text-slate-500">
                没有找到符合条件的知识点，请调整筛选或搜索条件。
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {paginatedKps.map((kp) => {
                  const rec = masteryRecords[kp.id];
                  const stateLabel = rec?.state ?? '未诊断';
                  const acc =
                    rec && rec.practiceTotal > 0
                      ? Math.round((rec.practiceCorrect / rec.practiceTotal) * 100)
                      : null;

                  const stateColor =
                    stateLabel === '稳定掌握' || stateLabel === '掌握'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : stateLabel === '初步掌握' || stateLabel === '学习中'
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : stateLabel === '待学习'
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-slate-50 text-slate-600 border-slate-200';

                  const lostScore = rec?.lostScoreEvidence ?? 0;

                  return (
                    <div
                      key={kp.id}
                      className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                    >
                      <div className="space-y-1.5 flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[11px] font-medium">
                            {kp.domain}
                          </span>
                          {kp.chapter && (
                            <span className="text-slate-400">
                              {kp.chapter}
                            </span>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>置信度：{rec?.confidence ?? '待诊断'}</span>
                          {acc !== null && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-slate-600">
                                独立练习 {rec.practiceCorrect}/{rec.practiceTotal} ({acc}%)
                              </span>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-slate-900 truncate">
                            {kp.name}
                          </div>
                          {lostScore > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
                              失分 -{lostScore}分
                            </span>
                          )}
                        </div>

                        {/* Sub skills */}
                        {kp.subSkills && kp.subSkills.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] text-slate-400">子技能:</span>
                            {kp.subSkills.map((sub) => (
                              <span
                                key={sub}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600"
                              >
                                {sub}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="text-xs text-slate-500 line-clamp-1">
                          {rec?.evidenceLogs?.[0] ?? '暂无近期考试/练习作答证据'}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0 self-start sm:self-auto">
                        <div className="text-right">
                          <div
                            className={`inline-flex px-2.5 py-1 text-xs font-semibold rounded-lg border ${stateColor}`}
                          >
                            {stateLabel}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onLaunchCoach(kp.id)}
                          className="px-3.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap"
                        >
                          AI教练针对攻克
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
              <Pagination
                currentPage={pagination.currentPage}
                totalPages={pagination.totalPages}
                totalItems={pagination.totalItems}
                pageSize={pagination.pageSize}
                onPageChange={setPage}
                onPageSizeChange={(newSize) => {
                  setPageSize(newSize);
                  setPage(1);
                }}
                pageSizeOptions={[10, 20, 50]}
                itemName="个考点"
              />
            </div>
          </div>
        </div>
      )}

      {/* VIEW 3: Prerequisite Blocking Chain View */}
      {viewMode === 'prereq' && (
        <div className="space-y-6">
          <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-5 text-xs text-amber-900 leading-relaxed">
            <div className="flex items-start gap-2">
              <Compass className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm text-amber-950 mb-1">
                  先修依赖阻断分析（溯源学习机制）
                </h3>
                <p>
                  初中数学与理科具有严密的知识前置依赖关系。当学生在某个高年级考点（如二次函数最值或几何证明）屡次受挫时，
                  系统沿先修依赖图谱逆向溯源，定位其真正的底层「阻断根因」（例如：一元一次方程、因式分解或线段垂直平分线性质）。
                  优先巩固根因考点，可一次性疏通多个目标考点的提分瓶颈。
                </p>
              </div>
            </div>
          </div>

          {blockingLoading ? (
            <div className="p-12 text-center text-xs text-slate-500 bg-white border border-slate-200 rounded-xl">
              正在计算全量知识图谱先修依赖链路...
            </div>
          ) : subjectRootCauses.length === 0 ? (
            <div className="p-12 text-center bg-white border border-slate-200 rounded-xl space-y-3">
              <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
              <div className="text-sm font-semibold text-slate-800">
                当前学科暂未发现前置先修阻断
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                您的基础考点扎实，未发现低年级前置概念阻断高年级知识的情况。可继续围绕薄弱考点深入专项突破。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {subjectRootCauses.map((rc) => {
                // Find targets blocked by this root cause
                const blockedTargets = (blockingSummary?.blockedTargets ?? []).filter(
                  (t) => t.rootCauseId === rc.knowledgeId && t.subject === selectedSubject
                );

                return (
                  <div
                    key={rc.knowledgeId}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">
                            阻断根因
                          </span>
                          <span className="text-xs text-slate-500">
                            阻断 {rc.blockingCount} 个后续高阶考点
                          </span>
                        </div>
                        <h4 className="text-base font-bold text-slate-900 mt-1">
                          {rc.name}
                        </h4>
                      </div>
                      <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                        {rc.state}
                      </span>
                    </div>

                    {blockedTargets.length > 0 && (
                      <div className="space-y-1.5 pt-2 border-t border-slate-100">
                        <div className="text-xs font-medium text-slate-600">
                          受阻断的后续目标考点：
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {blockedTargets.map((bt) => (
                            <span
                              key={bt.knowledgeId}
                              className="px-2 py-1 rounded-md text-xs bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1"
                            >
                              <span>{bt.name}</span>
                              <span className="text-slate-400 text-[10px]">
                                (跨{bt.depth}阶)
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        建议：优先消灭根因，打通知识堵塞
                      </span>
                      <button
                        type="button"
                        onClick={() => onLaunchCoach(rc.knowledgeId)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-1"
                      >
                        优先攻克此根因 <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
