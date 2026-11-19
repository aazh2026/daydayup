import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Compass,
  GitBranch,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { ALL_SUBJECTS } from '../types.ts';
import { buildGradeOptions, filterByGrade } from '../utils/grade.ts';
import { SubjectKnowledgeMindMap } from './SubjectKnowledgeMindMap.tsx';
import {
  fetchBlockingSummary,
  type BlockingSummary,
} from '../api/prerequisite.ts';
import type {
  AppPage,
  ErrorRecord,
  Exam,
  ExamPaper,
  MasteryRecord,
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
  /** 需要在导图中定位的考点（跨页深链：来自提分报告的考点档案） */
  focusRequest?: { knowledgeId: string; token: number } | null;
  /** 需要在导图中定位的试卷（跨页深链：来自提分报告的试卷存档库） */
  initialPaperId?: string;
  /** 打开提分报告中的该考点档案 */
  onOpenArchive?: (knowledgeId: string) => void;
  /** 页面跳转（用于跳到提分报告的考点档案） */
  onNavigate?: (page: AppPage) => void;
  /** 打开提分报告的「考点档案」列表（图谱页不再重复实现考点清单） */
  onOpenArchiveList?: () => void;
}

/**
 * 视图模式。
 *
 * 只保留「结构拓扑」与「先修溯源」两个视角：
 * 考点清单不再在图谱页重复实现 —— 那是提分报告「考点档案」的职责，
 * 两处曾各写一套筛选器，口径还不一致。
 */
type ViewMode = 'graph' | 'prereq';

export const KnowledgePage: React.FC<KnowledgePageProps> = ({
  studentId,
  exams,
  examPapers,
  errorRecords,
  masteryRecords,
  onLaunchCoach,
  initialSubject,
  focusRequest,
  initialPaperId,
  onOpenArchive,
  onNavigate,
  onOpenArchiveList,
}) => {
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: KNOWLEDGE_POINTS,
  } = useCurriculum();

  const [selectedSubject, setSelectedSubject] = useState<Subject>(
    initialSubject ?? '数学'
  );
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [selectedPaperId, setSelectedPaperId] = useState<string>(
    initialPaperId && initialPaperId !== 'all' ? initialPaperId : 'all'
  );

  // 跨页深链：从提分报告的试卷存档库跳来时，聚焦该卷
  useEffect(() => {
    if (!initialPaperId) return;
    setSelectedPaperId(initialPaperId);
  }, [initialPaperId]);
  const [selectedGrade, setSelectedGrade] = useState<string>('all');

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

  // Available grade / stage filter options for current subject
  const gradeOptions = useMemo(
    () => buildGradeOptions(subjectKps),
    [subjectKps]
  );

  // Reset grade filter when the selected subject has no points in that grade
  useEffect(() => {
    if (selectedGrade === 'all') return;
    const exists = gradeOptions.some(
      (opt) => opt.id === selectedGrade && opt.count > 0
    );
    if (!exists) {
      setSelectedGrade('all');
    }
  }, [gradeOptions, selectedGrade]);

  // Knowledge points of current subject filtered by grade / stage
  const gradeFilteredKps = useMemo(
    () => filterByGrade(subjectKps, selectedGrade),
    [subjectKps, selectedGrade]
  );

  // Statistics for current subject
  const stats = useMemo(() => {
    let masteredCount = 0;
    let inProgressCount = 0;
    let pendingCount = 0;
    let unDiagnosedCount = 0;
    let totalLostScore = 0;
    let problemPointsCount = 0;

    for (const kp of gradeFilteredKps) {
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

    const total = gradeFilteredKps.length;
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
  }, [gradeFilteredKps, masteryRecords]);

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
            onClick={() => onOpenArchiveList?.()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white transition-colors"
            title="考点清单与掌握证据统一在提分报告中查看"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>考点档案</span>
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
            <span className="text-xs text-slate-400">个考点</span>
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
            focusKnowledgeId={focusRequest?.knowledgeId ?? null}
            focusToken={focusRequest?.token}
            onOpenArchive={onOpenArchive}
          />
        </div>
      )}

      {/* VIEW 2: Prerequisite Blocking Chain View */}
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
