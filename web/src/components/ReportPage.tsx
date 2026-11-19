import React, { useEffect, useMemo, useState } from 'react';
import { MathText } from './MathText.tsx';
import {
  AlertTriangle,
  ArrowRight,
  Award,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Compass,
  ExternalLink,
  FileText,
  Filter,
  GitBranch,
  HelpCircle,
  Layers,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Target,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { MASTERY_ORDER } from '../engine/planner.ts';
import { ALL_SUBJECTS } from '../types.ts';
import { SubjectKnowledgeMindMap, resolveGradeInfo } from './SubjectKnowledgeMindMap.tsx';
import { Pagination } from './Pagination.tsx';
import { paginateList } from '../utils/pagination.ts';
import { loadSession } from '../store/auth.ts';
import {
  fetchBlockingSummary,
  type BlockingSummary,
} from '../api/prerequisite.ts';
import type {
  AppPage,
  ErrorRecord,
  ErrorType,
  Exam,
  ExamPaper,
  ExamResult,
  KnowledgePoint,
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
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  masteryHistory: MasteryTransitionEvent[];
  learningAttempts: LearningAttempt[];
  variantQuestions: VariantQuestion[];
  plan: LearningPlan;
  onMarkErrorCorrected: (errorId: string, note: string) => void;
  onLaunchCoach: (knowledgeId: string) => void;
  onNavigate?: (page: AppPage) => void;
}

type ReportTab = 'evaluation' | 'papers' | 'knowledge' | 'errors';

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
  examPapers,
  errorRecords,
  masteryRecords,
  masteryHistory,
  learningAttempts,
  variantQuestions,
  plan,
  onMarkErrorCorrected,
  onLaunchCoach,
  onNavigate,
}) => {
  /** 知识体系（服务端资产） */
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: SHANGHAI_CURRICULUM,
  } = useCurriculum();

  const [activeTab, setActiveTab] = useState<ReportTab>('evaluation');
  const [subjectFilter, setSubjectFilter] = useState<'全部' | Subject>('全部');
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});

  // Mastery Change Analysis Filters (Tab 1)
  const [historyDirectionFilter, setHistoryDirectionFilter] = useState<'all' | 'up' | 'down'>('all');
  const [historySubjectFilter, setHistorySubjectFilter] = useState<'全部' | Subject>('全部');

  // Paper Analysis Archive Filters (Tab 2)
  const [paperExamFilter, setPaperExamFilter] = useState<string>('全部');
  const [paperFormatFilter, setPaperFormatFilter] = useState<
    '全部' | '试卷拍照' | '文本试卷' | '单题录入'
  >('全部');
  const [paperSearchKeyword, setPaperSearchKeyword] = useState('');
  const [expandedArchivePaperId, setExpandedArchivePaperId] = useState<string | null>(null);
  const [mindMapArchivePaperId, setMindMapArchivePaperId] = useState<string | null>(null);

  /**
   * 阻断根因概况（服务端 PrerequisiteEngine 计算）。
   *
   * 与「薄弱点列表」的本质区别：
   * - 薄弱点 = 直接失分的知识点
   * - 阻断根因 = **导致**这些知识点学不上的最底层缺口
   *
   * 例：二次函数不会 → 根因可能是一年级的「1到5各数的认识」，
   * 而不是「二次函数」本身。这个区分是提分效率的关键。
   */
  const [blockingSummary, setBlockingSummary] = useState<BlockingSummary | null>(null);
  const [blockingError, setBlockingError] = useState<string | null>(null);

  const studentId = useMemo(() => loadSession()?.studentIds?.[0] ?? '', []);

  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const summary = await fetchBlockingSummary(studentId);
        if (!cancelled) {
          setBlockingSummary(summary);
          setBlockingError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setBlockingError(
            err instanceof Error ? err.message : '根因分析加载失败'
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Multi-Dimensional Error Organization Filters (Tab 4)
  const [errorTypeFilter, setErrorTypeFilter] = useState<'全部' | ErrorType>('全部');
  const [statusFilter, setStatusFilter] = useState<'全部' | ErrorRecord['status']>('全部');
  const [examFilter, setExamFilter] = useState<string>('全部');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [errorSortBy, setErrorSortBy] = useState<'recent' | 'scoreLost'>('recent');

  // Multi-Dimensional Knowledge Archive Filters (Tab 3)
  const [knowledgeSearchKeyword, setKnowledgeSearchKeyword] = useState('');
  const [knowledgeGradeFilter, setKnowledgeGradeFilter] = useState<string>('all');
  const [knowledgeStateFilter, setKnowledgeStateFilter] = useState<string>('all');
  const [knowledgeDomainFilter, setKnowledgeDomainFilter] = useState<string>('all');
  const [knowledgeSortBy, setKnowledgeSortBy] = useState<'default' | 'weight' | 'cost' | 'lostScore'>('default');
  const [selectedDetailKp, setSelectedDetailKp] = useState<KnowledgePoint | null>(null);

  // Pagination states for all tabs
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(10);

  const [paperPage, setPaperPage] = useState(1);
  const [paperPageSize, setPaperPageSize] = useState(5);

  const [knowledgePage, setKnowledgePage] = useState(1);
  const [knowledgePageSize, setKnowledgePageSize] = useState(12);

  const [errorPage, setErrorPage] = useState(1);
  const [errorPageSize, setErrorPageSize] = useState(10);

  // Reset pagination when respective filters change
  useEffect(() => {
    setKnowledgePage(1);
  }, [
    subjectFilter,
    knowledgeSearchKeyword,
    knowledgeGradeFilter,
    knowledgeStateFilter,
    knowledgeDomainFilter,
    knowledgeSortBy,
  ]);

  // 当切换学科后，如果所选领域在当前学科下不存在，自动重置为 'all'
  useEffect(() => {
    if (knowledgeDomainFilter === 'all') return;
    const currentSubjectKps =
      subjectFilter === '全部'
        ? SHANGHAI_CURRICULUM
        : SHANGHAI_CURRICULUM.filter((k) => k.subject === subjectFilter);
    const domainExists = currentSubjectKps.some((k) => k.domain === knowledgeDomainFilter);
    if (!domainExists) {
      setKnowledgeDomainFilter('all');
    }
  }, [subjectFilter, knowledgeDomainFilter, SHANGHAI_CURRICULUM]);

  useEffect(() => {
    setHistoryPage(1);
  }, [historyDirectionFilter, historySubjectFilter]);

  useEffect(() => {
    setPaperPage(1);
  }, [subjectFilter, paperExamFilter, paperFormatFilter, paperSearchKeyword]);

  useEffect(() => {
    setErrorPage(1);
  }, [subjectFilter, errorTypeFilter, statusFilter, examFilter, searchKeyword, errorSortBy]);

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

  // 当前学科下的全量知识点基准（用于统计选项分布）
  const subjectBaseKps = useMemo(() => {
    return subjectFilter === '全部'
      ? SHANGHAI_CURRICULUM
      : SHANGHAI_CURRICULUM.filter((k) => k.subject === subjectFilter);
  }, [SHANGHAI_CURRICULUM, subjectFilter]);

  // 可用板块领域
  const availableDomains = useMemo(() => {
    const set = new Set<string>();
    for (const kp of subjectBaseKps) {
      if (kp.domain) set.add(kp.domain);
    }
    return Array.from(set).sort();
  }, [subjectBaseKps]);

  // 可用年级分布
  const knowledgeGradeOptions = useMemo(() => {
    const counts = {
      all: subjectBaseKps.length,
      初三: 0,
      初二: 0,
      初一: 0,
      junior: 0,
      primary: 0,
      senior: 0,
    };
    for (const kp of subjectBaseKps) {
      const info = resolveGradeInfo(kp.chapter);
      if (info.grade === '初三') counts['初三']++;
      if (info.grade === '初二') counts['初二']++;
      if (info.grade === '初一') counts['初一']++;
      if (info.stage === '初中') counts.junior++;
      if (info.stage === '小学') counts.primary++;
      if (info.stage === '高中') counts.senior++;
    }
    const options: Array<{ id: string; label: string; count: number }> = [
      { id: 'all', label: '全部年级', count: counts.all },
    ];
    if (counts['初三'] > 0) {
      options.push({ id: '初三', label: '初三（九年级）', count: counts['初三'] });
    }
    if (counts['初二'] > 0) {
      options.push({ id: '初二', label: '初二（八年级）', count: counts['初二'] });
    }
    if (counts['初一'] > 0) {
      options.push({ id: '初一', label: '初一（七年级）', count: counts['初一'] });
    }
    if (counts.junior > counts['初三'] && (counts['初二'] > 0 || counts['初一'] > 0)) {
      options.push({ id: 'junior', label: '初中全学段', count: counts.junior });
    }
    if (counts.primary > 0) {
      options.push({ id: 'primary', label: '小学阶段（先修回溯）', count: counts.primary });
    }
    if (counts.senior > 0) {
      options.push({ id: 'senior', label: '高中阶段（衔接拓展）', count: counts.senior });
    }
    return options;
  }, [subjectBaseKps]);

  // 多维筛选后的知识点列表
  const filteredKps = useMemo(() => {
    const kw = knowledgeSearchKeyword.trim().toLowerCase();
    const result = subjectBaseKps.filter((kp) => {
      // 1. 领域/板块筛选
      if (knowledgeDomainFilter !== 'all' && kp.domain !== knowledgeDomainFilter) {
        return false;
      }

      // 2. 年级/学段筛选
      if (knowledgeGradeFilter !== 'all') {
        const info = resolveGradeInfo(kp.chapter);
        if (knowledgeGradeFilter === 'junior' && info.stage !== '初中') return false;
        if (knowledgeGradeFilter === 'primary' && info.stage !== '小学') return false;
        if (knowledgeGradeFilter === 'senior' && info.stage !== '高中') return false;
        if (
          ['初三', '初二', '初一'].includes(knowledgeGradeFilter) &&
          info.grade !== knowledgeGradeFilter
        ) {
          return false;
        }
      }

      // 3. 掌握度状态筛选
      const rec = masteryRecords[kp.id];
      const state = rec?.state ?? '未诊断';
      if (knowledgeStateFilter !== 'all') {
        if (knowledgeStateFilter === '薄弱需攻克') {
          const hasLostScore = (rec?.lostScoreEvidence ?? 0) > 0;
          if (state !== '待学习' && state !== '学习中' && !hasLostScore) {
            return false;
          }
        } else if (state !== knowledgeStateFilter) {
          return false;
        }
      }

      // 4. 关键字搜索（匹配知识点名称、章节、板块、定义、考法、避坑、细分技能）
      if (kw) {
        const hay = [
          kp.name,
          kp.chapter,
          kp.domain,
          kp.definition,
          ...(kp.commonExamForms ?? []),
          ...(kp.commonTraps ?? []),
          ...(kp.subSkills ?? []),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }

      return true;
    });

    // 5. 排序处理
    return result.sort((a, b) => {
      if (knowledgeSortBy === 'weight') {
        return (b.examWeight ?? 1) - (a.examWeight ?? 1);
      }
      if (knowledgeSortBy === 'cost') {
        return (a.learningCostHours ?? 1) - (b.learningCostHours ?? 1);
      }
      if (knowledgeSortBy === 'lostScore') {
        const lostA = masteryRecords[a.id]?.lostScoreEvidence ?? 0;
        const lostB = masteryRecords[b.id]?.lostScoreEvidence ?? 0;
        return lostB - lostA;
      }
      return 0; // 默认考纲顺序
    });
  }, [
    subjectBaseKps,
    knowledgeDomainFilter,
    knowledgeGradeFilter,
    knowledgeStateFilter,
    knowledgeSearchKeyword,
    knowledgeSortBy,
    masteryRecords,
  ]);

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

  const filteredPapers = useMemo(() => {
    const kw = paperSearchKeyword.trim().toLowerCase();
    return [...examPapers]
      .filter((p) => {
        if (subjectFilter !== '全部' && p.subject !== subjectFilter) return false;
        if (paperExamFilter !== '全部' && p.examId !== paperExamFilter) return false;
        const fmt = p.sourceFormat ?? '试卷拍照';
        if (paperFormatFilter !== '全部' && fmt !== paperFormatFilter) return false;
        if (kw) {
          const hay = `${p.title} ${p.examTitle ?? ''} ${p.summary} ${p.rawText ?? ''}`.toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const dateCmp = b.date.localeCompare(a.date);
        if (dateCmp !== 0) return dateCmp;
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      });
  }, [examPapers, subjectFilter, paperExamFilter, paperFormatFilter, paperSearchKeyword]);

  const { pageItems: paginatedHistory, pagination: historyPagination } = paginateList(
    filteredHistory,
    historyPage,
    historyPageSize
  );

  const { pageItems: paginatedPapers, pagination: paperPagination } = paginateList(
    filteredPapers,
    paperPage,
    paperPageSize
  );

  const { pageItems: paginatedKps, pagination: knowledgePagination } = paginateList(
    filteredKps,
    knowledgePage,
    knowledgePageSize
  );

  const { pageItems: paginatedErrors, pagination: errorPagination } = paginateList(
    filteredErrors,
    errorPage,
    errorPageSize
  );

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

        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {[
            { id: 'evaluation' as ReportTab, label: '提分效果与掌握变化' },
            { id: 'papers' as ReportTab, label: '试卷分析存档库' },
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
              <div>
                <div className="divide-y divide-slate-100">
                  {paginatedHistory.map((ev) => {
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
                <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
                  <Pagination
                    currentPage={historyPagination.currentPage}
                    totalPages={historyPagination.totalPages}
                    totalItems={historyPagination.totalItems}
                    pageSize={historyPagination.pageSize}
                    onPageChange={setHistoryPage}
                    onPageSizeChange={(newSize) => {
                      setHistoryPageSize(newSize);
                      setHistoryPage(1);
                    }}
                    pageSizeOptions={[5, 10, 20, 50]}
                    itemName="条记录"
                  />
                </div>
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

          {/* Blocking Root Causes —— 传递性根因分析（服务端 PrerequisiteEngine） */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-blue-700" />
              <h2 className="text-base font-semibold text-slate-900">
                提分阻断根因（沿先修链回溯到最底层缺口）
              </h2>
            </div>

            {blockingError ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                根因分析暂不可用：{blockingError}
              </p>
            ) : !blockingSummary ? (
              <p className="text-xs text-slate-500">正在分析先修链…</p>
            ) : blockingSummary.stats.blockedTargetCount === 0 ? (
              <p className="text-xs text-slate-600">
                当前没有被先修知识阻断的提分机会 —— 可直接攻克上层知识点。
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-600 leading-relaxed">
                  「薄弱点」是直接失分的知识点；「阻断根因」是导致它学不上的
                  <span className="font-medium text-slate-900">最底层缺口</span>。
                  共 {blockingSummary.stats.blockedTargetCount} 个提分机会被阻断，
                  归纳为 {blockingSummary.stats.rootCauseCount} 个根因，
                  最深的一条先修链跨越 {blockingSummary.stats.maxDepth} 层。
                  补根因比补表层更省时间。
                </p>

                {blockingSummary.stats.diagnosedCount === 0 && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                    尚无任何诊断或作答证据，下表呈现的是按先修依赖推导的潜在阻断。
                    完成一次试卷诊断后，这里的根因会收敛到真实失分链上。
                  </p>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200">
                        <th className="py-2 pr-3 font-medium">根因知识点</th>
                        <th className="py-2 pr-3 font-medium">学科</th>
                        <th className="py-2 pr-3 font-medium">状态</th>
                        <th className="py-2 pr-3 font-medium">阻断目标数</th>
                        <th className="py-2 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {blockingSummary.rootCauses.slice(0, 8).map((root) => (
                        <tr key={root.knowledgeId}>
                          <td className="py-2 pr-3 text-slate-900">{root.name}</td>
                          <td className="py-2 pr-3 text-slate-600">{root.subject}</td>
                          <td className="py-2 pr-3">
                            <span
                              className={
                                root.state === '未诊断'
                                  ? 'text-slate-500'
                                  : 'text-amber-700'
                              }
                            >
                              {root.state}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-slate-700">
                            {root.blockingCount} 个
                          </td>
                          <td className="py-2">
                            <button
                              type="button"
                              onClick={() => onLaunchCoach(root.knowledgeId)}
                              className="text-blue-700 hover:underline"
                            >
                              去攻克
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {blockingSummary.rootCauses.length > 8 && (
                  <p className="text-[11px] text-slate-500">
                    仅显示阻断影响最大的 8 个，共 {blockingSummary.rootCauses.length} 个根因。
                  </p>
                )}
              </>
            )}
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
                    <div className="text-slate-900"><MathText text={att.questionStem} /></div>
                    <div className="text-slate-500"><MathText text={att.aiFeedback} /></div>
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

      {/* Subject filter bar for Papers, Knowledge & Error Asset Tabs */}
      {(activeTab === 'papers' || activeTab === 'knowledge' || activeTab === 'errors') && (
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

      {/* Tab 2: Paper Analysis Archive Library */}
      {activeTab === 'papers' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  试卷分析存档库（共归档 {examPapers.length} 份 · 当前匹配 {filteredPapers.length} 份）
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  每份诊断过的图片或文本试卷均独立留存元信息、五维错因分布、原始文本/图像及后续知识点掌握变化，支持跨考复盘分析
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={paperSearchKeyword}
                    onChange={(e) => setPaperSearchKeyword(e.target.value)}
                    placeholder="搜索试卷名称、场次、摘要或文本..."
                    className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg w-60 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <select
                  value={paperExamFilter}
                  onChange={(e) => setPaperExamFilter(e.target.value)}
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
                  value={paperFormatFilter}
                  onChange={(e) =>
                    setPaperFormatFilter(
                      e.target.value as '全部' | '试卷拍照' | '文本试卷' | '单题录入'
                    )
                  }
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
                >
                  <option value="全部">全部输入形式</option>
                  <option value="试卷拍照">试卷拍照</option>
                  <option value="文本试卷">文本试卷</option>
                  <option value="单题录入">单题录入</option>
                </select>
              </div>
            </div>
          </section>

          {filteredPapers.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
              当前筛选条件下暂无试卷分析存档，可前往「考试诊断」上传图片或解析文本试卷生成存档。
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-5">
                {paginatedPapers.map((paper) => {
                const matchedExam = exams.find((ex) => ex.id === paper.examId);
                const displayExamTitle = paper.examTitle ?? matchedExam?.title ?? '未归类场次';
                const displayExamType = paper.examType ?? matchedExam?.type ?? '随堂诊断';
                const linkedErrors = errorRecords.filter(
                  (err) =>
                    err.examPaperId === paper.id ||
                    (err.examId === paper.examId && err.subject === paper.subject)
                );
                const closedErrorsCount = linkedErrors.filter(
                  (err) => err.status === '已闭环'
                ).length;

                const kpIds = Array.from(
                  new Set([
                    ...(paper.knowledgeIds ?? []),
                    ...linkedErrors.map((err) => err.knowledgeId),
                  ])
                );

                const paperErrorBreakdown = ERROR_TYPES.map((et) => {
                  const matched = linkedErrors.filter((e) => e.errorType === et);
                  const lost = matched.reduce((s, e) => s + e.scoreLost, 0);
                  return { errorType: et, count: matched.length, lost };
                }).filter((x) => x.count > 0);

                const isExpanded = expandedArchivePaperId === paper.id;

                return (
                  <article
                    key={paper.id}
                    className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
                  >
                    {/* Header Metadata */}
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono tabular-nums">{paper.date}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-blue-700">{paper.subject}</span>
                          <span aria-hidden="true">·</span>
                          <span>{displayExamType}</span>
                          <span aria-hidden="true">·</span>
                          <span>{displayExamTitle}</span>
                          <span aria-hidden="true">·</span>
                          <span>{paper.sourceFormat ?? '试卷拍照'}</span>
                          <span aria-hidden="true">·</span>
                          <span className="text-emerald-700 font-medium">{paper.status}</span>
                        </div>
                        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                          <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                          <span>{paper.title}</span>
                        </h3>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums shrink-0">
                        <div className="px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                          <div className="text-slate-500 font-sans">卷面得分</div>
                          <div className="font-bold text-slate-900 mt-0.5">
                            {typeof paper.score === 'number' && paper.score >= 0
                              ? `${paper.score} / ${paper.fullScore ?? 100}`
                              : '未记录'}
                          </div>
                        </div>
                        <div className="px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                          <div className="text-slate-500 font-sans">识别题量</div>
                          <div className="font-bold text-slate-900 mt-0.5">
                            {paper.questionsCount} 题
                          </div>
                        </div>
                        <div className="px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                          <div className="text-slate-500 font-sans">本卷失分</div>
                          <div className="font-bold text-red-700 mt-0.5">
                            -{paper.totalLostScore} 分
                          </div>
                        </div>
                        <div className="px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                          <div className="text-slate-500 font-sans">错题闭环</div>
                          <div className="font-bold text-emerald-700 mt-0.5">
                            {closedErrorsCount} / {linkedErrors.length}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Diagnostic Summary */}
                    <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-xs text-slate-700 leading-relaxed">
                      <span className="font-semibold text-slate-900">AI 卷面分析摘要：</span>
                      <MathText text={paper.summary} />
                    </div>

                    {/* 5-Dimension Breakdown + Subsequent Knowledge Mastery Tracking */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="p-4 border border-slate-200 rounded-lg space-y-2.5">
                        <div className="text-xs font-semibold text-slate-900">
                          本卷五维错因失分拆解
                        </div>
                        {paperErrorBreakdown.length === 0 ? (
                          <div className="text-xs text-slate-500">本卷暂未关联结构化错题记录</div>
                        ) : (
                          <div className="space-y-2">
                            {paperErrorBreakdown.map((eb) => {
                              const baseTotal = linkedErrors.reduce((s, e) => s + e.scoreLost, 0);
                              const pct = baseTotal > 0 ? Math.round((eb.lost / baseTotal) * 100) : 0;
                              return (
                                <div key={eb.errorType} className="space-y-1 text-xs">
                                  <div className="flex items-center justify-between">
                                    <span className="text-slate-700 font-medium">{eb.errorType}</span>
                                    <span className="font-mono tabular-nums text-slate-600">
                                      {eb.count} 题 · -{eb.lost} 分 ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-blue-700 rounded-full"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="p-4 border border-slate-200 rounded-lg space-y-2.5">
                        <div className="text-xs font-semibold text-slate-900">
                          涉及知识点当前掌握追踪（诊断后复盘）
                        </div>
                        {kpIds.length === 0 ? (
                          <div className="text-xs text-slate-500">暂无关联知识点记录</div>
                        ) : (
                          <div className="divide-y divide-slate-100">
                            {kpIds.map((kpId) => {
                              const kp = KNOWLEDGE_MAP[kpId];
                              const rec = masteryRecords[kpId];
                              const state = rec?.state ?? '未诊断';
                              const isGood =
                                state === '初步掌握' ||
                                state === '掌握' ||
                                state === '稳定掌握';
                              return (
                                <div
                                  key={kpId}
                                  className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-xs"
                                >
                                  <div className="min-w-0">
                                    <span className="font-medium text-slate-800">
                                      {kp?.name ?? kpId}
                                    </span>
                                    <span className="text-slate-400 mx-1.5">·</span>
                                    <span
                                      className={`font-semibold ${
                                        isGood ? 'text-emerald-700' : 'text-amber-700'
                                      }`}
                                    >
                                      {state}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => onLaunchCoach(kpId)}
                                    className="text-blue-700 hover:underline font-medium shrink-0"
                                  >
                                    去训练
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Expandable Full Archive Details & Mind Map Localization */}
                    <div className="pt-2 border-t border-slate-100 space-y-4">
                      <div className="flex flex-wrap items-center gap-4">
                        <button
                          type="button"
                          onClick={() =>
                            setMindMapArchivePaperId(
                              mindMapArchivePaperId === paper.id ? null : paper.id
                            )
                          }
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-800 hover:text-blue-700"
                        >
                          <GitBranch className="w-3.5 h-3.5 text-blue-700" />
                          <span>
                            {mindMapArchivePaperId === paper.id
                              ? '收起学科知识思维导图'
                              : '在学科思维导图上标记本卷问题点'}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setExpandedArchivePaperId(isExpanded ? null : paper.id)
                          }
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-800"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="w-3.5 h-3.5" />
                              <span>收起归因错题与原始文本/图片存档</span>
                            </>
                          ) : (
                            <>
                              <ChevronDown className="w-3.5 h-3.5" />
                              <span>
                                查看归因错题与原始文本/图片存档（{linkedErrors.length} 道关联错题
                                {paper.rawText ? ' · 含原始文本' : ''}
                                {paper.imageUrl ? ' · 含卷面图像' : ''}）
                              </span>
                            </>
                          )}
                        </button>
                      </div>

                      {mindMapArchivePaperId === paper.id && (
                        <SubjectKnowledgeMindMap
                          subject={paper.subject}
                          examPapers={examPapers}
                          exams={exams}
                          errorRecords={errorRecords}
                          masteryRecords={masteryRecords}
                          selectedPaperId={paper.id}
                          onLaunchCoach={onLaunchCoach}
                          compactHeader={true}
                        />
                      )}

                      {isExpanded && (
                        <div className="space-y-4">
                          {linkedErrors.length > 0 && (
                            <div className="space-y-2.5">
                              <div className="text-xs font-semibold text-slate-900">
                                本卷关联错题归因清单（{linkedErrors.length} 题）
                              </div>
                              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                                {linkedErrors.map((err) => (
                                  <div
                                    key={err.id}
                                    className="p-3.5 text-xs space-y-1.5 bg-white first:rounded-t-lg last:rounded-b-lg"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex flex-wrap items-center gap-1.5 text-slate-600">
                                        <span className="font-semibold text-slate-900">
                                          {err.questionNumber}
                                        </span>
                                        <span aria-hidden="true">·</span>
                                        <span>{err.knowledgeName}</span>
                                        <span aria-hidden="true">·</span>
                                        <span className="text-red-700 font-medium">
                                          {err.errorType}
                                        </span>
                                        <span aria-hidden="true">·</span>
                                        <span className="font-mono tabular-nums">
                                          -{err.scoreLost}分
                                        </span>
                                        <span aria-hidden="true">·</span>
                                        <span
                                          className={
                                            err.status === '已闭环'
                                              ? 'text-emerald-700 font-medium'
                                              : 'text-amber-700 font-medium'
                                          }
                                        >
                                          {err.status}
                                        </span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => onLaunchCoach(err.knowledgeId)}
                                        className="text-blue-700 hover:underline font-medium shrink-0"
                                      >
                                        变式复测
                                      </button>
                                    </div>
                                    <div className="text-slate-800"><MathText text={err.stem} /></div>
                                    <div className="text-slate-500">
                                      原答：<MathText text={err.studentAnswer} /> ｜ 参考：<MathText text={err.correctAnswer} /> ｜ 归因：
                                      <MathText text={err.aiAnalysis} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {paper.rawText && (
                            <div className="space-y-1.5">
                              <div className="text-xs font-semibold text-slate-900">
                                归档原始文本试卷 / AI 前序解读稿
                              </div>
                              <pre className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                                {paper.rawText}
                              </pre>
                            </div>
                          )}

                          {paper.imageUrl && (
                            <div className="space-y-1.5">
                              <div className="text-xs font-semibold text-slate-900">
                                归档卷面图像
                              </div>
                              <img
                                src={paper.imageUrl}
                                alt={paper.title}
                                referrerPolicy="no-referrer"
                                className="max-h-72 rounded-lg border border-slate-200 object-contain bg-slate-50"
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <Pagination
                  currentPage={paperPagination.currentPage}
                  totalPages={paperPagination.totalPages}
                  totalItems={paperPagination.totalItems}
                  pageSize={paperPagination.pageSize}
                  onPageChange={setPaperPage}
                  onPageSizeChange={(newSize) => {
                    setPaperPageSize(newSize);
                    setPaperPage(1);
                  }}
                  pageSizeOptions={[3, 5, 10, 20]}
                  itemName="份试卷"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Knowledge Point Archive (Module 05A) */}
      {activeTab === 'knowledge' && (
        <div className="space-y-5">
          {/* Multi-Dimensional Filter Console */}
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-blue-600" />
                  <span>
                    知识点全景档案（{subjectFilter === '全部' ? '全学科' : subjectFilter} · 当前匹配 {filteredKps.length} / 共 {subjectBaseKps.length} 个核心考点）
                  </span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  涵盖考纲权重、学习成本工时、分步子技能要求、前置先修链路、高频出题题型与常考避坑点，支持跨年级与掌握状态精准筛选
                </p>
              </div>

              {/* Active Filter Counter & Quick Reset */}
              <div className="flex items-center gap-2 shrink-0">
                {(knowledgeSearchKeyword ||
                  knowledgeGradeFilter !== 'all' ||
                  knowledgeStateFilter !== 'all' ||
                  knowledgeDomainFilter !== 'all' ||
                  knowledgeSortBy !== 'default') && (
                  <button
                    type="button"
                    onClick={() => {
                      setKnowledgeSearchKeyword('');
                      setKnowledgeGradeFilter('all');
                      setKnowledgeStateFilter('all');
                      setKnowledgeDomainFilter('all');
                      setKnowledgeSortBy('default');
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>重置所有筛选</span>
                  </button>
                )}
              </div>
            </div>

            {/* Filter Controls Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
              {/* Search Box */}
              <div className="lg:col-span-4 relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={knowledgeSearchKeyword}
                  onChange={(e) => setKnowledgeSearchKeyword(e.target.value)}
                  placeholder="搜索知识点名称、章节、定义、考法或避坑..."
                  className="w-full pl-9 pr-8 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
                />
                {knowledgeSearchKeyword && (
                  <button
                    type="button"
                    onClick={() => setKnowledgeSearchKeyword('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Grade / Stage Filter */}
              <div className="lg:col-span-2">
                <select
                  aria-label="选择年级与学段"
                  value={knowledgeGradeFilter}
                  onChange={(e) => setKnowledgeGradeFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
                >
                  {knowledgeGradeOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} ({opt.count})
                    </option>
                  ))}
                </select>
              </div>

              {/* Mastery State Filter */}
              <div className="lg:col-span-2">
                <select
                  aria-label="选择掌握度状态"
                  value={knowledgeStateFilter}
                  onChange={(e) => setKnowledgeStateFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
                >
                  <option value="all">全部掌握状态</option>
                  <option value="薄弱需攻克">🔥 薄弱待攻克（失分/待学）</option>
                  <option value="未诊断">未诊断</option>
                  <option value="待学习">待学习</option>
                  <option value="学习中">学习中</option>
                  <option value="初步掌握">初步掌握</option>
                  <option value="掌握">掌握</option>
                  <option value="稳定掌握">稳定掌握</option>
                </select>
              </div>

              {/* Knowledge Domain / Module Filter */}
              <div className="lg:col-span-2">
                <select
                  aria-label="选择知识板块"
                  value={knowledgeDomainFilter}
                  onChange={(e) => setKnowledgeDomainFilter(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
                >
                  <option value="all">全部知识板块 ({availableDomains.length})</option>
                  {availableDomains.map((dom) => (
                    <option key={dom} value={dom}>
                      {dom}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sort Order Selector */}
              <div className="lg:col-span-2">
                <select
                  aria-label="排序规则"
                  value={knowledgeSortBy}
                  onChange={(e) => setKnowledgeSortBy(e.target.value as any)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
                >
                  <option value="default">默认考纲排序</option>
                  <option value="weight">按考纲权重降序 (高频)</option>
                  <option value="lostScore">按失分空间降序 (急需)</option>
                  <option value="cost">按攻克学时升序 (速效)</option>
                </select>
              </div>
            </div>

            {/* Quick Active Tags Indicator */}
            {(knowledgeSearchKeyword ||
              knowledgeGradeFilter !== 'all' ||
              knowledgeStateFilter !== 'all' ||
              knowledgeDomainFilter !== 'all') && (
              <div className="flex flex-wrap items-center gap-1.5 pt-2 text-xs text-slate-500">
                <span className="text-slate-400">已应用过滤：</span>
                {knowledgeSearchKeyword && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    关键词: {knowledgeSearchKeyword}
                    <button type="button" onClick={() => setKnowledgeSearchKeyword('')}>
                      <X className="w-3 h-3 hover:text-blue-900" />
                    </button>
                  </span>
                )}
                {knowledgeGradeFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    {knowledgeGradeOptions.find((o) => o.id === knowledgeGradeFilter)?.label}
                    <button type="button" onClick={() => setKnowledgeGradeFilter('all')}>
                      <X className="w-3 h-3 hover:text-blue-900" />
                    </button>
                  </span>
                )}
                {knowledgeStateFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    状态: {knowledgeStateFilter}
                    <button type="button" onClick={() => setKnowledgeStateFilter('all')}>
                      <X className="w-3 h-3 hover:text-blue-900" />
                    </button>
                  </span>
                )}
                {knowledgeDomainFilter !== 'all' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    板块: {knowledgeDomainFilter}
                    <button type="button" onClick={() => setKnowledgeDomainFilter('all')}>
                      <X className="w-3 h-3 hover:text-blue-900" />
                    </button>
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Cards Grid */}
          {paginatedKps.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
              <HelpCircle className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="text-base font-semibold text-slate-800">
                未找到匹配筛选条件的知识点
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                尝试放宽搜索词、切换年级范围或重置掌握度状态筛选，查看全科 2,760 个考纲考点档案
              </p>
              <button
                type="button"
                onClick={() => {
                  setKnowledgeSearchKeyword('');
                  setKnowledgeGradeFilter('all');
                  setKnowledgeStateFilter('all');
                  setKnowledgeDomainFilter('all');
                  setKnowledgeSortBy('default');
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>清除筛选并查看全部考点</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {paginatedKps.map((kp) => {
                const rec = masteryRecords[kp.id];
                const state = rec?.state ?? '未诊断';
                const lostScore = rec?.lostScoreEvidence ?? 0;
                const stateColorClass =
                  state === '稳定掌握' || state === '掌握'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : state === '初步掌握' || state === '学习中'
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : state === '待学习'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-slate-50 text-slate-600 border-slate-200';

                return (
                  <article
                    key={kp.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4 hover:shadow-md transition-shadow"
                  >
                    <div className="space-y-3.5">
                      {/* Meta header row */}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5 text-slate-500">
                          <span className="font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
                            {kp.subject}
                          </span>
                          <span>·</span>
                          <span className="truncate max-w-[200px]" title={kp.chapter}>
                            {kp.chapter}
                          </span>
                          <span>·</span>
                          <span className="text-slate-600 font-medium">{kp.domain}</span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {lostScore > 0 && (
                            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200 font-mono">
                              失分 -{lostScore}分
                            </span>
                          )}
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${stateColorClass}`}
                          >
                            {state}
                          </span>
                        </div>
                      </div>

                      {/* Title & Core badges */}
                      <div className="space-y-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-base font-bold text-slate-900 leading-snug">
                            {kp.name}
                          </h3>
                          <div className="flex items-center gap-1 shrink-0 text-[11px] font-mono">
                            <span
                              className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium"
                              title="考纲考核频率与分值权重系数"
                            >
                              权重 {kp.examWeight}x
                            </span>
                            <span
                              className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium"
                              title="系统预估攻克此知识点所需学时"
                            >
                              ~{kp.learningCostHours}h
                            </span>
                          </div>
                        </div>

                        <p className="text-xs text-slate-600 leading-relaxed pt-0.5">
                          {kp.definition}
                        </p>
                      </div>

                      {/* Sub-skills breakdown (分步子技能完整呈现) */}
                      {kp.subSkills && kp.subSkills.length > 0 && (
                        <div className="p-2.5 bg-slate-50/80 border border-slate-100 rounded-lg space-y-1.5 text-xs">
                          <div className="text-[11px] font-semibold text-slate-700 flex items-center gap-1">
                            <Target className="w-3.5 h-3.5 text-blue-600" />
                            <span>核心分步子能力清单（{kp.subSkills.length} 项）：</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {kp.subSkills.map((sk) => (
                              <span
                                key={sk}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[11px]"
                              >
                                <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                                <span>{sk}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Prerequisites chain (先修依赖链) */}
                      {kp.prerequisites && kp.prerequisites.length > 0 && (
                        <div className="p-2.5 bg-blue-50/40 border border-blue-100 rounded-lg space-y-1.5 text-xs">
                          <div className="text-[11px] font-semibold text-blue-900 flex items-center gap-1">
                            <Layers className="w-3.5 h-3.5 text-blue-700" />
                            <span>先修前置依赖知识点：</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {kp.prerequisites.map((preId) => {
                              const preKp = KNOWLEDGE_MAP[preId];
                              const preRec = masteryRecords[preId];
                              const preState = preRec?.state ?? '未诊断';
                              const preHasProblem =
                                preState === '待学习' || preState === '学习中' || (preRec?.lostScoreEvidence ?? 0) > 0;
                              return (
                                <button
                                  key={preId}
                                  type="button"
                                  onClick={() => {
                                    if (preKp) {
                                      setSelectedDetailKp(preKp);
                                    }
                                  }}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors ${
                                    preHasProblem
                                      ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                                  }`}
                                  title="点击查看前置考点全景档案"
                                >
                                  <span>{preKp?.name ?? preId}</span>
                                  <span className="font-mono text-[10px]">
                                    ({preState})
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Exam Forms & Traps Grid */}
                      <div className="text-xs space-y-2 pt-2 border-t border-slate-100">
                        {kp.commonExamForms && kp.commonExamForms.length > 0 && (
                          <div className="flex items-start gap-1.5">
                            <span className="font-semibold text-slate-700 shrink-0">常见考法：</span>
                            <div className="flex flex-wrap gap-1">
                              {kp.commonExamForms.map((fmt) => (
                                <span
                                  key={fmt}
                                  className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]"
                                >
                                  {fmt}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {kp.commonTraps && kp.commonTraps.length > 0 && (
                          <div className="p-2.5 bg-amber-50/60 border border-amber-200/80 rounded-lg space-y-1">
                            <div className="font-semibold text-amber-900 flex items-center gap-1 text-[11px]">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                              <span>高频易错避坑要点：</span>
                            </div>
                            <ul className="list-disc list-inside text-amber-900 text-xs space-y-0.5">
                              {kp.commonTraps.map((trap) => (
                                <li key={trap}>{trap}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Recent Evidence */}
                        <div className="text-slate-500 text-[11px] flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>诊断证据：{rec?.evidenceLogs[0] ?? '暂无近期试卷失分记录'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Action Footer */}
                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        变式评测：
                        <span className={rec?.variantPassed ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>
                          {rec?.variantPassed ? '已通过' : '待完成'}
                        </span>
                        {' · '}
                        延迟复测：
                        <span className={rec?.delayedRetestPassed ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>
                          {rec?.delayedRetestPassed ? '已通过' : '待完成'}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedDetailKp(kp)}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-1"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>全景档案</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onLaunchCoach(kp.id)}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors inline-flex items-center gap-1"
                        >
                          <span>去训练</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <Pagination
              currentPage={knowledgePagination.currentPage}
              totalPages={knowledgePagination.totalPages}
              totalItems={knowledgePagination.totalItems}
              pageSize={knowledgePagination.pageSize}
              onPageChange={setKnowledgePage}
              onPageSizeChange={(newSize) => {
                setKnowledgePageSize(newSize);
                setKnowledgePage(1);
              }}
              pageSizeOptions={[8, 12, 24, 48]}
              itemName="个知识点"
            />
          </div>
        </div>
      )}

      {/* Full Panorama Knowledge Modal (完整全景知识点呈现抽屉) */}
      {selectedDetailKp && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="kp-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto"
        >
          <div className="bg-white rounded-2xl max-w-3xl w-full border border-slate-200 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col my-auto">
            {/* Modal Header */}
            <div className="p-6 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-800 bg-white border border-slate-200 px-2.5 py-0.5 rounded">
                    {selectedDetailKp.subject}
                  </span>
                  <span className="text-slate-500 font-medium">
                    {selectedDetailKp.chapter}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-blue-700 font-semibold">
                    {selectedDetailKp.domain}
                  </span>
                </div>
                <h3 id="kp-modal-title" className="text-xl font-bold text-slate-900 flex items-center gap-2">
                  <span>{selectedDetailKp.name}</span>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    考纲权重 {selectedDetailKp.examWeight}x
                  </span>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                    攻克预估 {selectedDetailKp.learningCostHours} 小时
                  </span>
                </h3>
              </div>

              <button
                type="button"
                onClick={() => setSelectedDetailKp(null)}
                aria-label="关闭详情弹窗"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6 overflow-y-auto text-xs leading-relaxed">
              {/* Status Machine Snapshot */}
              {(() => {
                const rec = masteryRecords[selectedDetailKp.id];
                const state = rec?.state ?? '未诊断';
                return (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                        <Award className="w-4 h-4 text-blue-600" />
                        <span>当前掌握度与学情诊断</span>
                      </div>
                      <span className="font-semibold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200">
                        状态机：{state}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      <div className="p-2 bg-white border border-slate-200 rounded-lg">
                        <div className="text-slate-400 text-[11px]">置信度评级</div>
                        <div className="font-semibold text-slate-800 mt-0.5">
                          {rec?.confidence ?? '待评估'}
                        </div>
                      </div>
                      <div className="p-2 bg-white border border-slate-200 rounded-lg">
                        <div className="text-slate-400 text-[11px]">历史失分</div>
                        <div className="font-semibold text-red-700 font-mono mt-0.5">
                          -{rec?.lostScoreEvidence ?? 0} 分
                        </div>
                      </div>
                      <div className="p-2 bg-white border border-slate-200 rounded-lg">
                        <div className="text-slate-400 text-[11px]">变式评测</div>
                        <div className="font-semibold text-slate-800 mt-0.5">
                          {rec?.variantPassed ? '已达标' : '待完成'}
                        </div>
                      </div>
                      <div className="p-2 bg-white border border-slate-200 rounded-lg">
                        <div className="text-slate-400 text-[11px]">延迟复测闭环</div>
                        <div className="font-semibold text-slate-800 mt-0.5">
                          {rec?.delayedRetestPassed ? '已闭环' : '待触发'}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Core Definition */}
              <div className="space-y-1.5">
                <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                  <Compass className="w-4 h-4 text-blue-600" />
                  <span>概念核心定义与课标要求</span>
                </h4>
                <p className="text-slate-700 bg-slate-50 p-3.5 rounded-xl border border-slate-200 leading-relaxed text-xs">
                  {selectedDetailKp.definition}
                </p>
              </div>

              {/* Sub-skills */}
              {selectedDetailKp.subSkills && selectedDetailKp.subSkills.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                    <Target className="w-4 h-4 text-emerald-600" />
                    <span>分步子能力考核要求（{selectedDetailKp.subSkills.length} 项）</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedDetailKp.subSkills.map((sk, idx) => (
                      <div
                        key={sk}
                        className="p-2.5 bg-white border border-slate-200 rounded-lg flex items-start gap-2 text-slate-800"
                      >
                        <span className="font-mono text-emerald-700 font-bold">0{idx + 1}.</span>
                        <span>{sk}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Prerequisites Chain */}
              {selectedDetailKp.prerequisites && selectedDetailKp.prerequisites.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-blue-600" />
                    <span>先修依赖链路追踪（前置知识点）</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedDetailKp.prerequisites.map((preId) => {
                      const preKp = KNOWLEDGE_MAP[preId];
                      const preRec = masteryRecords[preId];
                      const preState = preRec?.state ?? '未诊断';
                      return (
                        <div
                          key={preId}
                          className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between"
                        >
                          <div>
                            <div className="font-semibold text-slate-900">
                              {preKp?.name ?? preId}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {preKp?.chapter ?? '先修基础'}
                            </div>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-white border border-slate-200 text-slate-700">
                            {preState}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Exam Forms & Traps */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                    <Tag className="w-4 h-4 text-indigo-600" />
                    <span>中考常见出题考法</span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {selectedDetailKp.commonExamForms.map((fmt) => (
                      <li key={fmt}>{fmt}</li>
                    ))}
                  </ul>
                </div>

                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-amber-900">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <span>高频易错避坑要点</span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-amber-900">
                    {selectedDetailKp.commonTraps.map((trap) => (
                      <li key={trap}>{trap}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Linked Errors Evidence */}
              {(() => {
                const linkedErrors = errorRecords.filter(
                  (e) => e.knowledgeId === selectedDetailKp.id
                );
                return (
                  <div className="space-y-2">
                    <div className="font-semibold text-slate-900 flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <FileText className="w-4 h-4 text-red-600" />
                        <span>关联历史诊断错题证据（共 {linkedErrors.length} 题）</span>
                      </span>
                    </div>

                    {linkedErrors.length === 0 ? (
                      <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-center">
                        当前暂无本科考点的历史失分错题记录
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                        {linkedErrors.map((err) => (
                          <div
                            key={err.id}
                            className="p-3 bg-red-50/50 border border-red-100 rounded-lg space-y-1 text-slate-700"
                          >
                            <div className="flex items-center justify-between font-semibold">
                              <span className="text-slate-900">
                                {err.examTitle} · 题号 {err.questionNumber}
                              </span>
                              <span className="text-red-700 font-mono">
                                {err.errorType} · -{err.scoreLost}分
                              </span>
                            </div>
                            <p className="text-slate-600 line-clamp-2"><MathText text={err.stem} /></p>
                            <div className="text-[11px] text-slate-500">
                              学生作答：<MathText text={err.studentAnswer} /> · 归因：<MathText text={err.aiAnalysis} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500 font-mono">
                知识点唯一编号：{selectedDetailKp.id}
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedDetailKp(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = selectedDetailKp.id;
                    setSelectedDetailKp(null);
                    onLaunchCoach(id);
                  }}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors inline-flex items-center gap-1.5 shadow-sm"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>启动 AI 教练针对性攻克</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Error Organization, 5-Dimension Analysis & Variant Archive (Module 05B & 05C) */}
      {activeTab === 'errors' && (
        <div className="space-y-6">
          {onNavigate && (
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
              <div className="space-y-0.5">
                <div className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  <span>「错题档案」已升级为顶级独立页面</span>
                </div>
                <p className="text-xs text-blue-700">
                  支持全要素认知佐证链、考点高频陷阱对照、重做自测模式及错题打印练习卷，欢迎前往体验。
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('errors')}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shadow-sm shrink-0"
              >
                前往错题档案独立工作台 →
              </button>
            </div>
          )}

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
              <div className="space-y-4">
                <div className="space-y-4">
                  {paginatedErrors.map((err) => {
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
                              err.status === '已闭环'
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                            }`}
                          >
                            状态：{err.status}
                          </span>
                        </div>

                        <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg text-sm text-slate-900">
                          <MathText text={err.stem} />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div className="p-3 border border-slate-100 rounded-lg">
                            <span className="text-slate-500">学生原答：</span>
                            <span className="text-slate-800"><MathText text={err.studentAnswer} /></span>
                          </div>
                          <div className="p-3 border border-slate-100 rounded-lg">
                            <span className="text-slate-500">规范参考：</span>
                            <span className="text-emerald-800 font-medium"><MathText text={err.correctAnswer} /></span>
                          </div>
                        </div>

                        <div className="text-xs text-slate-700 space-y-1">
                          <div>
                            <span className="font-semibold text-slate-900">AI 分析：</span>
                            <MathText text={err.aiAnalysis} />
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
                              <span>标记已订正，待复测</span>
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
                  })}
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <Pagination
                    currentPage={errorPagination.currentPage}
                    totalPages={errorPagination.totalPages}
                    totalItems={errorPagination.totalItems}
                    pageSize={errorPagination.pageSize}
                    onPageChange={setErrorPage}
                    onPageSizeChange={(newSize) => {
                      setErrorPageSize(newSize);
                      setErrorPage(1);
                    }}
                    pageSizeOptions={[5, 10, 20, 50]}
                    itemName="道错题"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
