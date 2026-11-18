/**
 * PrerequisiteEngine —— 先修关系图引擎（服务端权威）。
 *
 * ── 为什么需要这个引擎 ────────────────────────────────────────────────
 *
 * 提分优先级计算（`planning-engine.ts`）只看**直接先修**：
 * `kp.prerequisites` 里有一个处于「未诊断/待学习」就降权。
 *
 * 但真实的学习阻断是**传递的**：
 * 初三的「二次函数综合」依赖「一次函数」，「一次函数」依赖「分式与代数式运算」，
 * 而后者依赖「有理数运算」。学生不会「一次函数」时，
 * 真正该先补的是最底层的那个点，而不是「一次函数」本身。
 *
 * 这正是 cn-math-taxonomy 的 `diagnose/engine.js` 解决的核心问题
 * ——「答错初中题会一路问到小学」。
 *
 * 本引擎提供：
 * - **祖先闭包**：某知识点的全部先修（含间接），按拓扑序（先修在前）
 * - **传递阻断链**：从目标出发，逐层找到真正未掌握的根节点
 * - **学习路径**：按年级从低到高排列的补强顺序
 * - **拓扑序**：稳定的、可复现的排序
 *
 * ── 设计约束 ──────────────────────────────────────────────────────────
 *
 * 1. **纯函数**：无 IO、无时钟读取。全部输入显式传入。
 * 2. **只读 hard 先修**：cn-mt 的先修边分 hard/soft。
 *    soft 是「时间顺序/主题相关」（如「数学游戏分享」在「0~5 认识」之后），
 *    **不代表「不掌握就学不了」**。把 soft 当成阻断会让路径图爆炸。
 *    转换器默认只导入 hard 边，本引擎按现有资产执行。
 * 3. **环安全**：先修图理论上无环（转换器已校验），但引擎必须对
 *    脏数据免疫 —— 用 visited 集合而非纯递归深度限制。
 * 4. **确定性**：同一输入必然同一输出（拓扑序用 id 作为稳定 tiebreaker）。
 */
import type { MasteryRecord, MasteryState } from '@daydayup/contracts';
import { getKnowledgeMap } from '../infrastructure/knowledge/curriculum.ts';

/** 判定「未掌握」的状态 —— 这些状态会阻断后续知识点 */
export const BLOCKING_STATES: MasteryState[] = ['未诊断', '待学习', '学习中'];

/** 判定「已掌握」的状态 */
export const MASTERED_STATES: MasteryState[] = ['初步掌握', '掌握', '稳定掌握'];

/**
 * 判定一个节点对初三中考学生是否构成实质性阻断。
 *
 * 核心规则：
 * 1. 处于已掌握状态（初步掌握/掌握/稳定掌握）不阻断；
 * 2. 小学阶段先修知识点（带 _p 或小学年级章节）：
 *    初三中考备考默认假设其基础基线达标；
 *    仅当该小学知识点有明确负面记录（已诊断为待学习/学习中，或存在失分证据）时才视为阻断；
 *    无任何记录的“未诊断”小学知识点不予作为阻断根因，避免出现“1到5各数的认识阻断初三压轴题”的噪声。
 * 3. 初中及以上阶段先修知识点：未诊断/待学习/学习中均视为阻断。
 */
export function isNodeBlocking(
  node: PrerequisiteNode,
  masteryRecords: Record<string, MasteryRecord> = {},
  targetId?: string,
  graph?: PrerequisiteGraph
): boolean {
  if (!BLOCKING_STATES.includes(node.state)) return false;

  const resolved = resolveGraph(graph);
  const targetNode = targetId ? resolved[targetId] : undefined;
  const isPrimaryTarget = targetNode
    ? targetNode.id.includes('_p') ||
      /cn._p/.test(targetNode.id) ||
      /一年级|二年级|三年级|四年级|五年级|六年级/.test(targetNode.chapter ?? '')
    : false;

  const isPrimaryNode =
    node.knowledgeId.includes('_p') ||
    /cn._p/.test(node.knowledgeId) ||
    /一年级|二年级|三年级|四年级|五年级|六年级/.test(node.chapter ?? '');

  // 只有当目标是非小学点（初三中考考点），且该先修是跨学段的小学点时，
  // 若无明确失分证据，才默认基线通过；如果目标本身就是小学点，则正常判定阻断
  if (!isPrimaryTarget && isPrimaryNode) {
    const rec = masteryRecords[node.knowledgeId];
    if (!rec) return false;
    if (rec.state === '未诊断' && (rec.lostScoreEvidence ?? 0) === 0) return false;
  }

  return true;
}

/**
 * 先修图的注入点。
 *
 * 生产环境用 `getKnowledgeMap()`（服务端唯一事实源）；
 * 测试可注入**受控的小图**，从而断言传递性、根因、拓扑序等
 * 语义而不用依赖真实资产的形状 —— 否则测试会随资产版本漂移。
 */
export type PrerequisiteGraph = Record<
  string,
  {
    id: string;
    name: string;
    subject: string;
    chapter: string;
    domain: string;
    prerequisites: string[];
  }
>;

/** 解析实际使用的图：显式传入优先，否则用服务端资产 */
function resolveGraph(graph?: PrerequisiteGraph): PrerequisiteGraph {
  return graph ?? (getKnowledgeMap() as unknown as PrerequisiteGraph);
}

export interface PrerequisiteNode {
  knowledgeId: string;
  name: string;
  subject: string;
  chapter: string;
  domain: string;
  /** 到目标点的距离（0 = 目标本身，1 = 直接先修，2 = 二级先修……） */
  distance: number;
  /** 该点的掌握状态；无 MasteryRecord 视为「未诊断」 */
  state: MasteryState;
  /** 是否存在 MasteryRecord（false = 从未诊断） */
  diagnosed: boolean;
  /** 是否阻断（未掌握且是目标的先修链上的一环） */
  blocking: boolean;
  /** 该点的先修（直接） */
  prerequisites: string[];
}

export interface BlockingChain {
  /** 目标知识点 */
  targetId: string;
  targetName: string;
  /** 真正的根因知识点（最底层未掌握点）—— 可能不止一个 */
  rootCauses: Array<{
    knowledgeId: string;
    name: string;
    subject: string;
    state: MasteryState;
    /** 沿先修链到目标的路径（含两端） */
    path: string[];
    /** 路径深度 */
    depth: number;
  }>;
  /** 从根因到目标的完整学习路径（按年级/拓扑序从低到高） */
  learningPath: PrerequisiteNode[];
  /** 是否存在阻断 */
  hasBlocking: boolean;
}

/**
 * 读取某知识点的掌握状态。
 *
 * **没有 MasteryRecord 等于「未诊断」** —— 这是规格语义：
 * 「未诊断：尚无近期考试或微测证据」。
 */
export function resolveState(
  masteryRecords: Record<string, MasteryRecord>,
  knowledgeId: string
): { state: MasteryState; diagnosed: boolean } {
  const rec = masteryRecords[knowledgeId];
  if (!rec) return { state: '未诊断', diagnosed: false };
  return { state: rec.state, diagnosed: true };
}

/**
 * 计算某知识点的**全部祖先**（所有先修，含间接）。
 *
 * @param knowledgeId 目标知识点
 * @param masteryRecords 掌握度记录
 * @returns 祖先节点列表，按**拓扑序**（先修在前，越基础越靠前）
 */
export function collectAncestors(
  knowledgeId: string,
  masteryRecords: Record<string, MasteryRecord> = {},
  graph?: PrerequisiteGraph
): PrerequisiteNode[] {
  const knowledgeMap = resolveGraph(graph);

  // BFS 分层：distance = 到目标的最短先修距离
  const distance = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [knowledgeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const kp = knowledgeMap[current];
    if (!kp) continue;

    for (const preId of kp.prerequisites) {
      if (visited.has(preId)) continue;
      if (!distance.has(preId)) {
        distance.set(preId, (distance.get(current) ?? 0) + 1);
      }
      queue.push(preId);
    }
  }

  // 目标自身 distance = 0
  distance.set(knowledgeId, 0);

  const nodes: PrerequisiteNode[] = [];
  for (const id of visited) {
    const kp = knowledgeMap[id];
    if (!kp) continue;
    const { state, diagnosed } = resolveState(masteryRecords, id);
    nodes.push({
      knowledgeId: id,
      name: kp.name,
      subject: kp.subject,
      chapter: kp.chapter,
      domain: kp.domain,
      distance: distance.get(id) ?? 0,
      state,
      diagnosed,
      blocking: false,
      prerequisites: kp.prerequisites,
    });
  }

  return topologicalSort(nodes, knowledgeMap);
}

/**
 * 稳定拓扑排序：先修在前，同层按 id 字典序。
 *
 * 为什么需要稳定 tiebreaker：拓扑排序本身不唯一，
 * 若 tiebreaker 不固定，同一份数据两次生成的计划顺序可能不同，
 * 用户会看到「计划自己变了」。用 id 字典序保证可复现。
 */
function topologicalSort(
  nodes: PrerequisiteNode[],
  _knowledgeMap: PrerequisiteGraph
): PrerequisiteNode[] {
  const nodeIds = new Set(nodes.map((n) => n.knowledgeId));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const n of nodes) {
    // 只统计落在本节点集合内的先修（外部先修不参与本子图的拓扑约束）
    const deps = n.prerequisites.filter((p) => nodeIds.has(p));
    inDegree.set(n.knowledgeId, deps.length);
    for (const d of deps) {
      const list = dependents.get(d) ?? [];
      list.push(n.knowledgeId);
      dependents.set(d, list);
    }
  }

  const ready: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id);
  }
  ready.sort();

  const sorted: PrerequisiteNode[] = [];
  const byId = new Map(nodes.map((n) => [n.knowledgeId, n]));

  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = byId.get(id);
    if (node) sorted.push(node);

    for (const dep of (dependents.get(id) ?? []).sort()) {
      const remaining = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, remaining);
      if (remaining === 0) {
        // 插入有序位置，保持 ready 队列有序
        const idx = ready.findIndex((x) => x > dep);
        if (idx === -1) ready.push(dep);
        else ready.splice(idx, 0, dep);
      }
    }
  }

  // 环保护：若因环导致部分节点未进入结果，补在末尾（并标记）
  if (sorted.length < nodes.length) {
    const placed = new Set(sorted.map((n) => n.knowledgeId));
    for (const n of nodes) {
      if (!placed.has(n.knowledgeId)) sorted.push(n);
    }
  }

  return sorted;
}

/**
 * 找出目标知识点真正的**阻断根因**。
 *
 * 算法（对应 cn-mt 的「根因」定义）：
 * 1. 收集目标的全部祖先
 * 2. 找出其中未掌握（未诊断/待学习/学习中）的节点
 * 3. 一个未掌握节点若是「根因」，当且仅当**它的直接先修都已掌握**
 *    —— 即它自己就是最底层的缺口
 * 4. 若某个根因的先修里还有未掌握的（不是根因），说明真正的根因更靠前
 *
 * @returns 根因列表 + 学习路径
 */
export function analyzeBlockingChain(
  knowledgeId: string,
  masteryRecords: Record<string, MasteryRecord> = {},
  graph?: PrerequisiteGraph
): BlockingChain {
  const knowledgeMap = resolveGraph(graph);
  const target = knowledgeMap[knowledgeId];

  if (!target) {
    return {
      targetId: knowledgeId,
      targetName: knowledgeId,
      rootCauses: [],
      learningPath: [],
      hasBlocking: false,
    };
  }

  const ancestors = collectAncestors(knowledgeId, masteryRecords, knowledgeMap);
  const ancestorIds = new Set(ancestors.map((n) => n.knowledgeId));

  // 标记阻断节点（初三备考上下文：小学未失分基础点不造成阻断）
  for (const node of ancestors) {
    node.blocking = isNodeBlocking(node, masteryRecords, knowledgeId, knowledgeMap);
  }

  // 找根因：未掌握，且（它在本子图内的）直接先修都已掌握
  const rootCauses: BlockingChain['rootCauses'] = [];

  for (const node of ancestors) {
    if (!node.blocking) continue;
    if (node.knowledgeId === knowledgeId) continue; // 目标自身不算根因

    const deps = node.prerequisites.filter((d) => ancestorIds.has(d));
    const depsAllMastered = deps.every((d) => {
      const depNode = ancestors.find((n) => n.knowledgeId === d);
      return depNode ? !depNode.blocking : true;
    });

    if (depsAllMastered) {
      rootCauses.push({
        knowledgeId: node.knowledgeId,
        name: node.name,
        subject: node.subject,
        state: node.state,
        path: findPath(ancestors, node.knowledgeId, knowledgeId),
        depth: node.distance,
      });
    }
  }

  // 学习路径：从根因出发，沿「被依赖」方向（先修 → 学习者）可达的节点，
  // 去掉已掌握的，按拓扑序排列（先修在前 = 从低到高）
  const rootIds = new Set(rootCauses.map((r) => r.knowledgeId));
  const pathNodes = ancestors.filter((n) => {
    if (rootIds.has(n.knowledgeId)) return true;
    // 在根因到目标的路径上
    return rootCauses.some((r) => r.path.includes(n.knowledgeId));
  });

  // 当目标节点自身未掌握且有阻断或待学时，确保其包含在学习路径末尾（distance 0）
  const targetNode = ancestors.find((n) => n.knowledgeId === knowledgeId);
  const targetNeedsLearning = targetNode && !MASTERED_STATES.includes(targetNode.state);
  if (
    (rootCauses.length > 0 || targetNeedsLearning) &&
    !pathNodes.some((n) => n.knowledgeId === knowledgeId)
  ) {
    if (targetNode) pathNodes.push(targetNode);
  }

  return {
    targetId: knowledgeId,
    targetName: target.name,
    rootCauses,
    learningPath: pathNodes,
    hasBlocking: rootCauses.length > 0,
  };
}

/**
 * 找到 from → to 的先修路径（含两端）。
 *
 * 用 BFS 保证找到**最短**路径（最直接的因果链）。
 */
function findPath(
  ancestors: PrerequisiteNode[],
  from: string,
  to: string
): string[] {
  if (from === to) return [from];

  // 反向邻接：pre → dependents
  const dependents = new Map<string, string[]>();
  for (const n of ancestors) {
    for (const p of n.prerequisites) {
      if (!ancestors.some((a) => a.knowledgeId === p)) continue;
      const list = dependents.get(p) ?? [];
      list.push(n.knowledgeId);
      dependents.set(p, list);
    }
  }

  const queue: string[][] = [[from]];
  const visited = new Set([from]);

  while (queue.length > 0) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    if (last === to) return path;

    for (const next of (dependents.get(last) ?? []).sort()) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }

  return [from];
}

/**
 * 批量分析：找出学生当前**所有**被阻断的知识点及其根因。
 *
 * 用于「诊断 → 提分规划」的全局视图：
 * 哪些目标被阻、被什么阻、真正的根因在哪。
 */
export interface BlockingSummary {
  /** 被阻断的目标知识点 */
  blockedTargets: Array<{
    knowledgeId: string;
    name: string;
    subject: string;
    /** 根因知识点 */
    rootCauseId: string;
    rootCauseName: string;
    rootCauseState: MasteryState;
    /** 根因到目标的距离 */
    depth: number;
  }>;
  /** 去重后的根因知识点（按被阻断目标数排序） */
  rootCauses: Array<{
    knowledgeId: string;
    name: string;
    subject: string;
    state: MasteryState;
    /** 阻断了多少个目标 */
    blockingCount: number;
  }>;
  /** 统计 */
  stats: {
    totalKnowledgePoints: number;
    diagnosedCount: number;
    blockedTargetCount: number;
    rootCauseCount: number;
    /** 最深的一条阻断链（跨越多少学段） */
    maxDepth: number;
  };
}

/**
 * 批量分析全量知识点的阻断情况。
 *
 * @param masteryRecords 掌握度记录
 * @param limit 只分析前 N 个目标（大资产下控制耗时）
 * @param graph 可注入的图（默认用服务端资产）
 */
export function analyzeAllBlocking(
  masteryRecords: Record<string, MasteryRecord> = {},
  limit?: number,
  graph?: PrerequisiteGraph
): BlockingSummary {
  const resolved = resolveGraph(graph);
  const all = Object.values(resolved);
  const targets = limit ? all.slice(0, limit) : all;

  const blockedTargets: BlockingSummary['blockedTargets'] = [];
  const rootCauseCounts = new Map<string, BlockingSummary['rootCauses'][number]>();
  let maxDepth = 0;
  let diagnosedCount = 0;

  for (const kp of all) {
    if (masteryRecords[kp.id]) diagnosedCount++;
  }

  for (const kp of targets) {
    const chain = analyzeBlockingChain(kp.id, masteryRecords, resolved);
    if (!chain.hasBlocking) continue;

    for (const root of chain.rootCauses) {
      blockedTargets.push({
        knowledgeId: kp.id,
        name: kp.name,
        subject: kp.subject,
        rootCauseId: root.knowledgeId,
        rootCauseName: root.name,
        rootCauseState: root.state,
        depth: root.depth,
      });

      const existing = rootCauseCounts.get(root.knowledgeId);
      if (existing) {
        existing.blockingCount++;
      } else {
        rootCauseCounts.set(root.knowledgeId, {
          knowledgeId: root.knowledgeId,
          name: root.name,
          subject: root.subject,
          state: root.state,
          blockingCount: 1,
        });
      }

      if (root.depth > maxDepth) maxDepth = root.depth;
    }
  }

  const rootCauses = [...rootCauseCounts.values()].sort(
    (a, b) => b.blockingCount - a.blockingCount || a.knowledgeId.localeCompare(b.knowledgeId)
  );

  return {
    blockedTargets,
    rootCauses,
    stats: {
      totalKnowledgePoints: all.length,
      diagnosedCount,
      blockedTargetCount: new Set(blockedTargets.map((b) => b.knowledgeId)).size,
      rootCauseCount: rootCauses.length,
      maxDepth,
    },
  };
}
