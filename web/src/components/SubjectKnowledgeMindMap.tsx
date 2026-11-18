import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  FoldVertical,
  GitBranch,
  Layers,
  RotateCcw,
  Search,
  Target,
  UnfoldVertical,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import type {
  ErrorRecord,
  Exam,
  ExamPaper,
  KnowledgePoint,
  MasteryRecord,
  Subject,
} from '../types.ts';

export interface SubjectKnowledgeMindMapProps {
  subject: Subject;
  examPapers: ExamPaper[];
  exams: Exam[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  selectedPaperId?: string;
  onSelectPaperId?: (paperId: string) => void;
  selectedGrade?: string;
  onSelectGrade?: (grade: string) => void;
  onLaunchCoach: (knowledgeId: string) => void;
  compactHeader?: boolean;
}

type NodeHealth = 'critical' | 'warning' | 'mastered' | 'neutral';

interface SubSkillNodeData {
  id: string;
  label: string;
  health: NodeHealth;
  matchedErrorCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface KpNodeData {
  kp: KnowledgePoint;
  health: NodeHealth;
  lostScore: number;
  errors: ErrorRecord[];
  unresolvedCount: number;
  mastery?: MasteryRecord;
  subSkillNodes: SubSkillNodeData[];
  /** 子技能总数（收起时 subSkillNodes 为空，仍需知道是否有可展开分支） */
  subSkillCount: number;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DomainNodeData {
  domain: string;
  chapter: string;
  health: NodeHealth;
  problemCount: number;
  lostScore: number;
  kpNodes: KpNodeData[];
  collapsed: boolean;
  kpCount: number;
  /** 该板块在画布中的起始 Y（未含节点拖拽偏移），用于展开时锚定视口 */
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

type SelectedSelection =
  | { level: 'root' }
  | { level: 'domain'; domain: string }
  | { level: 'kp'; knowledgeId: string }
  | { level: 'subskill'; knowledgeId: string; subSkill: string };

const SUBSKILL_ALIAS_MAP: Record<string, string[]> = {
  分式有意义条件: ['分母', '有意义', '值为0', '增根'],
  通分与约分: ['通分', '约分', '漏项', '符号'],
  代数式化简求值: ['化简', '求值', '代入'],
  根的判别式: ['判别式', '实数根', 'Δ', '二次项系数'],
  分式方程检验增根: ['增根', '检验', '去分母'],
  函数表达式: ['解析式', '表达式', 'y='],
  图像与性质: ['象限', '增减性', '图像', '平移'],
  待定系数法: ['待定系数', '经过点', '代入'],
  交点问题: ['交点', '联立', '面积'],
  顶点式与对称轴: ['顶点', '对称轴', '抛物线'],
  动点与存在性问题: ['动点', '存在性', '等腰', '直角'],
  角平分线截长补短: ['角平分线', '截长', '补短', '辅助线'],
  'A字型与8字型相似': ['相似', '比例', 'A字', '8字'],
  中位数与众数: ['中位数', '众数', '排序'],
  '名词/形容词/副词词性转换': ['副词', '形容词', '词性', '修饰', 'easily'],
  宾语从句语序与时态呼应: ['宾语从句', '客观真理', '语序', '时态'],
  首字母词性预判: ['首字母', '词性', '转折'],
  'p=F/S 柱体切割变化': ['切割', '压强', '柱体', '面积'],
  串并联识别与电表测量对象: ['串联', '并联', '电压表', '电流表', '分压'],
  滑动变阻器极值与范围: ['滑动变阻器', '滑片', '极值', '范围'],
  '断路/短路故障定位': ['断路', '短路', '故障'],
  额定功率图像读取: ['额定功率', '电功率', '小灯泡', 'U-I'],
  多次测量目的区分: ['平均值', '测电阻', '测电功率'],
  质量守恒定律配平: ['配平', '方程式', '沉淀', '气体', '条件'],
  溶解度曲线交点与析晶判断: ['溶解度', '析晶', '饱和'],
  气体检验与除杂顺序: ['除杂', '干燥', '浓硫酸', '顺序'],
  '150个考纲实词一词多义': ['实词', '通假', '属'],
  重点句子直译踩点: ['翻译', '直译', '倒装'],
  人物描写与环境描写作用: ['环境描写', '写景', '烘托', '情感'],
  标题含义与段落结构作用: ['结构', '照应', '结尾', '承上启下'],
  '半命题/命题作文审题破题': ['审题', '立意', '点题'],
};

function matchesSubSkill(subSkill: string, err: ErrorRecord): boolean {
  const haystack = `${err.stem} ${err.aiAnalysis} ${err.evidence} ${err.verificationMethod}`.toLowerCase();
  const aliases = SUBSKILL_ALIAS_MAP[subSkill] ?? [];
  if (aliases.some((kw) => haystack.includes(kw.toLowerCase()))) {
    return true;
  }
  const tokens = subSkill
    .split(/[与及、/（）()\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return tokens.some((tok) => haystack.includes(tok.toLowerCase()));
}

import { resolveGradeInfo, type GradeInfo } from '../utils/grade.ts';
export { resolveGradeInfo, type GradeInfo };

/**
 * 学科考点超过此数量时，默认收起为「板块级」结构。
 *
 * 当前知识资产覆盖上海 1–9 年级，单科 147–870 个考点、近 2,000 条子技能。
 * 全量展开会一次性渲染上千个绝对定位节点与 SVG 连线（画布高度可达数万像素），
 * 既卡顿又无法浏览；因此默认只展开到板块层，由用户按需逐级下钻。
 */
const DEFAULT_COLLAPSE_THRESHOLD = 60;

function buildDefaultCollapse(kps: KnowledgePoint[]): {
  domains: Set<string>;
  knowledgeIds: Set<string>;
} {
  if (kps.length <= DEFAULT_COLLAPSE_THRESHOLD) {
    return { domains: new Set(), knowledgeIds: new Set() };
  }
  return {
    domains: new Set(kps.map((kp) => kp.domain)),
    knowledgeIds: new Set(kps.map((kp) => kp.id)),
  };
}

function getEdgeStroke(health: NodeHealth): { stroke: string; width: number; dashed: boolean } {
  switch (health) {
    case 'critical':
      return { stroke: '#DC2626', width: 2.25, dashed: false };
    case 'warning':
      return { stroke: '#D97706', width: 2, dashed: false };
    case 'mastered':
      return { stroke: '#059669', width: 1.75, dashed: false };
    default:
      return { stroke: '#CBD5E1', width: 1.5, dashed: true };
  }
}

function getNodeSurfaceClass(health: NodeHealth, isSelected: boolean): string {
  const ring = isSelected ? 'ring-2 ring-blue-600 ring-offset-1' : '';
  switch (health) {
    case 'critical':
      return `bg-red-50/90 border-red-300 hover:border-red-400 text-slate-900 ${ring}`;
    case 'warning':
      return `bg-amber-50/85 border-amber-300 hover:border-amber-400 text-slate-900 ${ring}`;
    case 'mastered':
      return `bg-emerald-50/70 border-emerald-200 hover:border-emerald-300 text-slate-900 ${ring}`;
    default:
      return `bg-white border-slate-200 hover:border-slate-300 text-slate-800 ${ring}`;
  }
}

function renderHealthTag(health: NodeHealth, lostScore: number, isCumulative: boolean) {
  if (health === 'critical') {
    return (
      <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
        <AlertCircle className="w-3 h-3 shrink-0" />
        <span>问题点</span>
        {lostScore > 0 && <span className="font-mono tabular-nums">-{lostScore}分</span>}
      </span>
    );
  }
  if (health === 'warning') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
        <AlertTriangle className="w-3 h-3 shrink-0" />
        <span>待巩固</span>
        {lostScore > 0 && <span className="font-mono tabular-nums">-{lostScore}分</span>}
      </span>
    );
  }
  if (health === 'mastered') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        <span>{isCumulative ? '已掌握' : '本卷稳固'}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-slate-400">
      <Circle className="w-2.5 h-2.5 shrink-0" />
      <span>{isCumulative ? '未诊断' : '未涉失分'}</span>
    </span>
  );
}

export const SubjectKnowledgeMindMap: React.FC<SubjectKnowledgeMindMapProps> = ({
  subject,
  examPapers,
  exams,
  errorRecords,
  masteryRecords,
  selectedPaperId: controlledPaperId,
  onSelectPaperId,
  selectedGrade: controlledGrade,
  onSelectGrade,
  onLaunchCoach,
  compactHeader = false,
}) => {
  /** 知识体系（服务端资产） */
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: SHANGHAI_CURRICULUM,
  } = useCurriculum();

  const subjectKps = useMemo(
    () => SHANGHAI_CURRICULUM.filter((kp) => kp.subject === subject),
    [SHANGHAI_CURRICULUM, subject]
  );

  const [internalPaperId, setInternalPaperId] = useState<string>(controlledPaperId ?? 'all');
  const [internalGrade, setInternalGrade] = useState<string>(controlledGrade ?? 'all');
  const [onlyProblemBranches, setOnlyProblemBranches] = useState(false);
  const [mapSearchKw, setMapSearchKw] = useState('');

  const effectivePaperId = controlledPaperId ?? internalPaperId;
  const setPaperId = (id: string) => {
    if (onSelectPaperId) {
      onSelectPaperId(id);
    } else {
      setInternalPaperId(id);
    }
  };

  const effectiveGrade = controlledGrade ?? internalGrade;
  const setGrade = (grade: string) => {
    if (onSelectGrade) {
      onSelectGrade(grade);
    } else {
      setInternalGrade(grade);
    }
  };

  /** 计算当前学科下可用的年级与学段筛选选项 */
  const gradeOptions = useMemo(() => {
    const counts = {
      all: subjectKps.length,
      初三: 0,
      初二: 0,
      初一: 0,
      junior: 0,
      primary: 0,
      senior: 0,
    };

    for (const kp of subjectKps) {
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
    const juniorGradeCount =
      (counts['初三'] > 0 ? 1 : 0) +
      (counts['初二'] > 0 ? 1 : 0) +
      (counts['初一'] > 0 ? 1 : 0);
    if (juniorGradeCount > 1 && counts.junior > counts['初三']) {
      options.push({
        id: 'junior',
        label: '初中全学段（七~九年级）',
        count: counts.junior,
      });
    }
    if (counts.primary > 0) {
      options.push({
        id: 'primary',
        label: '小学阶段（先修回溯）',
        count: counts.primary,
      });
    }
    if (counts.senior > 0) {
      options.push({
        id: 'senior',
        label: '高中阶段（衔接拓展）',
        count: counts.senior,
      });
    }

    return options;
  }, [subjectKps]);

  // 当切换学科后，如果当前选中的年级在当前学科下没有考点，重置为 'all'
  useEffect(() => {
    if (effectiveGrade === 'all') return;
    const exists = gradeOptions.some((opt) => opt.id === effectiveGrade && opt.count > 0);
    if (!exists) {
      setGrade('all');
    }
  }, [subject, gradeOptions, effectiveGrade]);

  /** 按年级与学段筛选后的学科考点集合 */
  const filteredSubjectKps = useMemo(() => {
    if (effectiveGrade === 'all') return subjectKps;
    return subjectKps.filter((kp) => {
      const info = resolveGradeInfo(kp.chapter);
      if (effectiveGrade === 'junior') return info.stage === '初中';
      if (effectiveGrade === 'primary') return info.stage === '小学';
      if (effectiveGrade === 'senior') return info.stage === '高中';
      return info.grade === effectiveGrade;
    });
  }, [subjectKps, effectiveGrade]);

  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(
    () => buildDefaultCollapse(filteredSubjectKps).domains
  );
  const [collapsedKps, setCollapsedKps] = useState<Set<string>>(
    () => buildDefaultCollapse(filteredSubjectKps).knowledgeIds
  );
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<
    Record<string, { dx: number; dy: number }>
  >({});
  const [dragMode, setDragMode] = useState<'pan' | 'node' | null>(null);
  const [selection, setSelection] = useState<SelectedSelection>({ level: 'root' });

  /** 切换学科或年级时，重置视图收起状态与画布位置 */
  const lastSubjectGradeRef = useRef<string>(
    filteredSubjectKps.length > 0 ? `${subject}:${effectiveGrade}` : ''
  );
  /** 用户展开某个已收起分支后，待布局刷新完成再把视口平移过去。 */
  const pendingFocusRef = useRef<{
    type: 'domain' | 'kp';
    id: string;
    /** 展开板块时锚定的屏幕 Y，保证分支起始位置不跳动 */
    anchorScreenY?: number;
  } | null>(null);
  /** 拖拽结束后紧随其后的 click 不应触发节点选中。 */
  const suppressClickUntilRef = useRef(0);

  useEffect(() => {
    if (filteredSubjectKps.length === 0) return;
    const currentKey = `${subject}:${effectiveGrade}`;
    if (lastSubjectGradeRef.current === currentKey) return;
    lastSubjectGradeRef.current = currentKey;
    const defaults = buildDefaultCollapse(filteredSubjectKps);
    setCollapsedDomains(defaults.domains);
    setCollapsedKps(defaults.knowledgeIds);
    setNodeOffsets({});
    setPan({ x: 0, y: 0 });
    setZoom(1);
    pendingFocusRef.current = null;
  }, [subject, effectiveGrade, filteredSubjectKps]);

  const subjectPapers = useMemo(
    () =>
      examPapers
        .filter((p) => p.subject === subject)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [examPapers, subject]
  );

  const activePaper = useMemo(
    () =>
      effectivePaperId === 'all'
        ? undefined
        : subjectPapers.find((p) => p.id === effectivePaperId),
    [effectivePaperId, subjectPapers]
  );

  // Scoped errors for selected paper (or all papers of subject)
  const scopedErrors = useMemo(() => {
    const subErrors = errorRecords.filter((e) => e.subject === subject);
    if (!activePaper) return subErrors;
    return subErrors.filter(
      (err) =>
        err.examPaperId === activePaper.id ||
        (err.examId === activePaper.examId && err.subject === activePaper.subject)
    );
  }, [errorRecords, subject, activePaper]);

  const paperKnowledgeSet = useMemo(() => {
    if (!activePaper) return new Set<string>();
    return new Set([
      ...(activePaper.knowledgeIds ?? []),
      ...scopedErrors.map((e) => e.knowledgeId),
    ]);
  }, [activePaper, scopedErrors]);

  // Build Mind Map tree + deterministic horizontal coordinates
  const mindMap = useMemo(() => {
    const domainMap = new Map<string, KnowledgePoint[]>();
    for (const kp of filteredSubjectKps) {
      const list = domainMap.get(kp.domain) ?? [];
      list.push(kp);
      domainMap.set(kp.domain, list);
    }

    const L0_X = 20;
    const L0_W = 176;
    const L0_H = 74;

    const L1_X = 246;
    const L1_W = 176;
    const L1_H = 62;

    const L2_X = 472;
    const L2_W = 240;
    const L2_H = 76;

    const L3_X = 762;
    const L3_W = 200;
    const L3_H = 36;

    const TOP_PAD = 24;
    const SUBSKILL_STEP = 44;
    const KP_MIN_SLOT = 92;
    const KP_GAP = 14;
    const DOMAIN_GAP = 22;

    interface KpItemData {
      kp: KnowledgePoint;
      health: NodeHealth;
      lostScore: number;
      errors: ErrorRecord[];
      unresolvedCount: number;
      mastery?: MasteryRecord;
      subSkills: Array<{ label: string; health: NodeHealth; matchedErrorCount: number }>;
    }

    const rawDomains: Array<{
      domain: string;
      chapter: string;
      items: KpItemData[];
    }> = [];

    for (const [domain, kps] of domainMap.entries()) {
      const items: KpItemData[] = kps.map((kp) => {
        const errs = scopedErrors.filter((e) => e.knowledgeId === kp.id);
        const lostScore = errs.reduce((s, e) => s + e.scoreLost, 0);
        const unresolvedCount = errs.filter((e) => e.status !== '已闭环').length;
        const mastery = masteryRecords[kp.id];
        const isMasteredState =
          mastery?.state === '初步掌握' ||
          mastery?.state === '掌握' ||
          mastery?.state === '稳定掌握';

        let health: NodeHealth = 'neutral';
        if (errs.length > 0) {
          if (
            unresolvedCount > 0 &&
            (lostScore >= 4 || errs.length >= 2 || mastery?.state === '待学习')
          ) {
            health = 'critical';
          } else if (unresolvedCount > 0 || !isMasteredState) {
            health = 'warning';
          } else {
            health = 'mastered';
          }
        } else if (activePaper) {
          if (paperKnowledgeSet.has(kp.id)) {
            health = 'mastered';
          } else if (isMasteredState) {
            health = 'mastered';
          } else {
            health = 'neutral';
          }
        } else {
          if (mastery?.state === '待学习') {
            health = 'critical';
          } else if (mastery?.state === '学习中') {
            health = 'warning';
          } else if (isMasteredState) {
            health = 'mastered';
          } else {
            health = 'neutral';
          }
        }

        const subSkills = kp.subSkills.map((sk) => {
          const matched = errs.filter((e) => matchesSubSkill(sk, e));
          let skHealth: NodeHealth = 'neutral';
          if (matched.length > 0) {
            const skLost = matched.reduce((s, e) => s + e.scoreLost, 0);
            const skUnresolved = matched.some((e) => e.status !== '已闭环');
            skHealth =
              skUnresolved && (skLost >= 4 || health === 'critical')
                ? 'critical'
                : 'warning';
          } else if (health === 'mastered') {
            skHealth = 'mastered';
          }
          return { label: sk, health: skHealth, matchedErrorCount: matched.length };
        });

        return {
          kp,
          health,
          lostScore,
          errors: errs,
          unresolvedCount,
          mastery,
          subSkills,
        };
      });

      const filteredItems = onlyProblemBranches
        ? items.filter(
            (item) => item.health === 'critical' || item.health === 'warning'
          )
        : items;

      if (filteredItems.length > 0) {
        // 新知识资产里一个板块横跨多个年级/单元（如「数与代数」覆盖 430 个考点、
        // 132 个单元），展示首个单元会误导；跨单元时显示单元总数。
        const chapterCount = new Set(kps.map((kp) => kp.chapter)).size;
        rawDomains.push({
          domain,
          chapter:
            chapterCount > 1
              ? `跨 ${chapterCount} 个单元`
              : kps[0]?.chapter ?? domain,
          items: filteredItems,
        });
      }
    }

    const buildKpNode = (item: KpItemData, collapsed: boolean): KpNodeData => ({
      kp: item.kp,
      health: item.health,
      lostScore: item.lostScore,
      errors: item.errors,
      unresolvedCount: item.unresolvedCount,
      mastery: item.mastery,
      subSkillNodes: [],
      subSkillCount: item.subSkills.length,
      collapsed,
      x: 0,
      y: 0,
      width: L2_W,
      height: L2_H,
    });

    let cursorY = TOP_PAD;
    const domainNodes: DomainNodeData[] = [];
    const allKpNodes: KpNodeData[] = [];

    for (const dom of rawDomains) {
      const isDomainCollapsed = collapsedDomains.has(dom.domain);
      const domStartY = cursorY;
      const kpNodes: KpNodeData[] = [];
      const laidOutIds = new Set<string>();

      if (!isDomainCollapsed) {
        for (let ki = 0; ki < dom.items.length; ki++) {
          const item = dom.items[ki];
          const kpCollapsed = collapsedKps.has(item.kp.id);
          const subCount = kpCollapsed ? 0 : item.subSkills.length;
          const slotHeight = Math.max(KP_MIN_SLOT, subCount * SUBSKILL_STEP);
          const kpStartY = cursorY;
          const kpNode = buildKpNode(item, kpCollapsed);

          if (!kpCollapsed && subCount > 0) {
            const totalSubH =
              subCount * L3_H + Math.max(0, subCount - 1) * (SUBSKILL_STEP - L3_H);
            const subOffsetY = kpStartY + Math.max(0, (slotHeight - totalSubH) / 2);
            item.subSkills.forEach((sk, si) => {
              kpNode.subSkillNodes.push({
                id: `${item.kp.id}::${sk.label}`,
                label: sk.label,
                health: sk.health,
                matchedErrorCount: sk.matchedErrorCount,
                x: L3_X,
                y: subOffsetY + si * SUBSKILL_STEP,
                width: L3_W,
                height: L3_H,
              });
            });
          }

          kpNode.x = L2_X;
          kpNode.y = kpStartY + slotHeight / 2 - L2_H / 2;
          kpNodes.push(kpNode);
          allKpNodes.push(kpNode);
          laidOutIds.add(item.kp.id);

          cursorY += slotHeight + (ki < dom.items.length - 1 ? KP_GAP : 0);
        }
      }

      // 收起的板块仍保留考点数据，供右侧透视面板与先修链查询（不参与布局）
      for (const item of dom.items) {
        if (laidOutIds.has(item.kp.id)) continue;
        allKpNodes.push(buildKpNode(item, collapsedKps.has(item.kp.id)));
      }

      const problemCount = dom.items.filter(
        (item) => item.health === 'critical' || item.health === 'warning'
      ).length;
      const domLostScore = dom.items.reduce((s, item) => s + item.lostScore, 0);
      const hasCritical = dom.items.some((item) => item.health === 'critical');
      const hasWarning = dom.items.some((item) => item.health === 'warning');
      const allMastered =
        dom.items.length > 0 && dom.items.every((item) => item.health === 'mastered');

      const domHealth: NodeHealth = hasCritical
        ? 'critical'
        : hasWarning
        ? 'warning'
        : allMastered
        ? 'mastered'
        : 'neutral';

      if (isDomainCollapsed) {
        domainNodes.push({
          domain: dom.domain,
          chapter: dom.chapter,
          health: domHealth,
          problemCount,
          lostScore: domLostScore,
          kpNodes,
          collapsed: true,
          kpCount: dom.items.length,
          startY: domStartY,
          x: L1_X,
          y: domStartY,
          width: L1_W,
          height: L1_H,
        });
        cursorY += L1_H + DOMAIN_GAP;
      } else {
        domainNodes.push({
          domain: dom.domain,
          chapter: dom.chapter,
          health: domHealth,
          problemCount,
          lostScore: domLostScore,
          kpNodes,
          collapsed: false,
          kpCount: dom.items.length,
          startY: domStartY,
          x: L1_X,
          // 板块与分支顶部对齐：单板块可能有数百个考点，居中会让板块节点
          // 落在画布视口之外，展开后只能看到一串没有上下文的考点。
          y: domStartY,
          width: L1_W,
          height: L1_H,
        });
        cursorY += DOMAIN_GAP;
      }
    }

    const totalHeight = Math.max(260, cursorY + 12);
    const hasVisibleSubSkills = allKpNodes.some((k) => k.subSkillNodes.length > 0);
    const totalWidth = hasVisibleSubSkills ? L3_X + L3_W + 24 : L2_X + L2_W + 24;

    const rootY =
      domainNodes.length > 0
        ? (domainNodes[0].y +
            domainNodes[domainNodes.length - 1].y +
            L1_H) /
            2 -
          L0_H / 2
        : totalHeight / 2 - L0_H / 2;

    const totalProblemKps = domainNodes.reduce((s, d) => s + d.problemCount, 0);
    const totalLostScore = domainNodes.reduce((s, d) => s + d.lostScore, 0);
    const rootHealth: NodeHealth = domainNodes.some((d) => d.health === 'critical')
      ? 'critical'
      : domainNodes.some((d) => d.health === 'warning')
      ? 'warning'
      : domainNodes.length > 0 && domainNodes.every((d) => d.health === 'mastered')
      ? 'mastered'
      : 'neutral';

    return {
      width: totalWidth,
      height: totalHeight,
      root: {
        x: L0_X,
        y: rootY,
        width: L0_W,
        height: L0_H,
        health: rootHealth,
        totalProblemKps,
        totalLostScore,
      },
      domainNodes,
      allKpNodes,
      allDomains: [...domainMap.keys()],
      allKpIds: filteredSubjectKps.map((kp) => kp.id),
    };
  }, [
    filteredSubjectKps,
    scopedErrors,
    masteryRecords,
    activePaper,
    paperKnowledgeSet,
    onlyProblemBranches,
    collapsedDomains,
    collapsedKps,
  ]);

  const gradeTitleLabel = useMemo(() => {
    if (effectiveGrade === 'all') return `全部年级${subject}`;
    if (effectiveGrade === 'junior') return `初中全学段${subject}`;
    if (effectiveGrade === 'primary') return `小学${subject}`;
    if (effectiveGrade === 'senior') return `高中${subject}`;
    return `${effectiveGrade}${subject}`;
  }, [effectiveGrade, subject]);

  // Reset or auto-focus selection on first problem node when subject, paper, or grade changes
  useEffect(() => {
    const firstProblemKp = mindMap.allKpNodes.find(
      (k) => k.health === 'critical' || k.health === 'warning'
    );
    if (firstProblemKp) {
      setSelection({ level: 'kp', knowledgeId: firstProblemKp.kp.id });
    } else {
      setSelection({ level: 'root' });
    }
  }, [subject, effectivePaperId, effectiveGrade]);

  /** 当前实际参与布局（可见）的考点节点；收起的分支只在 allKpNodes 中保留数据。 */
  const layoutKpNodes = useMemo(
    () => mindMap.domainNodes.flatMap((d) => d.kpNodes),
    [mindMap]
  );

  const allKpNodes = mindMap.allKpNodes;

  // Selected Inspector Context
  const selectedKpNode = useMemo(() => {
    if (selection.level === 'kp' || selection.level === 'subskill') {
      return allKpNodes.find((k) => k.kp.id === selection.knowledgeId);
    }
    return undefined;
  }, [selection, allKpNodes]);

  const selectedDomainNode = useMemo(() => {
    if (selection.level === 'domain') {
      return mindMap.domainNodes.find((d) => d.domain === selection.domain);
    }
    return undefined;
  }, [selection, mindMap]);

  const isCumulative = !activePaper;

  /** 选中的节点当前是否真的画在画布上（可能被所在板块/考点收起，或被筛选掉） */
  const selectedKpVisible = selectedKpNode
    ? layoutKpNodes.some((k) => k.kp.id === selectedKpNode.kp.id)
    : false;
  const selectedSubSkillVisible =
    selection.level !== 'subskill' ||
    (selectedKpNode
      ? selectedKpNode.subSkillNodes.some((sk) => sk.label === selection.subSkill)
      : false);
  const selectedNodeVisible = selectedKpVisible && selectedSubSkillVisible;
  const selectedKpHiddenByCollapse = selectedKpNode
    ? collapsedDomains.has(selectedKpNode.kp.domain) ||
      collapsedKps.has(selectedKpNode.kp.id)
    : false;

  // 展开分支后把视口平移到目标，避免用户展开后还要手动找位置
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;

    if (target.type === 'domain') {
      const dom = mindMap.domainNodes.find((d) => d.domain === target.id);
      if (!dom) return;
      // 保持分支起始位置在屏幕上不动：展开 200 个考点时不能把首个考点甩出视口
      setPan((prev) => ({
        ...prev,
        y: (target.anchorScreenY ?? prev.y) - dom.startY * zoom,
      }));
      return;
    }

    const kpNode = layoutKpNodes.find((k) => k.kp.id === target.id);
    if (!kpNode) return;
    setPan((prev) => ({ ...prev, y: -Math.max(0, kpNode.y - 16) }));
  }, [mindMap, layoutKpNodes, zoom]);

  const toggleDomain = (domain: string) => {
    const willCollapse = !collapsedDomains.has(domain);
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      if (willCollapse) next.add(domain);
      else next.delete(domain);
      return next;
    });
    if (willCollapse) {
      // 选中项被收起时，把透视面板切到该板块，避免右侧内容无故消失
      if (selectedKpNode?.kp.domain === domain) {
        setSelection({ level: 'domain', domain });
      }
    } else {
      const dom = mindMap.domainNodes.find((d) => d.domain === domain);
      pendingFocusRef.current = {
        type: 'domain',
        id: domain,
        anchorScreenY: pan.y + (dom?.startY ?? 0) * zoom,
      };
    }
  };

  const toggleKp = (knowledgeId: string) => {
    const willCollapse = !collapsedKps.has(knowledgeId);
    setCollapsedKps((prev) => {
      const next = new Set(prev);
      if (willCollapse) next.add(knowledgeId);
      else next.delete(knowledgeId);
      return next;
    });
    if (
      willCollapse &&
      selection.level === 'subskill' &&
      selection.knowledgeId === knowledgeId
    ) {
      setSelection({ level: 'kp', knowledgeId });
    }
  };

  /** 全部展开：展开所有板块、考点与四级子技能 */
  const expandAllBranches = () => {
    setCollapsedDomains(new Set());
    setCollapsedKps(new Set());
  };

  /** 全部收起：回到「板块级」总览（考点也收起，便于逐项下钻） */
  const collapseAllBranches = () => {
    setCollapsedDomains(new Set(mindMap.allDomains));
    setCollapsedKps(new Set(mindMap.allKpIds));
  };

  /** 展开被收起的考点分支并定位过去 */
  const revealKp = (knowledgeId: string) => {
    const kp = KNOWLEDGE_MAP[knowledgeId];
    if (!kp) return;
    const domainCollapsed = collapsedDomains.has(kp.domain);
    const kpCollapsed = collapsedKps.has(knowledgeId);
    if (domainCollapsed) {
      setCollapsedDomains((prev) => {
        const next = new Set(prev);
        next.delete(kp.domain);
        return next;
      });
    }
    if (kpCollapsed) {
      setCollapsedKps((prev) => {
        const next = new Set(prev);
        next.delete(knowledgeId);
        return next;
      });
    }
    if (domainCollapsed || kpCollapsed) {
      pendingFocusRef.current = { type: 'kp', id: knowledgeId };
    }
  };

  /** 复位缩放、平移与节点手工位置 */
  const resetView = () => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setNodeOffsets({});
  };

  /** 节点相对布局坐标的拖拽偏移（图坐标，不受缩放/平移影响） */
  const posOf = (key: string, x: number, y: number) => {
    const offset = nodeOffsets[key];
    if (!offset) return { x, y };
    return { x: x + offset.dx, y: y + offset.dy };
  };

  const resetNodeOffset = (key: string) => {
    setNodeOffsets((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /**
   * 画布手势：
   *  - 空白处拖拽 → 平移画布
   *  - 节点上拖拽 → 移动该节点（双击节点复位）
   *
   * 用 window 监听而不是 setPointerCapture：后者会把 pointerup/click 的
   * 目标改成捕获元素，导致节点按钮的点击选中失效。
   */
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest('[data-mindmap-toggle]')) return;

    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-mindmap-node]'
    );
    const nodeKey = e.button === 0 ? nodeEl?.dataset.mindmapNode ?? null : null;
    const startX = e.clientX;
    const startY = e.clientY;
    const panStart = pan;
    const scale = zoom;
    const offsetStart = nodeKey ? nodeOffsets[nodeKey] ?? { dx: 0, dy: 0 } : null;
    let moved = false;

    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      setDragMode(nodeKey ? 'node' : 'pan');
      if (nodeKey && offsetStart) {
        setNodeOffsets((prev) => ({
          ...prev,
          [nodeKey]: {
            dx: offsetStart.dx + dx / scale,
            dy: offsetStart.dy + dy / scale,
          },
        }));
      } else {
        setPan({ x: panStart.x + dx, y: panStart.y + dy });
      }
      ev.preventDefault();
    };

    const finish = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      setDragMode(null);
      if (moved) {
        // 拖拽结束后的 click 不应被当成节点选中
        suppressClickUntilRef.current = performance.now() + 400;
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const handleCanvasClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (performance.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const rootPos = posOf('root', mindMap.root.x, mindMap.root.y);
  const canvasHeight = Math.min(
    compactHeader ? 460 : 620,
    Math.max(320, Math.round(mindMap.height * zoom))
  );

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Toolbar Header */}
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="w-4 h-4 text-blue-700 shrink-0" />
            <h3 className="text-base font-semibold text-slate-900">
              {compactHeader
                ? `${gradeTitleLabel}学科知识思维导图 · 本卷问题点定位`
                : `${gradeTitleLabel}学科知识思维导图 · 试卷问题点标记`}
            </h3>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            将试卷失分题与细粒度子技能直接映射至学科知识树，支持按年级与学段快速切换；红色/琥珀色分支高亮标注失分漏洞与前置依赖风险
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Grade / Stage Selector */}
          <select
            aria-label="选择查看的年级或学段"
            value={effectiveGrade}
            onChange={(e) => setGrade(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium border border-blue-200 rounded-lg bg-blue-50/60 text-blue-900 focus:outline-none focus:border-blue-600 focus:bg-white transition-colors"
          >
            {gradeOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}（{opt.count}个考点）
              </option>
            ))}
          </select>

          {!compactHeader && (
            <select
              aria-label="选择映射的试卷范围"
              value={effectivePaperId}
              onChange={(e) => setPaperId(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-800 focus:outline-none focus:border-blue-600 max-w-xs"
            >
              <option value="all">
                全部{subject}试卷累计问题点（{subjectPapers.length} 份卷）
              </option>
              {subjectPapers.map((p) => {
                const ex = exams.find((x) => x.id === p.examId);
                return (
                  <option key={p.id} value={p.id}>
                    {p.date} · {p.title}
                    {ex ? ` (${ex.type})` : ''}
                    {` [-${p.totalLostScore}分]`}
                  </option>
                );
              })}
            </select>
          )}

          <button
            type="button"
            onClick={() => setOnlyProblemBranches((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              onlyProblemBranches
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {onlyProblemBranches ? '仅看问题分支（开启）' : '仅看问题分支'}
          </button>

          <div className="inline-flex items-center border border-slate-200 rounded-lg bg-white overflow-hidden">
            <button
              type="button"
              onClick={expandAllBranches}
              title="展开全部板块、考点与四级子技能"
              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 border-r border-slate-200 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <UnfoldVertical className="w-3.5 h-3.5" />
              <span>全部展开</span>
            </button>
            <button
              type="button"
              onClick={collapseAllBranches}
              title="全部收起至板块层级，便于逐项下钻"
              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <FoldVertical className="w-3.5 h-3.5" />
              <span>全部收起</span>
            </button>
          </div>

          {/* Quick Search within MindMap */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={mapSearchKw}
              onChange={(e) => setMapSearchKw(e.target.value)}
              placeholder="导图内定位考点..."
              className="pl-8 pr-7 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-800 w-36 focus:w-48 transition-all"
            />
            {mapSearchKw && (
              <button
                type="button"
                onClick={() => setMapSearchKw('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            {mapSearchKw && (
              <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto divide-y divide-slate-100">
                {subjectKps
                  .filter((k) => k.name.toLowerCase().includes(mapSearchKw.toLowerCase()))
                  .slice(0, 8)
                  .map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => {
                        revealKp(k.id);
                        setSelection({ level: 'kp', knowledgeId: k.id });
                        setMapSearchKw('');
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 transition-colors flex items-center justify-between"
                    >
                      <div>
                        <div className="font-semibold text-slate-800">{k.name}</div>
                        <div className="text-[10px] text-slate-400">
                          {k.domain} · {k.chapter}
                        </div>
                      </div>
                      <ArrowRight className="w-3 h-3 text-slate-400" />
                    </button>
                  ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={resetView}
            title="复位缩放、画布平移与节点手工位置"
            aria-label="复位思维导图视图"
            className="p-1.5 text-slate-600 bg-white border border-slate-200 rounded-lg hover:text-slate-900 hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <div className="inline-flex items-center border border-slate-200 rounded-lg bg-white">
            <button
              type="button"
              aria-label="缩小思维导图"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-l-lg"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono tabular-nums text-slate-600">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="放大思维导图"
              onClick={() => setZoom((z) => Math.min(1.5, Number((z + 0.1).toFixed(2))))}
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-r-lg"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Semantic Legend Strip */}
      <div className="px-6 py-2.5 bg-slate-50/80 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-4 text-slate-600">
          <span className="inline-flex items-center gap-1 font-medium text-red-700">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>重点问题点（高失分 / 待学习）</span>
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>存在薄弱 / 待巩固</span>
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>已掌握 / 本卷无失分</span>
          </span>
          <span className="inline-flex items-center gap-1 text-slate-500">
            <Circle className="w-3 h-3" />
            <span>未涉题 / 暂未诊断</span>
          </span>
        </div>

        <div className="font-mono tabular-nums text-slate-600">
          标出问题考点 {mindMap.root.totalProblemKps} 个 · 关联失分{' '}
          <span className="font-semibold text-red-700">-{mindMap.root.totalLostScore} 分</span>
        </div>
      </div>

      {/* Two-Zone Interactive Stage: Mind Map Canvas (Left 8 cols) + Diagnostic Inspector (Right 4 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch">
        {/* Interactive Canvas Stage */}
        <div
          className={`lg:col-span-8 border-b lg:border-b-0 lg:border-r border-slate-200 relative overflow-hidden bg-slate-50/60 select-none touch-none ${
            dragMode === 'pan' ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{
            height: `${canvasHeight}px`,
            backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)',
            backgroundSize: '18px 18px',
          }}
          onPointerDown={handleCanvasPointerDown}
          onClickCapture={handleCanvasClickCapture}
          onDoubleClick={(e) => {
            if (
              !(e.target as HTMLElement).closest(
                '[data-mindmap-node], [data-mindmap-toggle]'
              )
            ) {
              resetView();
            }
          }}
        >
          {mindMap.domainNodes.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <div className="text-sm font-medium text-slate-800">
                当前筛选在「{gradeTitleLabel}」上未标出未解决的问题点
              </div>
              <p className="text-xs text-slate-500">
                可关闭「仅看问题分支」查看完整的{gradeTitleLabel}知识结构树，或切换至其他年级或历史试卷对比。
              </p>
              {onlyProblemBranches && (
                <button
                  type="button"
                  onClick={() => setOnlyProblemBranches(false)}
                  className="px-3.5 py-1.5 text-xs font-medium text-blue-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
                >
                  显示全学科知识思维导图
                </button>
              )}
            </div>
          ) : (
            <div
              className="relative origin-top-left"
              style={{
                width: `${mindMap.width}px`,
                height: `${mindMap.height}px`,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                willChange: 'transform',
              }}
            >
              {/* SVG Cubic Bezier Branch Layer */}
              <svg
                width={mindMap.width}
                height={mindMap.height}
                className="absolute inset-0 pointer-events-none overflow-visible"
              >
                {mindMap.domainNodes.map((dom) => {
                  const domPos = posOf(`dom:${dom.domain}`, dom.x, dom.y);
                  const domEdge = getEdgeStroke(dom.health);
                  const x1 = rootPos.x + mindMap.root.width;
                  const y1 = rootPos.y + mindMap.root.height / 2;
                  const x2 = domPos.x;
                  const y2 = domPos.y + dom.height / 2;
                  const cx = (x1 + x2) / 2;

                  /**
                   * 板块 → 考点用「竖直干线 + 短支线」而不是逐条长贝塞尔曲线。
                   * 当前资产单个板块可达 430 个考点，逐条曲线会在视口中形成
                   * 一大束穿屏长线，既看不清归属也影响性能。
                   */
                  const trunkX = domPos.x + dom.width + 24;
                  const kpCenters = dom.kpNodes.map((kpNode) => {
                    const kpPos = posOf(`kp:${kpNode.kp.id}`, kpNode.x, kpNode.y);
                    return { kpNode, kpPos, cy: kpPos.y + kpNode.height / 2 };
                  });
                  const trunkTop = Math.min(y2, ...kpCenters.map((c) => c.cy));
                  const trunkBottom = Math.max(y2, ...kpCenters.map((c) => c.cy));

                  return (
                    <g key={`edge-group-${dom.domain}`}>
                      <path
                        d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={domEdge.stroke}
                        strokeWidth={domEdge.width}
                        strokeDasharray={domEdge.dashed ? '4 4' : undefined}
                      />
                      {kpCenters.length > 0 && (
                        <>
                          <path
                            d={`M ${domPos.x + dom.width} ${y2} H ${trunkX}`}
                            fill="none"
                            stroke={domEdge.stroke}
                            strokeWidth={domEdge.width}
                            strokeDasharray={domEdge.dashed ? '4 4' : undefined}
                          />
                          <path
                            d={`M ${trunkX} ${trunkTop} V ${trunkBottom}`}
                            fill="none"
                            stroke={domEdge.stroke}
                            strokeWidth={domEdge.width}
                            strokeDasharray={domEdge.dashed ? '4 4' : undefined}
                          />
                        </>
                      )}
                      {kpCenters.map(({ kpNode, kpPos, cy }) => {
                        const kpEdge = getEdgeStroke(kpNode.health);
                        const isKpSelected =
                          (selection.level === 'kp' || selection.level === 'subskill') &&
                          selection.knowledgeId === kpNode.kp.id;

                        return (
                          <g key={`edge-kp-${kpNode.kp.id}`}>
                            <path
                              d={`M ${trunkX} ${cy} H ${kpPos.x}`}
                              fill="none"
                              stroke={kpEdge.stroke}
                              strokeWidth={isKpSelected ? kpEdge.width + 1 : kpEdge.width}
                              strokeDasharray={kpEdge.dashed ? '4 4' : undefined}
                            />
                            {kpNode.subSkillNodes.map((sk) => {
                              const skPos = posOf(`sk:${sk.id}`, sk.x, sk.y);
                              const skEdge = getEdgeStroke(sk.health);
                              const sx1 = kpPos.x + kpNode.width;
                              const sy1 = kpPos.y + kpNode.height / 2;
                              const sx2 = skPos.x;
                              const sy2 = skPos.y + sk.height / 2;
                              const scx = (sx1 + sx2) / 2;
                              return (
                                <path
                                  key={`edge-sk-${sk.id}`}
                                  d={`M ${sx1} ${sy1} C ${scx} ${sy1}, ${scx} ${sy2}, ${sx2} ${sy2}`}
                                  fill="none"
                                  stroke={skEdge.stroke}
                                  strokeWidth={skEdge.width}
                                  strokeDasharray={skEdge.dashed ? '3 3' : undefined}
                                />
                              );
                            })}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </svg>

              {/* L0 Root Node */}
              <button
                type="button"
                data-mindmap-node="root"
                draggable={false}
                onClick={() => setSelection({ level: 'root' })}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  resetNodeOffset('root');
                }}
                title="拖拽移动节点 · 双击复位位置"
                style={{
                  left: `${rootPos.x}px`,
                  top: `${rootPos.y}px`,
                  width: `${mindMap.root.width}px`,
                  height: `${mindMap.root.height}px`,
                }}
                className={`absolute rounded-xl border p-3 text-left transition-shadow shadow-xs flex flex-col justify-between cursor-grab active:cursor-grabbing ${getNodeSurfaceClass(
                  mindMap.root.health,
                  selection.level === 'root'
                )}`}
              >
                <div className="text-[11px] font-medium text-slate-500 truncate">
                  {activePaper ? activePaper.title : `${gradeTitleLabel}知识考纲`}
                </div>
                <div className="text-sm font-bold text-slate-900">
                  {gradeTitleLabel}知识树
                </div>
                <div className="text-[11px] font-mono tabular-nums text-slate-600">
                  {mindMap.root.totalProblemKps > 0
                    ? `${mindMap.root.totalProblemKps}处问题 · -${mindMap.root.totalLostScore}分`
                    : '暂无问题标记'}
                </div>
              </button>

              {/* L1 Domain Nodes */}
              {mindMap.domainNodes.map((dom) => {
                const isSelected =
                  selection.level === 'domain' && selection.domain === dom.domain;
                const domKey = `dom:${dom.domain}`;
                const domPos = posOf(domKey, dom.x, dom.y);
                return (
                  <React.Fragment key={`dom-${dom.domain}`}>
                    <button
                      type="button"
                      data-mindmap-node={domKey}
                      draggable={false}
                      onClick={() => setSelection({ level: 'domain', domain: dom.domain })}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        resetNodeOffset(domKey);
                      }}
                      title="拖拽移动节点 · 双击复位位置"
                      style={{
                        left: `${domPos.x}px`,
                        top: `${domPos.y}px`,
                        width: `${dom.width}px`,
                        height: `${dom.height}px`,
                      }}
                      className={`absolute rounded-lg border px-3 py-2 text-left transition-shadow flex flex-col justify-between cursor-grab active:cursor-grabbing ${getNodeSurfaceClass(
                        dom.health,
                        isSelected
                      )}`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px] text-slate-500">
                        <span className="truncate">{dom.chapter}</span>
                        <span
                          className="shrink-0 tabular-nums text-slate-400"
                          title={`本板块共 ${dom.kpCount} 个考点`}
                        >
                          {dom.kpCount}考点
                        </span>
                      </div>
                      <div className="text-xs font-bold text-slate-900 truncate">
                        {dom.domain}
                      </div>
                      <div className="text-[11px] leading-none">
                        {dom.problemCount > 0 ? (
                          <span
                            className={`font-mono tabular-nums font-semibold ${
                              dom.health === 'critical' ? 'text-red-700' : 'text-amber-700'
                            }`}
                          >
                            {dom.problemCount}个漏洞 · -{dom.lostScore}分
                          </span>
                        ) : (
                          renderHealthTag(dom.health, 0, isCumulative)
                        )}
                      </div>
                    </button>

                    <button
                      type="button"
                      data-mindmap-toggle
                      aria-expanded={!dom.collapsed}
                      aria-label={`${dom.collapsed ? '展开' : '收起'}${dom.domain}板块`}
                      title={
                        dom.collapsed
                          ? `展开「${dom.domain}」下的 ${dom.kpCount} 个考点`
                          : `收起「${dom.domain}」下的 ${dom.kpCount} 个考点`
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDomain(dom.domain);
                      }}
                      style={{
                        left: `${domPos.x + dom.width}px`,
                        top: `${domPos.y + dom.height / 2}px`,
                      }}
                      className="absolute z-20 flex h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-xs hover:border-slate-400 hover:text-slate-900"
                    >
                      {dom.collapsed ? (
                        <ChevronRight className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                    </button>
                  </React.Fragment>
                );
              })}

              {/* L2 KnowledgePoint Nodes */}
              {layoutKpNodes.map((kpNode) => {
                const isSelected =
                  selection.level === 'kp' && selection.knowledgeId === kpNode.kp.id;
                const stateText = kpNode.mastery?.state ?? '未诊断';
                const kpKey = `kp:${kpNode.kp.id}`;
                const kpPos = posOf(kpKey, kpNode.x, kpNode.y);
                return (
                  <React.Fragment key={`kp-${kpNode.kp.id}`}>
                    <button
                      type="button"
                      data-mindmap-node={kpKey}
                      draggable={false}
                      onClick={() =>
                        setSelection({ level: 'kp', knowledgeId: kpNode.kp.id })
                      }
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        resetNodeOffset(kpKey);
                      }}
                      title="拖拽移动节点 · 双击复位位置"
                      style={{
                        left: `${kpPos.x}px`,
                        top: `${kpPos.y}px`,
                        width: `${kpNode.width}px`,
                        height: `${kpNode.height}px`,
                      }}
                      className={`absolute rounded-lg border px-3 py-2 text-left transition-shadow flex flex-col justify-between cursor-grab active:cursor-grabbing ${getNodeSurfaceClass(
                        kpNode.health,
                        isSelected
                      )}`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px]">
                        {renderHealthTag(kpNode.health, kpNode.lostScore, isCumulative)}
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                            {resolveGradeInfo(kpNode.kp.chapter).grade}
                          </span>
                          <span className="text-slate-500">{stateText}</span>
                        </div>
                      </div>
                      <div className="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug">
                        {kpNode.kp.name}
                      </div>
                    </button>

                    {kpNode.subSkillCount > 0 && (
                      <button
                        type="button"
                        data-mindmap-toggle
                        aria-expanded={!kpNode.collapsed}
                        aria-label={`${kpNode.collapsed ? '展开' : '收起'}「${
                          kpNode.kp.name
                        }」的四级子技能`}
                        title={
                          kpNode.collapsed
                            ? `展开「${kpNode.kp.name}」的 ${kpNode.subSkillCount} 条子技能`
                            : `收起「${kpNode.kp.name}」的 ${kpNode.subSkillCount} 条子技能`
                        }
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleKp(kpNode.kp.id);
                        }}
                        style={{
                          left: `${kpPos.x + kpNode.width}px`,
                          top: `${kpPos.y + kpNode.height / 2}px`,
                        }}
                        className={`absolute z-20 flex h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-xs ${
                          kpNode.collapsed
                            ? 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 hover:text-slate-900'
                            : 'border-white/80 bg-white/70 text-slate-400 hover:text-slate-700'
                        }`}
                      >
                        {kpNode.collapsed ? (
                          <ChevronRight className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </React.Fragment>
                );
              })}

              {/* L3 SubSkill Leaf Nodes */}
              {layoutKpNodes.flatMap((kpNode) =>
                kpNode.subSkillNodes.map((sk) => {
                  const isSelected =
                    selection.level === 'subskill' &&
                    selection.knowledgeId === kpNode.kp.id &&
                    selection.subSkill === sk.label;
                  const isProblem = sk.health === 'critical' || sk.health === 'warning';
                  const skKey = `sk:${sk.id}`;
                  const skPos = posOf(skKey, sk.x, sk.y);
                  return (
                    <button
                      key={sk.id}
                      type="button"
                      data-mindmap-node={skKey}
                      draggable={false}
                      onClick={() =>
                        setSelection({
                          level: 'subskill',
                          knowledgeId: kpNode.kp.id,
                          subSkill: sk.label,
                        })
                      }
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        resetNodeOffset(skKey);
                      }}
                      title="拖拽移动节点 · 双击复位位置"
                      style={{
                        left: `${skPos.x}px`,
                        top: `${skPos.y}px`,
                        width: `${sk.width}px`,
                        height: `${sk.height}px`,
                      }}
                      className={`absolute rounded-md border px-2.5 py-1 text-left transition-shadow flex items-center justify-between gap-1.5 text-[11px] cursor-grab active:cursor-grabbing ${getNodeSurfaceClass(
                        sk.health,
                        isSelected
                      )}`}
                    >
                      <span className="truncate font-medium">{sk.label}</span>
                      {isProblem && (
                        <span
                          className={`shrink-0 font-semibold ${
                            sk.health === 'critical' ? 'text-red-700' : 'text-amber-700'
                          }`}
                        >
                          ▲ 失分点
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}

          {/* 手势提示（不拦截鼠标事件） */}
          <div className="pointer-events-none absolute inset-x-3 bottom-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>拖拽空白处平移 · 拖拽节点调整位置</span>
            <span className="hidden sm:inline">双击节点/空白处复位</span>
          </div>
        </div>

        {/* Right Side Diagnostic Inspector Panel */}
        <div className="lg:col-span-4 p-5 bg-white flex flex-col justify-between space-y-5">
          {selection.level === 'root' && (
            <div className="space-y-4">
              <div>
                <div className="text-xs text-slate-500">
                  {activePaper ? `${activePaper.date} · 试卷全局映射` : `${subject} · 全科知识导图概览`}
                </div>
                <h4 className="text-base font-bold text-slate-900 mt-1">
                  {activePaper ? activePaper.title : `${gradeTitleLabel}核心知识体系`}
                </h4>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
                <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                  <div className="text-slate-500 font-sans">标记问题考点</div>
                  <div className="text-lg font-bold text-red-700 mt-0.5">
                    {mindMap.root.totalProblemKps} 个
                  </div>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                  <div className="text-slate-500 font-sans">映射失分合计</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    -{mindMap.root.totalLostScore} 分
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900">
                  点击左侧任意节点查看归因，或直达高频问题点：
                </div>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {allKpNodes
                    .filter((k) => k.health === 'critical' || k.health === 'warning')
                    .sort((a, b) => b.lostScore - a.lostScore)
                    .map((k) => (
                      <button
                        key={k.kp.id}
                        type="button"
                        onClick={() => {
                          setSelection({ level: 'kp', knowledgeId: k.kp.id });
                          revealKp(k.kp.id);
                        }}
                        className="w-full px-3 py-2.5 text-left text-xs flex items-center justify-between gap-2 hover:bg-slate-50"
                      >
                        <span className="font-medium text-slate-800 truncate">
                          {k.kp.name}
                        </span>
                        <span className="font-mono tabular-nums text-red-700 font-semibold shrink-0">
                          -{k.lostScore}分
                        </span>
                      </button>
                    ))}
                  {allKpNodes.every(
                    (k) => k.health !== 'critical' && k.health !== 'warning'
                  ) && (
                    <div className="p-3 text-xs text-slate-500">
                      当前视角下未发现待修复的失分节点。
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {selection.level === 'domain' && selectedDomainNode && (
            <div className="space-y-4">
              <div>
                <div className="text-xs text-slate-500">
                  {subject} · {selectedDomainNode.chapter}
                </div>
                <h4 className="text-base font-bold text-slate-900 mt-1">
                  {selectedDomainNode.domain} 板块
                </h4>
              </div>

              <div className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-1">
                <div className="font-semibold text-slate-900">
                  板块状态：{selectedDomainNode.problemCount} 个问题考点 · 累计失分{' '}
                  <span className="font-mono tabular-nums text-red-700">
                    -{selectedDomainNode.lostScore} 分
                  </span>
                </div>
                <div className="text-slate-600">
                  包含 {selectedDomainNode.kpCount} 个上海考纲核心知识点
                </div>
                {selectedDomainNode.collapsed && (
                  <button
                    type="button"
                    onClick={() => toggleDomain(selectedDomainNode.domain)}
                    className="mt-1 inline-flex items-center gap-1 font-medium text-blue-700 hover:text-blue-800"
                  >
                    <ChevronRight className="w-3 h-3" />
                    <span>展开该板块考点</span>
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900">下属知识点诊断：</div>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {allKpNodes
                    .filter((k) => k.kp.domain === selectedDomainNode.domain)
                    .map((k) => (
                      <button
                        key={k.kp.id}
                        type="button"
                        onClick={() => {
                          setSelection({ level: 'kp', knowledgeId: k.kp.id });
                          revealKp(k.kp.id);
                        }}
                        className="w-full p-3 border border-slate-200 rounded-lg text-left text-xs hover:bg-slate-50 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">
                            {k.kp.name}
                          </div>
                          <div className="mt-1">
                            {renderHealthTag(k.health, k.lostScore, isCumulative)}
                          </div>
                        </div>
                        <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}

          {(selection.level === 'kp' || selection.level === 'subskill') && selectedKpNode && (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="text-xs text-slate-500">
                  {selectedKpNode.kp.subject} · {selectedKpNode.kp.chapter} · {selectedKpNode.kp.domain}
                  {selection.level === 'subskill' ? ` · ${selection.subSkill}` : ''}
                </div>
                <h4 className="text-base font-bold text-slate-900">
                  {selection.level === 'subskill'
                    ? `${selectedKpNode.kp.name} → ${selection.subSkill}`
                    : selectedKpNode.kp.name}
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                  {renderHealthTag(
                    selectedKpNode.health,
                    selectedKpNode.lostScore,
                    isCumulative
                  )}
                  <span aria-hidden="true" className="text-slate-300">
                    |
                  </span>
                  <span className="text-slate-600">
                    状态机：{selectedKpNode.mastery?.state ?? '未诊断'}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    |
                  </span>
                  <span className="text-slate-600 font-mono tabular-nums">
                    权重 {selectedKpNode.kp.examWeight}x
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    |
                  </span>
                  <span className="text-slate-600 font-mono tabular-nums">
                    预估攻克 ~{selectedKpNode.kp.learningCostHours}h
                  </span>
                </div>
              </div>

              {!selectedNodeVisible && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span>
                    {selectedKpHiddenByCollapse
                      ? '该考点所在分支已收起，画布上暂未显示'
                      : '该考点不在「仅看问题分支」的筛选结果中'}
                  </span>
                  {selectedKpHiddenByCollapse ? (
                    <button
                      type="button"
                      onClick={() => revealKp(selectedKpNode.kp.id)}
                      className="shrink-0 font-medium text-blue-700 hover:text-blue-800"
                    >
                      展开并定位
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOnlyProblemBranches(false)}
                      className="shrink-0 font-medium text-blue-700 hover:text-blue-800"
                    >
                      显示全部分支
                    </button>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-100">
                {selectedKpNode.kp.definition}
              </p>

              {/* Sub-skills (分步能力细项) */}
              {selectedKpNode.kp.subSkills && selectedKpNode.kp.subSkills.length > 0 && (
                <div className="space-y-1.5 text-xs">
                  <div className="font-semibold text-slate-900 flex items-center gap-1">
                    <Target className="w-3.5 h-3.5 text-blue-600" />
                    <span>分步子能力清单（{selectedKpNode.kp.subSkills.length} 项）：</span>
                  </div>
                  <div className="space-y-1">
                    {selectedKpNode.kp.subSkills.map((sk, idx) => (
                      <div
                        key={sk}
                        className={`p-2 rounded border flex items-start gap-1.5 transition-colors ${
                          selection.level === 'subskill' && selection.subSkill === sk
                            ? 'bg-blue-50 border-blue-300 text-blue-900 font-medium'
                            : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <span className="font-mono text-slate-400 text-[10px]">
                          0{idx + 1}.
                        </span>
                        <span>{sk}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Prerequisite Risk Alert */}
              {selectedKpNode.kp.prerequisites.length > 0 && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 text-xs">
                  <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-blue-700" />
                    <span>先修依赖链追踪</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedKpNode.kp.prerequisites.map((preId) => {
                      const preKp = KNOWLEDGE_MAP[preId];
                      const preNode = allKpNodes.find((n) => n.kp.id === preId);
                      const preHasIssue =
                        preNode &&
                        (preNode.health === 'critical' || preNode.health === 'warning');
                      return (
                        <button
                          key={preId}
                          type="button"
                          onClick={() => {
                            setSelection({ level: 'kp', knowledgeId: preId });
                            revealKp(preId);
                          }}
                          className={`px-2.5 py-1 rounded border text-left transition-colors ${
                            preHasIssue
                              ? 'bg-red-50 border-red-200 text-red-800 hover:bg-red-100'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {preKp?.name ?? preId}
                          {preHasIssue ? '（前置也存漏洞）' : '（前置正常）'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Common Exam Forms */}
              {selectedKpNode.kp.commonExamForms && selectedKpNode.kp.commonExamForms.length > 0 && (
                <div className="space-y-1 text-xs">
                  <div className="font-semibold text-slate-800">常见考核题型与形式：</div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedKpNode.kp.commonExamForms.map((fmt) => (
                      <span
                        key={fmt}
                        className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]"
                      >
                        {fmt}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Matched Errors on this Paper */}
              {selectedKpNode.errors.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-900">
                    {activePaper ? '本卷' : '累计'}关联错题证据（
                    {selectedKpNode.errors.length} 道 · 共失 -{selectedKpNode.lostScore} 分）
                  </div>
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {selectedKpNode.errors.map((err) => (
                      <div
                        key={err.id}
                        className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900">
                            {err.examTitle} {err.questionNumber}
                          </span>
                          <span className="font-mono tabular-nums text-red-700 font-semibold">
                            {err.errorType} · -{err.scoreLost}分
                          </span>
                        </div>
                        <div className="text-slate-700 line-clamp-2">{err.stem}</div>
                        <div className="text-slate-500">归因：{err.aiAnalysis}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Common Traps (易错提醒独立并列展示，不再被错题遮蔽) */}
              {selectedKpNode.kp.commonTraps && selectedKpNode.kp.commonTraps.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs space-y-1 text-amber-900">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>高频易错避坑要点：</span>
                  </div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {selectedKpNode.kp.commonTraps.map((trap) => (
                      <li key={trap}>{trap}</li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={() => onLaunchCoach(selectedKpNode.kp.id)}
                className="w-full py-2.5 px-4 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <span>进入 AI 教练针对性攻克</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 text-[11px] leading-relaxed text-slate-400">
            提示：拖拽空白处平移画布，拖拽节点调整布局，双击节点复位；点击节点右侧箭头可逐项收起/展开分支，也可用顶部「全部收起 / 全部展开」。
          </div>
        </div>
      </div>
    </section>
  );
};
