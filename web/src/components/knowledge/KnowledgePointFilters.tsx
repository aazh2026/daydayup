/**
 * 考点筛选控件（提分报告「考点档案」与知识图谱共用）。
 *
 * 此前两处各写一套筛选器，口径还不一致；这里收敛成一份，
 * 保证「同一批考点在两处被筛出同样的结果」。
 */
import React from 'react';
import { RotateCcw, Search, X } from 'lucide-react';
import type { GradeOption } from '../../utils/grade.ts';
import {
  DEFAULT_KNOWLEDGE_FILTERS,
  KNOWLEDGE_STATE_FILTER_OPTIONS,
  type DomainOption,
  type KnowledgeFilterState,
  type KnowledgeSortBy,
} from '../../utils/knowledge.ts';

export interface KnowledgePointFiltersProps {
  filters: KnowledgeFilterState;
  onChange: (next: KnowledgeFilterState) => void;
  /** 年级/学段选项（由当前科目的考点集合统计而来） */
  gradeOptions: GradeOption[];
  /** 板块选项 */
  domainOptions: DomainOption[];
  /** 当前命中的考点数 / 候选总数 */
  matchedCount: number;
  totalCount: number;
  /** 右上角补充说明（文案随页面语义变化） */
  description?: string;
}

const SORT_OPTIONS: Array<{ id: KnowledgeSortBy; label: string }> = [
  { id: 'default', label: '默认考纲排序' },
  { id: 'weight', label: '按考纲权重降序（高频）' },
  { id: 'lostScore', label: '按失分空间降序（急需）' },
  { id: 'cost', label: '按攻克学时升序（速效）' },
];

export const KnowledgePointFilters: React.FC<KnowledgePointFiltersProps> = ({
  filters,
  onChange,
  gradeOptions,
  domainOptions,
  matchedCount,
  totalCount,
  description,
}) => {
  const isDirty =
    filters.search !== DEFAULT_KNOWLEDGE_FILTERS.search ||
    filters.grade !== DEFAULT_KNOWLEDGE_FILTERS.grade ||
    filters.domain !== DEFAULT_KNOWLEDGE_FILTERS.domain ||
    filters.state !== DEFAULT_KNOWLEDGE_FILTERS.state ||
    filters.sort !== DEFAULT_KNOWLEDGE_FILTERS.sort;

  const patch = (partial: Partial<KnowledgeFilterState>) =>
    onChange({ ...filters, ...partial });

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            考点档案
            <span className="ml-2 text-xs font-normal text-slate-500">
              当前匹配 {matchedCount} / 共 {totalCount} 个考点
            </span>
          </h2>
          {description && (
            <p className="text-xs text-slate-500 mt-1">{description}</p>
          )}
        </div>

        {isDirty && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_KNOWLEDGE_FILTERS })}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors self-start lg:self-auto"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置所有筛选</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
        {/* 关键词搜索 */}
        <div className="lg:col-span-4 relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="搜索考点名称、章节、板块、定义、考法或避坑..."
            className="w-full pl-9 pr-8 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
          />
          {filters.search && (
            <button
              type="button"
              onClick={() => patch({ search: '' })}
              aria-label="清除搜索关键词"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 年级 / 学段 */}
        <select
          aria-label="选择年级与学段"
          value={filters.grade}
          onChange={(e) => patch({ grade: e.target.value })}
          className="lg:col-span-2 w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
        >
          {gradeOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label} ({opt.count})
            </option>
          ))}
        </select>

        {/* 掌握状态 */}
        <select
          aria-label="选择掌握度状态"
          value={filters.state}
          onChange={(e) =>
            patch({ state: e.target.value as KnowledgeFilterState['state'] })
          }
          className="lg:col-span-2 w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
        >
          <option value="all">全部掌握状态</option>
          {KNOWLEDGE_STATE_FILTER_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* 知识板块 */}
        <select
          aria-label="选择知识板块"
          value={filters.domain}
          onChange={(e) => patch({ domain: e.target.value })}
          className="lg:col-span-2 w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
        >
          <option value="all">全部知识板块 ({domainOptions.length})</option>
          {domainOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.id} ({opt.count})
            </option>
          ))}
        </select>

        {/* 排序 */}
        <select
          aria-label="排序规则"
          value={filters.sort}
          onChange={(e) => patch({ sort: e.target.value as KnowledgeSortBy })}
          className="lg:col-span-2 w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
};
