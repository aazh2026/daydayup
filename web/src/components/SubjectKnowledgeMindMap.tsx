import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  GitBranch,
  Layers,
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
  onLaunchCoach,
  compactHeader = false,
}) => {
  /** 知识体系（服务端资产） */
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: SHANGHAI_CURRICULUM,
  } = useCurriculum();

  const [internalPaperId, setInternalPaperId] = useState<string>(controlledPaperId ?? 'all');
  const [onlyProblemBranches, setOnlyProblemBranches] = useState(false);
  const [showSubSkills, setShowSubSkills] = useState(true);
  const [zoom, setZoom] = useState<number>(1);
  const [selection, setSelection] = useState<SelectedSelection>({ level: 'root' });

  const effectivePaperId = controlledPaperId ?? internalPaperId;
  const setPaperId = (id: string) => {
    if (onSelectPaperId) {
      onSelectPaperId(id);
    } else {
      setInternalPaperId(id);
    }
  };

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
    const subjectKps = SHANGHAI_CURRICULUM.filter((k) => k.subject === subject);
    const domainMap = new Map<string, KnowledgePoint[]>();
    for (const kp of subjectKps) {
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

    const rawDomains: Array<{
      domain: string;
      chapter: string;
      kpItems: Array<{
        kp: KnowledgePoint;
        health: NodeHealth;
        lostScore: number;
        errors: ErrorRecord[];
        unresolvedCount: number;
        mastery?: MasteryRecord;
        subSkills: Array<{ label: string; health: NodeHealth; matchedErrorCount: number }>;
      }>;
    }> = [];

    for (const [domain, kps] of domainMap.entries()) {
      const kpItems = kps
        .map((kp) => {
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
            if (unresolvedCount > 0 && (lostScore >= 4 || errs.length >= 2 || mastery?.state === '待学习')) {
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
              skHealth = skUnresolved && (skLost >= 4 || health === 'critical') ? 'critical' : 'warning';
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
        })
        .filter((item) =>
          onlyProblemBranches
            ? item.health === 'critical' || item.health === 'warning'
            : true
        );

      if (kpItems.length > 0) {
        rawDomains.push({
          domain,
          chapter: kps[0]?.chapter ?? domain,
          kpItems,
        });
      }
    }

    // Compute Y positions bottom-up
    const TOP_PAD = 24;
    const SUBSKILL_STEP = 44;
    const KP_MIN_SLOT = 92;
    const KP_GAP = 14;
    const DOMAIN_GAP = 22;

    let cursorY = TOP_PAD;
    const domainNodes: DomainNodeData[] = [];

    for (const dom of rawDomains) {
      const domStartY = cursorY;
      const kpNodes: KpNodeData[] = [];

      for (let ki = 0; ki < dom.kpItems.length; ki++) {
        const item = dom.kpItems[ki];
        const subCount = showSubSkills ? item.subSkills.length : 0;
        const slotHeight = showSubSkills
          ? Math.max(KP_MIN_SLOT, subCount * SUBSKILL_STEP)
          : KP_MIN_SLOT;

        const kpStartY = cursorY;
        const subSkillNodes: SubSkillNodeData[] = [];

        if (showSubSkills) {
          const totalSubH = subCount * L3_H + Math.max(0, subCount - 1) * (SUBSKILL_STEP - L3_H);
          const subOffsetY = kpStartY + Math.max(0, (slotHeight - totalSubH) / 2);
          item.subSkills.forEach((sk, si) => {
            subSkillNodes.push({
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

        const kpCenterY = kpStartY + slotHeight / 2;
        kpNodes.push({
          kp: item.kp,
          health: item.health,
          lostScore: item.lostScore,
          errors: item.errors,
          unresolvedCount: item.unresolvedCount,
          mastery: item.mastery,
          subSkillNodes,
          x: L2_X,
          y: kpCenterY - L2_H / 2,
          width: L2_W,
          height: L2_H,
        });

        cursorY += slotHeight + (ki < dom.kpItems.length - 1 ? KP_GAP : 0);
      }

      const domEndY = cursorY;
      const domCenterY = (domStartY + domEndY) / 2;

      const problemCount = kpNodes.filter(
        (k) => k.health === 'critical' || k.health === 'warning'
      ).length;
      const domLostScore = kpNodes.reduce((s, k) => s + k.lostScore, 0);
      const hasCritical = kpNodes.some((k) => k.health === 'critical');
      const hasWarning = kpNodes.some((k) => k.health === 'warning');
      const allMastered =
        kpNodes.length > 0 && kpNodes.every((k) => k.health === 'mastered');

      const domHealth: NodeHealth = hasCritical
        ? 'critical'
        : hasWarning
        ? 'warning'
        : allMastered
        ? 'mastered'
        : 'neutral';

      domainNodes.push({
        domain: dom.domain,
        chapter: dom.chapter,
        health: domHealth,
        problemCount,
        lostScore: domLostScore,
        kpNodes,
        x: L1_X,
        y: domCenterY - L1_H / 2,
        width: L1_W,
        height: L1_H,
      });

      cursorY += DOMAIN_GAP;
    }

    const totalHeight = Math.max(260, cursorY + 12);
    const totalWidth = showSubSkills ? L3_X + L3_W + 24 : L2_X + L2_W + 24;

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
      : domainNodes.every((d) => d.health === 'mastered')
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
    };
  }, [
    subject,
    scopedErrors,
    masteryRecords,
    activePaper,
    paperKnowledgeSet,
    onlyProblemBranches,
    showSubSkills,
  ]);

  // Reset or auto-focus selection on first problem node when subject or paper changes
  useEffect(() => {
    const firstProblemKp = mindMap.domainNodes
      .flatMap((d) => d.kpNodes)
      .find((k) => k.health === 'critical' || k.health === 'warning');
    if (firstProblemKp) {
      setSelection({ level: 'kp', knowledgeId: firstProblemKp.kp.id });
    } else {
      setSelection({ level: 'root' });
    }
  }, [subject, effectivePaperId]);

  const allKpNodes = useMemo(
    () => mindMap.domainNodes.flatMap((d) => d.kpNodes),
    [mindMap]
  );

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

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Toolbar Header */}
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="w-4 h-4 text-blue-700 shrink-0" />
            <h3 className="text-base font-semibold text-slate-900">
              {compactHeader
                ? `${subject}学科知识思维导图 · 本卷问题点定位`
                : `初三${subject}学科知识思维导图 · 试卷问题点标记`}
            </h3>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            将试卷失分题与细粒度子技能直接映射至学科知识树，红色/琥珀色分支高亮标注失分漏洞与前置依赖风险
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
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

          <button
            type="button"
            onClick={() => setShowSubSkills((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              showSubSkills
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {showSubSkills ? '隐藏四级子技能' : '展开四级子技能'}
          </button>

          <div className="inline-flex items-center border border-slate-200 rounded-lg bg-white">
            <button
              type="button"
              aria-label="缩小思维导图"
              onClick={() => setZoom((z) => Math.max(0.75, Number((z - 0.1).toFixed(2))))}
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
              onClick={() => setZoom((z) => Math.min(1.2, Number((z + 0.1).toFixed(2))))}
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
          className="lg:col-span-8 border-b lg:border-b-0 lg:border-r border-slate-200 overflow-x-auto bg-slate-50/60"
          style={{
            backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)',
            backgroundSize: '18px 18px',
          }}
        >
          {mindMap.domainNodes.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <div className="text-sm font-medium text-slate-800">
                当前筛选试卷在「{subject}」知识思维导图上未标出未解决的问题点
              </div>
              <p className="text-xs text-slate-500">
                可关闭「仅看问题分支」查看完整的初三{subject}知识结构树，或切换至其他历史试卷对比。
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
              className="relative"
              style={{
                width: `${mindMap.width * zoom}px`,
                height: `${mindMap.height * zoom}px`,
                minHeight: '320px',
              }}
            >
              <div
                className="relative origin-top-left"
                style={{
                  width: `${mindMap.width}px`,
                  height: `${mindMap.height}px`,
                  transform: `scale(${zoom})`,
                }}
              >
                {/* SVG Cubic Bezier Branch Layer */}
                <svg
                  width={mindMap.width}
                  height={mindMap.height}
                  className="absolute inset-0 pointer-events-none"
                >
                  {mindMap.domainNodes.map((dom) => {
                    const domEdge = getEdgeStroke(dom.health);
                    const x1 = mindMap.root.x + mindMap.root.width;
                    const y1 = mindMap.root.y + mindMap.root.height / 2;
                    const x2 = dom.x;
                    const y2 = dom.y + dom.height / 2;
                    const cx = (x1 + x2) / 2;

                    return (
                      <g key={`edge-group-${dom.domain}`}>
                        <path
                          d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={domEdge.stroke}
                          strokeWidth={domEdge.width}
                          strokeDasharray={domEdge.dashed ? '4 4' : undefined}
                        />
                        {dom.kpNodes.map((kpNode) => {
                          const kpEdge = getEdgeStroke(kpNode.health);
                          const kx1 = dom.x + dom.width;
                          const ky1 = dom.y + dom.height / 2;
                          const kx2 = kpNode.x;
                          const ky2 = kpNode.y + kpNode.height / 2;
                          const kcx = (kx1 + kx2) / 2;
                          const isKpSelected =
                            (selection.level === 'kp' || selection.level === 'subskill') &&
                            selection.knowledgeId === kpNode.kp.id;

                          return (
                            <g key={`edge-kp-${kpNode.kp.id}`}>
                              <path
                                d={`M ${kx1} ${ky1} C ${kcx} ${ky1}, ${kcx} ${ky2}, ${kx2} ${ky2}`}
                                fill="none"
                                stroke={kpEdge.stroke}
                                strokeWidth={isKpSelected ? kpEdge.width + 1 : kpEdge.width}
                                strokeDasharray={kpEdge.dashed ? '4 4' : undefined}
                              />
                              {kpNode.subSkillNodes.map((sk) => {
                                const skEdge = getEdgeStroke(sk.health);
                                const sx1 = kpNode.x + kpNode.width;
                                const sy1 = kpNode.y + kpNode.height / 2;
                                const sx2 = sk.x;
                                const sy2 = sk.y + sk.height / 2;
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
                  onClick={() => setSelection({ level: 'root' })}
                  style={{
                    left: `${mindMap.root.x}px`,
                    top: `${mindMap.root.y}px`,
                    width: `${mindMap.root.width}px`,
                    height: `${mindMap.root.height}px`,
                  }}
                  className={`absolute rounded-xl border p-3 text-left transition-shadow shadow-xs flex flex-col justify-between ${getNodeSurfaceClass(
                    mindMap.root.health,
                    selection.level === 'root'
                  )}`}
                >
                  <div className="text-[11px] font-medium text-slate-500 truncate">
                    {activePaper ? activePaper.title : '上海初三中考考纲'}
                  </div>
                  <div className="text-sm font-bold text-slate-900">
                    初三{subject}知识树
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
                  return (
                    <button
                      key={`dom-${dom.domain}`}
                      type="button"
                      onClick={() => setSelection({ level: 'domain', domain: dom.domain })}
                      style={{
                        left: `${dom.x}px`,
                        top: `${dom.y}px`,
                        width: `${dom.width}px`,
                        height: `${dom.height}px`,
                      }}
                      className={`absolute rounded-lg border px-3 py-2 text-left transition-shadow flex flex-col justify-between ${getNodeSurfaceClass(
                        dom.health,
                        isSelected
                      )}`}
                    >
                      <div className="text-[11px] text-slate-500 truncate">{dom.chapter}</div>
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
                  );
                })}

                {/* L2 KnowledgePoint Nodes */}
                {allKpNodes.map((kpNode) => {
                  const isSelected =
                    selection.level === 'kp' && selection.knowledgeId === kpNode.kp.id;
                  const stateText = kpNode.mastery?.state ?? '未诊断';
                  return (
                    <button
                      key={`kp-${kpNode.kp.id}`}
                      type="button"
                      onClick={() =>
                        setSelection({ level: 'kp', knowledgeId: kpNode.kp.id })
                      }
                      style={{
                        left: `${kpNode.x}px`,
                        top: `${kpNode.y}px`,
                        width: `${kpNode.width}px`,
                        height: `${kpNode.height}px`,
                      }}
                      className={`absolute rounded-lg border px-3 py-2 text-left transition-shadow flex flex-col justify-between ${getNodeSurfaceClass(
                        kpNode.health,
                        isSelected
                      )}`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px]">
                        {renderHealthTag(kpNode.health, kpNode.lostScore, isCumulative)}
                        <span className="text-slate-500 shrink-0">{stateText}</span>
                      </div>
                      <div className="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug">
                        {kpNode.kp.name}
                      </div>
                    </button>
                  );
                })}

                {/* L3 SubSkill Leaf Nodes */}
                {showSubSkills &&
                  allKpNodes.flatMap((kpNode) =>
                    kpNode.subSkillNodes.map((sk) => {
                      const isSelected =
                        selection.level === 'subskill' &&
                        selection.knowledgeId === kpNode.kp.id &&
                        selection.subSkill === sk.label;
                      const isProblem = sk.health === 'critical' || sk.health === 'warning';
                      return (
                        <button
                          key={sk.id}
                          type="button"
                          onClick={() =>
                            setSelection({
                              level: 'subskill',
                              knowledgeId: kpNode.kp.id,
                              subSkill: sk.label,
                            })
                          }
                          style={{
                            left: `${sk.x}px`,
                            top: `${sk.y}px`,
                            width: `${sk.width}px`,
                            height: `${sk.height}px`,
                          }}
                          className={`absolute rounded-md border px-2.5 py-1 text-left transition-shadow flex items-center justify-between gap-1.5 text-[11px] ${getNodeSurfaceClass(
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
            </div>
          )}
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
                  {activePaper ? activePaper.title : `初三${subject}核心知识体系`}
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
                        onClick={() => setSelection({ level: 'kp', knowledgeId: k.kp.id })}
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
                  包含 {selectedDomainNode.kpNodes.length} 个上海考纲核心知识点
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900">下属知识点诊断：</div>
                <div className="space-y-2">
                  {selectedDomainNode.kpNodes.map((k) => (
                    <button
                      key={k.kp.id}
                      type="button"
                      onClick={() => setSelection({ level: 'kp', knowledgeId: k.kp.id })}
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
                  {selectedKpNode.kp.subject} · {selectedKpNode.kp.domain}
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
                    考纲权重 {selectedKpNode.kp.examWeight}x
                  </span>
                </div>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                {selectedKpNode.kp.definition}
              </p>

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
                          onClick={() =>
                            setSelection({ level: 'kp', knowledgeId: preId })
                          }
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

              {/* Matched Errors on this Paper */}
              {selectedKpNode.errors.length > 0 ? (
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
              ) : (
                <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-1">
                  <div className="font-semibold text-slate-900">高频易错提醒：</div>
                  <ul className="list-disc list-inside text-slate-600 space-y-0.5">
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

          <div className="pt-3 border-t border-slate-100 text-[11px] text-slate-400">
            提示：点击任意板块、考点或四级子技能节点，可穿透查看试卷失分证据与前置知识依赖。
          </div>
        </div>
      </div>
    </section>
  );
};
