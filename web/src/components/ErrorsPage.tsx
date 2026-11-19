import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck,
  FileText,
  Filter,
  GraduationCap,
  HelpCircle,
  Layers,
  Lightbulb,
  PenLine,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { MathText } from './MathText.tsx';
import { ALL_SUBJECTS } from '../types.ts';
import { Pagination } from './Pagination.tsx';
import { paginateList } from '../utils/pagination.ts';
import type {
  AppPage,
  ConfidenceLevel,
  ErrorRecord,
  ErrorType,
  Exam,
  ExamPaper,
  MasteryRecord,
  Subject,
  VariantQuestion,
} from '../types.ts';

export interface ErrorsPageProps {
  exams: Exam[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  variantQuestions: VariantQuestion[];
  onMarkErrorCorrected: (errorId: string, note: string) => void;
  onLaunchCoach: (knowledgeId: string) => void;
  onNavigate?: (page: AppPage) => void;
  onSelectExamPaper?: (paperId: string) => void;
}

const ERROR_TYPES: ErrorType[] = [
  '审题问题',
  '计算问题',
  '知识问题',
  '方法问题',
  '熟练度问题',
];

const ERROR_STATUSES: ErrorRecord['status'][] = [
  '未订正',
  '已订正',
  '待复测',
  '已闭环',
];

const CONFIDENCE_LEVELS: ConfidenceLevel[] = ['确定', '较可能', '待验证'];

/**
 * 错因分类配色规范
 */
const ERROR_TYPE_COLORS: Record<
  ErrorType,
  { bg: string; text: string; border: string; bar: string }
> = {
  审题问题: {
    bg: 'bg-amber-50',
    text: 'text-amber-800',
    border: 'border-amber-200',
    bar: 'bg-amber-500',
  },
  计算问题: {
    bg: 'bg-rose-50',
    text: 'text-rose-800',
    border: 'border-rose-200',
    bar: 'bg-rose-500',
  },
  知识问题: {
    bg: 'bg-purple-50',
    text: 'text-purple-800',
    border: 'border-purple-200',
    bar: 'bg-purple-500',
  },
  方法问题: {
    bg: 'bg-blue-50',
    text: 'text-blue-800',
    border: 'border-blue-200',
    bar: 'bg-blue-500',
  },
  熟练度问题: {
    bg: 'bg-slate-50',
    text: 'text-slate-800',
    border: 'border-slate-300',
    bar: 'bg-slate-500',
  },
};

/**
 * 学科标志色
 */
const SUBJECT_COLORS: Record<Subject, { bg: string; text: string; border: string }> = {
  数学: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  英语: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
  物理: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
  化学: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  语文: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
};

export const ErrorsPage: React.FC<ErrorsPageProps> = ({
  exams,
  examPapers,
  errorRecords,
  masteryRecords,
  variantQuestions,
  onMarkErrorCorrected,
  onLaunchCoach,
  onNavigate,
  onSelectExamPaper,
}) => {
  const { knowledgeMap: KNOWLEDGE_MAP } = useCurriculum();

  // 筛选与排序状态
  const [subjectFilter, setSubjectFilter] = useState<'全部' | Subject>('全部');
  const [errorTypeFilter, setErrorTypeFilter] = useState<'全部' | ErrorType>('全部');
  const [statusFilter, setStatusFilter] = useState<'全部' | ErrorRecord['status']>('全部');
  const [confidenceFilter, setConfidenceFilter] = useState<'全部' | ConfidenceLevel>('全部');
  const [examFilter, setExamFilter] = useState<'全部' | string>('全部');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [errorSortBy, setErrorSortBy] = useState<'recent' | 'scoreLost'>('recent');

  // 模式：研读模式 (study) vs 重做自测模式 (retest)
  const [viewMode, setViewMode] = useState<'study' | 'retest'>('study');
  // 自测模式下单题临时揭晓答案状态
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});

  // 订正心得草稿
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  // 学生自测答题草稿
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, string>>({});

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // 统计基础列表（按学科粗筛）
  const baseRecords = useMemo(() => {
    return subjectFilter === '全部'
      ? errorRecords
      : errorRecords.filter((e) => e.subject === subjectFilter);
  }, [errorRecords, subjectFilter]);

  // 全局概览统计
  const summaryStats = useMemo(() => {
    const totalCount = baseRecords.length;
    const totalLost = baseRecords.reduce((s, e) => s + e.scoreLost, 0);
    const uncorrectedCount = baseRecords.filter((e) => e.status === '未订正').length;
    const correctedCount = baseRecords.filter((e) => e.status === '已订正').length;
    const pendingRetestCount = baseRecords.filter((e) => e.status === '待复测').length;
    const closedCount = baseRecords.filter((e) => e.status === '已闭环').length;
    const closedRate = totalCount > 0 ? Math.round((closedCount / totalCount) * 100) : 0;
    const fixedRate =
      totalCount > 0
        ? Math.round(((closedCount + pendingRetestCount + correctedCount) / totalCount) * 100)
        : 0;

    return {
      totalCount,
      totalLost,
      uncorrectedCount,
      correctedCount,
      pendingRetestCount,
      closedCount,
      closedRate,
      fixedRate,
    };
  }, [baseRecords]);

  // 五维错因失分分布
  const errorTypeBreakdown = useMemo(() => {
    const totalLost = summaryStats.totalLost;
    return ERROR_TYPES.map((et) => {
      const matched = baseRecords.filter((e) => e.errorType === et);
      const lost = matched.reduce((s, e) => s + e.scoreLost, 0);
      const pct = totalLost > 0 ? Math.round((lost / totalLost) * 100) : 0;
      return {
        errorType: et,
        count: matched.length,
        lost,
        pct,
      };
    }).sort((a, b) => b.lost - a.lost);
  }, [baseRecords, summaryStats.totalLost]);

  // 跨考试高频重复漏洞排行 Top 5
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

    for (const err of baseRecords) {
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
  }, [baseRecords]);

  // 严格按多维条件筛选过滤
  const filteredErrors = useMemo(() => {
    const kw = searchKeyword.trim().toLowerCase();

    const list = errorRecords.filter((e) => {
      if (subjectFilter !== '全部' && e.subject !== subjectFilter) return false;
      if (errorTypeFilter !== '全部' && e.errorType !== errorTypeFilter) return false;
      if (statusFilter !== '全部' && e.status !== statusFilter) return false;
      if (confidenceFilter !== '全部' && e.confidence !== confidenceFilter) return false;
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
        const hay = `${e.stem} ${e.knowledgeName} ${e.aiAnalysis} ${e.questionNumber} ${e.examTitle} ${e.evidence} ${e.studentAnswer} ${e.correctAnswer} ${e.correctionNote ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (errorSortBy === 'scoreLost') {
      return [...list].sort((a, b) => b.scoreLost - a.scoreLost);
    }
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [
    errorRecords,
    subjectFilter,
    errorTypeFilter,
    statusFilter,
    confidenceFilter,
    examFilter,
    exams,
    searchKeyword,
    errorSortBy,
  ]);

  // 分页切片
  const totalPages = Math.max(1, Math.ceil(filteredErrors.length / pageSize));
  const paginatedErrors = useMemo(() => {
    return paginateList(filteredErrors, currentPage, pageSize).pageItems;
  }, [filteredErrors, currentPage, pageSize]);

  // 重置筛选条件
  const hasActiveFilters =
    subjectFilter !== '全部' ||
    errorTypeFilter !== '全部' ||
    statusFilter !== '全部' ||
    confidenceFilter !== '全部' ||
    examFilter !== '全部' ||
    searchKeyword.trim() !== '' ||
    errorSortBy !== 'recent';

  const handleResetFilters = () => {
    setSubjectFilter('全部');
    setErrorTypeFilter('全部');
    setStatusFilter('全部');
    setConfidenceFilter('全部');
    setExamFilter('全部');
    setSearchKeyword('');
    setErrorSortBy('recent');
    setCurrentPage(1);
  };

  const handleToggleReveal = (id: string) => {
    setRevealedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* 打印专用样式注入 */}
      <style>{`
        @media print {
          header, nav, footer, .no-print {
            display: none !important;
          }
          body {
            background: white !important;
            color: black !important;
            font-size: 12pt !important;
          }
          .print-break-inside {
            break-inside: avoid;
            page-break-inside: avoid;
          }
        }
      `}</style>

      {/* 顶部标题与工作台主栏 */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-7 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium">
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>中考核心提分资产 · 独立错题档案库</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              错题档案与易错题闭环
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              基于真实作答证据呈现五维错因归因（审题/计算/知识/方法/耗时）、置信度评估、考点高频陷阱对照与同型变式题闭环复测，拒绝无效抄写，每一道错题都必须攻克到底。
            </p>
          </div>

          {/* 模式切换与打印/导出工具 */}
          <div className="flex flex-wrap items-center gap-3 shrink-0 no-print">
            {/* 研学模式 vs 自测重做模式 */}
            <div className="inline-flex items-center p-1 bg-slate-100 rounded-xl border border-slate-200 text-xs font-medium">
              <button
                type="button"
                onClick={() => setViewMode('study')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg transition-colors ${
                  viewMode === 'study'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 text-blue-600" />
                <span>深度研学模式</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('retest')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg transition-colors ${
                  viewMode === 'retest'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <PenLine className="w-3.5 h-3.5 text-emerald-600" />
                <span>重做自测模式</span>
              </button>
            </div>

            {/* 打印练习卷 */}
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
              title="生成纯净练习卷并调用浏览器打印"
            >
              <Printer className="w-4 h-4 text-slate-600" />
              <span>打印自测练习卷</span>
            </button>
          </div>
        </div>

        {/* 关键统计指标条 */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-6 mt-6 border-t border-slate-100">
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5">
            <div className="text-xs text-slate-500 font-medium">档案错题总数</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-slate-900">
                {summaryStats.totalCount}
              </span>
              <span className="text-xs text-slate-500">道</span>
            </div>
          </div>

          <div className="bg-rose-50/60 border border-rose-100 rounded-xl p-3.5">
            <div className="text-xs text-rose-700 font-medium">累计失分扣减</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-rose-700">
                -{summaryStats.totalLost}
              </span>
              <span className="text-xs text-rose-600">分</span>
            </div>
          </div>

          <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3.5">
            <div className="text-xs text-amber-800 font-medium">待订正错题</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-amber-800">
                {summaryStats.uncorrectedCount}
              </span>
              <span className="text-xs text-amber-700">道</span>
            </div>
          </div>

          <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3.5">
            <div className="text-xs text-indigo-700 font-medium">待变式复测</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-indigo-700">
                {summaryStats.pendingRetestCount}
              </span>
              <span className="text-xs text-indigo-600">道</span>
            </div>
          </div>

          <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-3.5">
            <div className="text-xs text-emerald-800 font-medium">变式闭环攻克</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-emerald-800">
                {summaryStats.closedCount}
              </span>
              <span className="text-xs text-emerald-700">道</span>
            </div>
          </div>

          <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-3.5">
            <div className="text-xs text-blue-700 font-medium">完全闭环率</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-xl font-bold font-mono text-blue-700">
                {summaryStats.closedRate}%
              </span>
              <span className="text-xs text-slate-500">
                (已闭环 / 总量)
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 分析与高频漏洞区块 (研读模式下展示) */}
      {viewMode === 'study' && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 no-print">
          {/* 五维错因失分剖析 */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-rose-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  五维错因失分分布
                </h3>
              </div>
              <span className="text-xs text-slate-500 font-sans">
                点击快速筛选
              </span>
            </div>

            <div className="space-y-3 pt-1">
              {errorTypeBreakdown.map((item) => {
                const color = ERROR_TYPE_COLORS[item.errorType];
                const isSelected = errorTypeFilter === item.errorType;

                return (
                  <button
                    key={item.errorType}
                    type="button"
                    onClick={() => {
                      setErrorTypeFilter(isSelected ? '全部' : item.errorType);
                      setCurrentPage(1);
                    }}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/40 ring-1 ring-blue-600'
                        : 'border-slate-100 bg-slate-50/60 hover:bg-slate-100/70'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-medium ${color.bg} ${color.text} border ${color.border}`}
                        >
                          {item.errorType}
                        </span>
                        <span className="text-slate-500 font-mono">
                          {item.count} 题
                        </span>
                      </div>
                      <div className="flex items-center gap-2 font-mono">
                        <span className="font-semibold text-rose-600">
                          -{item.lost}分
                        </span>
                        <span className="text-slate-400">({item.pct}%)</span>
                      </div>
                    </div>
                    {/* 进度条 */}
                    <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${color.bar} rounded-full transition-all duration-300`}
                        style={{ width: `${item.pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 跨考试高频漏洞排行 Top 5 */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  跨考试高频重复漏洞 Top 5
                </h3>
              </div>
              <span className="text-xs text-slate-500">重点攻坚</span>
            </div>

            {repeatedKnowledgeRank.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                暂无跨考试高频重复失分记录
              </div>
            ) : (
              <div className="space-y-2.5 pt-1">
                {repeatedKnowledgeRank.map((item, idx) => (
                  <div
                    key={item.knowledgeId}
                    className="p-3 border border-slate-100 bg-slate-50/70 rounded-xl flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 h-4 rounded-full bg-amber-100 text-amber-800 font-bold font-mono text-[10px] flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <span className="font-semibold text-slate-900 truncate">
                          {item.knowledgeName}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                        <span>{item.subject}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-rose-600 font-medium">
                          累积 -{item.totalLost}分
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>连错 {item.count} 次</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onLaunchCoach(item.knowledgeId)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
                      title="直接跳转至 AI 教练开启变式题攻克"
                    >
                      <span>去攻克</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 提分闭环指引与考点陷阱预警 */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  错题攻克标准化闭环路径
                </h3>
              </div>

              <div className="space-y-2 text-xs text-slate-600">
                <div className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="w-4 h-4 rounded-full bg-blue-100 text-blue-700 font-bold font-mono text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                    1
                  </span>
                  <div>
                    <span className="font-semibold text-slate-800">深度归因订正</span>
                    <p className="text-slate-500 mt-0.5">
                      对照规范解法，记录审题漏洞或解题失误心得，标记「已订正，待复测」。
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 font-bold font-mono text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                    2
                  </span>
                  <div>
                    <span className="font-semibold text-slate-800">同型变式验证</span>
                    <p className="text-slate-500 mt-0.5">
                      点击「去练变式题」，在 AI 教练引导下完成 1~2 道同考点同题型新题。
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 font-bold font-mono text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                    3
                  </span>
                  <div>
                    <span className="font-semibold text-slate-800">跃迁为已闭环</span>
                    <p className="text-slate-500 mt-0.5">
                      变式题作答正确后，对应知识点掌握度提升，错题状态自动转为「已闭环」。
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>关联变式题资产：{variantQuestions.length} 道就绪</span>
              {pendingRetestCountBadge(summaryStats.pendingRetestCount, () => {
                setStatusFilter('待复测');
                setCurrentPage(1);
              })}
            </div>
          </div>
        </section>
      )}

      {/* 筛选过滤与搜索工具栏 */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 no-print">
        {/* 第一行：学科 Tab 快速切换 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-700 mr-1 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              学科筛选：
            </span>
            <button
              type="button"
              onClick={() => {
                setSubjectFilter('全部');
                setCurrentPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                subjectFilter === '全部'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              全部学科 ({errorRecords.length})
            </button>
            {ALL_SUBJECTS.map((sub) => {
              const count = errorRecords.filter((e) => e.subject === sub).length;
              const isActive = subjectFilter === sub;
              return (
                <button
                  key={sub}
                  type="button"
                  onClick={() => {
                    setSubjectFilter(sub);
                    setCurrentPage(1);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1 ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <span>{sub}</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                      isActive ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 font-medium transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>重置所有筛选</span>
            </button>
          )}
        </div>

        {/* 第二行：错因、状态、置信度、场次、排序与搜索 */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* 搜索框 */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchKeyword}
                onChange={(e) => {
                  setSearchKeyword(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="搜索题干、考点、错因、佐证..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg w-56 sm:w-64 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600"
              />
              {searchKeyword && (
                <button
                  type="button"
                  onClick={() => setSearchKeyword('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* 考试场次筛选 */}
            <select
              value={examFilter}
              onChange={(e) => {
                setExamFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="全部">全部考试场次</option>
              {exams.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.date} · {ex.title}
                </option>
              ))}
            </select>

            {/* 错因类型筛选 */}
            <select
              value={errorTypeFilter}
              onChange={(e) => {
                setErrorTypeFilter(e.target.value as '全部' | ErrorType);
                setCurrentPage(1);
              }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="全部">全部错因分类</option>
              {ERROR_TYPES.map((et) => (
                <option key={et} value={et}>
                  {et}
                </option>
              ))}
            </select>

            {/* 闭环状态筛选 */}
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as '全部' | ErrorRecord['status']);
                setCurrentPage(1);
              }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="全部">全部订正状态</option>
              {ERROR_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>

            {/* 置信度等级筛选 */}
            <select
              value={confidenceFilter}
              onChange={(e) => {
                setConfidenceFilter(e.target.value as '全部' | ConfidenceLevel);
                setCurrentPage(1);
              }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="全部">全部置信度</option>
              {CONFIDENCE_LEVELS.map((cf) => (
                <option key={cf} value={cf}>
                  置信度：{cf}
                </option>
              ))}
            </select>
          </div>

          {/* 排序方式 */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-slate-500">排序：</span>
            <select
              value={errorSortBy}
              onChange={(e) => {
                setErrorSortBy(e.target.value as 'recent' | 'scoreLost');
                setCurrentPage(1);
              }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="recent">按时间最新排序</option>
              <option value="scoreLost">按失分从高到低</option>
            </select>
          </div>
        </div>

        {/* 结果条数提示 */}
        <div className="text-xs text-slate-500 flex items-center justify-between pt-1">
          <span>
            当前展示匹配错题{' '}
            <strong className="text-slate-900 font-mono font-semibold">
              {filteredErrors.length}
            </strong>{' '}
            / {errorRecords.length} 道
          </span>
          {viewMode === 'retest' && (
            <span className="text-emerald-700 font-medium flex items-center gap-1">
              <EyeOff className="w-3.5 h-3.5" />
              当前处于自测重做模式，已隐去学生答案与参考解析
            </span>
          )}
        </div>
      </section>

      {/* 错题卡片列表 */}
      <section className="space-y-4">
        {filteredErrors.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center space-y-3">
            <BookOpen className="w-10 h-10 text-slate-300 mx-auto" />
            <div className="text-sm font-semibold text-slate-700">
              当前筛选条件下暂无错题记录
            </div>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              可以尝试放宽学科、错因、订正状态或清除关键词搜索，或前往「考试诊断」录入新试卷/单道错题。
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="mt-2 px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors"
              >
                清空筛选条件
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {paginatedErrors.map((err, index) => {
              const subColor = SUBJECT_COLORS[err.subject] ?? {
                bg: 'bg-slate-50',
                text: 'text-slate-700',
                border: 'border-slate-200',
              };
              const errorColor = ERROR_TYPE_COLORS[err.errorType] ?? {
                bg: 'bg-slate-50',
                text: 'text-slate-700',
                border: 'border-slate-200',
              };

              const kp = KNOWLEDGE_MAP[err.knowledgeId];
              const commonTraps = kp?.commonTraps ?? [];

              const linkedVariants = variantQuestions.filter(
                (v) =>
                  v.sourceErrorId === err.id || v.knowledgeId === err.knowledgeId
              );

              const draft =
                correctionDrafts[err.id] ?? err.correctionNote ?? '';
              const practiceAns = practiceAnswers[err.id] ?? '';

              // 重做模式下是否被临时展开
              const isRevealed =
                viewMode === 'study' || Boolean(revealedIds[err.id]);

              return (
                <article
                  key={err.id}
                  className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-7 shadow-sm space-y-5 print-break-inside transition-all hover:border-slate-300"
                >
                  {/* 卡片头部信息区 */}
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs border-b border-slate-100 pb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-slate-400 tabular-nums">
                        #{index + 1 + (currentPage - 1) * pageSize}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded font-semibold ${subColor.bg} ${subColor.text} border ${subColor.border}`}
                      >
                        {err.subject}
                      </span>
                      <span className="font-semibold text-slate-900">
                        {err.examTitle} {err.questionNumber}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600 bg-slate-50 border border-slate-100 px-2 py-0.5 rounded">
                        {err.knowledgeName}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded font-medium ${errorColor.bg} ${errorColor.text} border ${errorColor.border}`}
                      >
                        {err.errorType}
                      </span>
                      <span className="font-mono font-bold text-rose-600 bg-rose-50 border border-rose-100 px-2 py-0.5 rounded">
                        失分 -{err.scoreLost}分
                      </span>

                      {/* 置信度分级标签 */}
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
                          err.confidence === '确定'
                            ? 'text-emerald-700 bg-emerald-50 border border-emerald-200'
                            : err.confidence === '较可能'
                              ? 'text-blue-700 bg-blue-50 border border-blue-200'
                              : 'text-amber-700 bg-amber-50 border border-amber-200'
                        }`}
                        title={`诊断置信度分级：${err.confidence}`}
                      >
                        <ShieldCheck className="w-3 h-3" />
                        <span>置信度：{err.confidence}</span>
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* 订正状态徽章 */}
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          err.status === '已闭环'
                            ? 'text-emerald-800 bg-emerald-50 border border-emerald-200'
                            : err.status === '待复测'
                              ? 'text-indigo-800 bg-indigo-50 border border-indigo-200'
                              : err.status === '已订正'
                                ? 'text-amber-800 bg-amber-50 border border-amber-200'
                                : 'text-rose-800 bg-rose-50 border border-rose-200'
                        }`}
                      >
                        {err.status === '已闭环' && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        )}
                        {err.status === '待复测' && (
                          <RefreshCw className="w-3.5 h-3.5 text-indigo-600" />
                        )}
                        {err.status === '已订正' && (
                          <FileCheck className="w-3.5 h-3.5 text-amber-600" />
                        )}
                        {err.status === '未订正' && (
                          <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                        )}
                        <span>{err.status}</span>
                      </span>

                      {/* 录入时间 */}
                      <span className="text-slate-400 font-mono text-[11px]">
                        {err.createdAt.slice(0, 10)}
                      </span>
                    </div>
                  </div>

                  {/* 题干内容区 */}
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
                      <span>题目原题干</span>
                      {viewMode === 'retest' && (
                        <button
                          type="button"
                          onClick={() => handleToggleReveal(err.id)}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 no-print"
                        >
                          {isRevealed ? (
                            <>
                              <EyeOff className="w-3.5 h-3.5" />
                              <span>隐藏解析与参考答案</span>
                            </>
                          ) : (
                            <>
                              <Eye className="w-3.5 h-3.5" />
                              <span>查看规范解法与AI归因</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    <div className="p-4 bg-slate-50/80 border border-slate-200 rounded-xl text-sm leading-relaxed text-slate-900 font-sans whitespace-pre-wrap">
                      <MathText text={err.stem} />
                    </div>
                  </div>

                  {/* 自测重做答题区（重做模式专用草稿本） */}
                  {viewMode === 'retest' && (
                    <div className="p-4 bg-emerald-50/30 border border-emerald-100 rounded-xl space-y-2 no-print">
                      <div className="flex items-center justify-between text-xs text-emerald-800 font-medium">
                        <span className="flex items-center gap-1.5">
                          <PenLine className="w-3.5 h-3.5 text-emerald-600" />
                          自测草稿区（重新推演计算过程）
                        </span>
                        <span className="text-slate-400 font-sans">
                          重做完成后点击上方“查看规范解法”比对
                        </span>
                      </div>
                      <textarea
                        rows={2}
                        value={practiceAns}
                        onChange={(e) =>
                          setPracticeAnswers((prev) => ({
                            ...prev,
                            [err.id]: e.target.value,
                          }))
                        }
                        placeholder="在草稿纸上解出答案，或在此输入推导思路与最终答案..."
                        className="w-full p-2.5 text-xs bg-white border border-emerald-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 text-slate-900 placeholder:text-slate-400"
                      />
                    </div>
                  )}

                  {/* 规范答案与学生原答对照（研读模式或揭晓后展示） */}
                  {isRevealed && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-xs">
                      {/* 学生原答 */}
                      <div className="p-3.5 bg-rose-50/30 border border-rose-100 rounded-xl space-y-1.5">
                        <div className="flex items-center justify-between text-rose-800 font-semibold">
                          <span className="flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                            学生作答记录
                          </span>
                          <span className="font-mono text-rose-600 text-[11px]">
                            扣分 -{err.scoreLost}分
                          </span>
                        </div>
                        <div className="text-slate-800 leading-relaxed font-sans bg-white/70 p-2.5 rounded-lg border border-rose-100">
                          <MathText text={err.studentAnswer || '（空白未答或步骤严重缺失）'} />
                        </div>
                      </div>

                      {/* 规范参考 */}
                      <div className="p-3.5 bg-emerald-50/30 border border-emerald-100 rounded-xl space-y-1.5">
                        <div className="flex items-center justify-between text-emerald-800 font-semibold">
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            标准规范解答与评卷标准
                          </span>
                          <span className="text-emerald-700 text-[11px]">
                            参考正解
                          </span>
                        </div>
                        <div className="text-emerald-950 font-medium leading-relaxed font-sans bg-white/70 p-2.5 rounded-lg border border-emerald-100">
                          <MathText text={err.correctAnswer} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* AI 深度归因剖析、证据链与高频陷阱对照 */}
                  {isRevealed && (
                    <div className="space-y-3 pt-2 text-xs">
                      {/* AI 归因深度剖析 */}
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                          <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                          <span>AI 错因深度归因剖析</span>
                        </div>
                        <p className="text-slate-700 leading-relaxed">
                          <MathText text={err.aiAnalysis} />
                        </p>
                      </div>

                      {/* 归因证据链 & 验证闭环方法 & 考点常见陷阱并列栏 */}
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                        {/* 归因证据链 */}
                        <div className="p-3 bg-blue-50/40 border border-blue-100 rounded-xl space-y-1">
                          <div className="font-semibold text-blue-900 flex items-center gap-1">
                            <FileText className="w-3.5 h-3.5 text-blue-700" />
                            <span>认知佐证链条</span>
                          </div>
                          <p className="text-slate-700 text-[11px] leading-relaxed">
                            <MathText text={err.evidence || '本卷单次失分证据独立建档'} />
                          </p>
                        </div>

                        {/* 验证闭环路径建议 */}
                        <div className="p-3 bg-purple-50/40 border border-purple-100 rounded-xl space-y-1">
                          <div className="font-semibold text-purple-900 flex items-center gap-1">
                            <Target className="w-3.5 h-3.5 text-purple-700" />
                            <span>建议验证闭环方式</span>
                          </div>
                          <p className="text-slate-700 text-[11px] leading-relaxed">
                            <MathText text={err.verificationMethod || '完成同类型微测检验是否真正掌握'} />
                          </p>
                        </div>

                        {/* 考点高频易错陷阱 (Curriculum Common Traps) */}
                        <div className="p-3 bg-amber-50/40 border border-amber-100 rounded-xl space-y-1">
                          <div className="font-semibold text-amber-900 flex items-center gap-1">
                            <Lightbulb className="w-3.5 h-3.5 text-amber-700" />
                            <span>考点常见陷阱对照</span>
                          </div>
                          {commonTraps.length > 0 ? (
                            <ul className="text-slate-700 text-[11px] space-y-0.5 list-disc list-inside">
                              {commonTraps.slice(0, 2).map((trap, tIdx) => (
                                <li key={tIdx} className="leading-tight">
                                  <MathText text={trap} />
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-slate-500 text-[11px]">
                              结合分步验算与符号规则防范失分
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 订正心得笔记与闭环行动栏 */}
                  <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between no-print">
                    {/* 心得笔记输入 */}
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={draft}
                        onChange={(e) =>
                          setCorrectionDrafts((prev) => ({
                            ...prev,
                            [err.id]: e.target.value,
                          }))
                        }
                        placeholder="记录你的错因反思与订正心得（如：以后一定要先写分母≠0，再约分）..."
                        className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600"
                      />
                    </div>

                    {/* 操作按钮组 */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* 标记订正按钮 */}
                      <button
                        type="button"
                        onClick={() => onMarkErrorCorrected(err.id, draft)}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl border transition-colors whitespace-nowrap ${
                          err.status === '待复测' || err.status === '已闭环'
                            ? 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                            : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                        }`}
                        title="记录心得并将错题标记为已订正，等待变式题检验"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>
                          {err.status === '已闭环'
                            ? '更新反思心得'
                            : err.status === '待复测'
                              ? '已在待复测中 (更新)'
                              : '标记已订正，待复测'}
                        </span>
                      </button>

                      {/* 去练变式题按钮 */}
                      <button
                        type="button"
                        onClick={() => onLaunchCoach(err.knowledgeId)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors whitespace-nowrap shadow-sm"
                        title="进入 AI 教练针对该考点攻克变式题"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>练变式题 ({linkedVariants.length}题)</span>
                      </button>

                      {/* 原卷回溯 */}
                      {err.examPaperId && onNavigate && (
                        <button
                          type="button"
                          onClick={() => {
                            if (onSelectExamPaper) {
                              onSelectExamPaper(err.examPaperId!);
                            }
                            onNavigate('diagnosis');
                          }}
                          className="px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors whitespace-nowrap"
                          title="跳转至考试诊断回溯本卷原卷切片"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}

            {/* 分页控制器 */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm no-print">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={filteredErrors.length}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(newSize) => {
                  setPageSize(newSize);
                  setCurrentPage(1);
                }}
                pageSizeOptions={[5, 10, 20, 50]}
                itemName="道错题"
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

function pendingRetestCountBadge(count: number, onClick: () => void) {
  if (count <= 0) {
    return (
      <span className="text-emerald-600 font-medium flex items-center gap-1">
        <CheckCircle2 className="w-3.5 h-3.5" />
        全部错题均已推进闭环
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-indigo-700 font-semibold hover:underline flex items-center gap-1"
    >
      <RefreshCw className="w-3 h-3" />
      <span>有 {count} 道待变式复测，去完成</span>
    </button>
  );
}
