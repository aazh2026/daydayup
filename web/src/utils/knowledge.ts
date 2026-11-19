/**
 * 考点筛选 / 排序共享逻辑。
 *
 * 「提分报告 → 考点档案」与「知识图谱」此前各自实现了一套筛选器，
 * 口径还不一致（一个搜定义与避坑点，一个只搜名称与章节）。
 * 这里把口径收敛成一份：两个页面共用同一套筛选语义，
 * 保证同一批考点在两处的「薄弱 / 命中」判断完全一致。
 */
import type { KnowledgePoint, MasteryRecord, MasteryState } from '../types.ts';
import { filterByGrade, resolveGradeInfo } from './grade.ts';

export type KnowledgeSortBy = 'default' | 'weight' | 'cost' | 'lostScore';

/** 状态筛选值：'all' 不限；'薄弱需攻克' 为聚合项；其余为具体状态机状态 */
export type KnowledgeStateFilter = 'all' | '薄弱需攻克' | MasteryState;

export interface KnowledgeFilterState {
  /** 关键词：匹配考点名、章节、板块、定义、考法、避坑点与子技能 */
  search: string;
  /** 年级/学段筛选项 id（见 utils/grade.ts） */
  grade: string;
  /** 知识板块，'all' 不限 */
  domain: string;
  /** 掌握状态筛选项 */
  state: KnowledgeStateFilter;
  /** 排序规则 */
  sort: KnowledgeSortBy;
}

export const DEFAULT_KNOWLEDGE_FILTERS: KnowledgeFilterState = {
  search: '',
  grade: 'all',
  domain: 'all',
  state: 'all',
  sort: 'default',
};

/** 具体状态机状态列表（UI 筛选项顺序 = 状态机迁移顺序） */
export const KNOWLEDGE_STATE_FILTER_OPTIONS: Array<{
  id: KnowledgeStateFilter;
  label: string;
}> = [
  { id: '薄弱需攻克', label: '薄弱待攻克（失分/待学）' },
  { id: '未诊断', label: '未诊断' },
  { id: '待学习', label: '待学习' },
  { id: '学习中', label: '学习中' },
  { id: '初步掌握', label: '初步掌握' },
  { id: '掌握', label: '掌握' },
  { id: '稳定掌握', label: '稳定掌握' },
];

/**
 * 是否属于「薄弱需攻克」：待学习 / 学习中，或有失分证据。
 *
 * 知识图谱的「问题考点」标记与提分报告的薄弱筛选必须同口径，
 * 否则同一考点会在两处得到相反结论。
 */
export function isWeakMastery(state: string, lostScore: number): boolean {
  return state === '待学习' || state === '学习中' || lostScore > 0;
}

/** 状态筛选匹配 */
export function matchesStateFilter(
  state: string,
  lostScore: number,
  filter: KnowledgeStateFilter
): boolean {
  if (filter === 'all') return true;
  if (filter === '薄弱需攻克') return isWeakMastery(state, lostScore);
  return state === filter;
}

/** 关键词匹配：命中名称、章节、板块、定义、考法、避坑点或子技能 */
export function matchesSearch(kp: KnowledgePoint, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  const hay = [
    kp.name,
    kp.chapter ?? '',
    kp.domain ?? '',
    kp.definition ?? '',
    ...(kp.commonExamForms ?? []),
    ...(kp.commonTraps ?? []),
    ...(kp.subSkills ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(kw);
}

/** 关键词检索命中的具体字段（用于在 UI 上标注「命中原因」） */
export function describeSearchHit(kp: KnowledgePoint, keyword: string): string | null {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return null;
  const fields: Array<[string, string]> = [
    ['考点名', kp.name ?? ''],
    ['章节', kp.chapter ?? ''],
    ['板块', kp.domain ?? ''],
    ['定义', kp.definition ?? ''],
    ['考法', (kp.commonExamForms ?? []).join(' ')],
    ['避坑点', (kp.commonTraps ?? []).join(' ')],
    ['子技能', (kp.subSkills ?? []).join(' ')],
  ];
  for (const [label, value] of fields) {
    if (value.toLowerCase().includes(kw)) return label;
  }
  return null;
}

/**
 * 按筛选条件过滤 + 排序考点。
 *
 * 这是「考点档案」与「考点清单」唯一的筛选实现。
 */
export function filterKnowledgePoints(
  kps: KnowledgePoint[],
  filters: KnowledgeFilterState,
  masteryRecords: Record<string, MasteryRecord>
): KnowledgePoint[] {
  const graded = filterByGrade(kps, filters.grade);

  const result = graded.filter((kp) => {
    if (filters.domain !== 'all' && kp.domain !== filters.domain) return false;

    const rec = masteryRecords[kp.id];
    const state = rec?.state ?? '未诊断';
    const lost = rec?.lostScoreEvidence ?? 0;
    if (!matchesStateFilter(state, lost, filters.state)) return false;

    if (!matchesSearch(kp, filters.search)) return false;

    return true;
  });

  return sortKnowledgePoints(result, filters.sort, masteryRecords);
}

/** 排序：默认保持考纲顺序，其余按权重 / 失分 / 攻克学时 */
export function sortKnowledgePoints(
  kps: KnowledgePoint[],
  sort: KnowledgeSortBy,
  masteryRecords: Record<string, MasteryRecord>
): KnowledgePoint[] {
  const sorted = [...kps];
  switch (sort) {
    case 'weight':
      return sorted.sort((a, b) => (b.examWeight ?? 1) - (a.examWeight ?? 1));
    case 'cost':
      return sorted.sort((a, b) => (a.learningCostHours ?? 1) - (b.learningCostHours ?? 1));
    case 'lostScore': {
      const lost = (kp: KnowledgePoint) => masteryRecords[kp.id]?.lostScoreEvidence ?? 0;
      return sorted.sort((a, b) => lost(b) - lost(a));
    }
    default:
      return sorted;
  }
}

export interface DomainOption {
  id: string;
  count: number;
}

/** 统计当前考点集合涉及的板块（带数量） */
export function buildDomainOptions(kps: KnowledgePoint[]): DomainOption[] {
  const counts = new Map<string, number>();
  for (const kp of kps) {
    if (!kp.domain) continue;
    counts.set(kp.domain, (counts.get(kp.domain) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'));
}

/** 考点所属的年级/学段（供 UI 直接展示） */
export function gradeLabelOf(kp: KnowledgePoint): string {
  return resolveGradeInfo(kp.chapter ?? '').label;
}
