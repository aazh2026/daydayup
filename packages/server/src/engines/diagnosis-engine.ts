/**
 * 三态自适应诊断引擎（服务端权威）。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────
 *
 * 原来的诊断是「一次考试 → 一批知识点 → 逐个打分」：
 * 判对错的能力有了，但**判「到底会不会」的能力**没有。
 *
 * 具体表现：一个学生某次考试「方程应用题」错了，
 * 系统只能说他这个点不会 —— 但他可能是不会解方程（先修没过关），
 * 也可能是会解方程、只是不会建模（这个点不稳）。
 * 这两种情况的补法完全不同：
 * 前者要回退先修，后者只要多练这个点本身。
 *
 * ── 三态 ──────────────────────────────────────────────────────────────
 *
 * | 状态 | 含义 | 触发条件 | 后续动作 |
 * |---|---|---|---|
 * | `mastered` 掌握 | 真的会 | 连续答对满 `confirm` 题且从未错过 | 推断尚未判定的祖先也掌握（沿先修图） |
 * | `shaky` 不稳 | 会但不稳 | 错过之后又答对了 | **不回溯**先修，但进学习路径 |
 * | `weak` 薄弱 | 不会 | 确认题也错 / 题量用完 | 回溯先修（hard 先 soft 后），压到出题栈顶 |
 *
 * 「不稳」这个中间态是整套设计的关键：
 * 没有它，「错一次」和「完全不会」会混为一谈，
 * 导致系统对每个错题都回退到最底层先修，排出来的计划全是「从头学」，
 * 学生看到的是一份毫无针对性的学习清单。
 *
 * ── 与项目资产的关系 ──────────────────────────────────────────────────
 *
 * - 知识点图谱来自**项目原生知识资产**（`getKnowledgeMap()`），
 *   先修关系取 `prerequisites`；
 * - 题目来自**项目题库**（`getQuestionBank()`），
 *   难度由 `level` 映射（基础题→basic / 变式题→standard / 迁移题→challenge）；
 * - 一切 id 都是项目原生 id，外部 id 只能先经 `id-aliases.ts` 解析。
 *
 * ── 确定性 ────────────────────────────────────────────────────────────
 *
 * 选题用 `mulberry32` 伪随机（种子 = seed + 知识点 + 第几次作答），
 * 同一 seed 下**同一会话必然出同一批题**，
 * 因此断点续答 / 撤销 / 服务重启后都能 `replay()` 重建同一状态。
 */

/** 题目难度档（与题库 level 的映射结果） */
export type DifficultyTier = 'basic' | 'standard' | 'challenge';

export interface DiagnosticQuestion {
  id: string;
  knowledgeId: string;
  difficulty: DifficultyTier;
  questionType: string;
  stem: string;
  standardAnswer: string;
  level: string;
  /**
   * 选择题选项（可选）。
   *
   * 前端渲染自适应诊断时需要选项才能给出可点击的选项卡；
   * 没有选项的题（填空 / 解答）前端退化为文本输入。
   */
  options?: string[];
}

export interface DiagnosticNode {
  id: string;
  name: string;
  subject: string;
  /** 先修：hard = 必须先会，soft = 建议先会 */
  prerequisites: Array<{ id: string; strength: 'hard' | 'soft' }>;
}

export interface DiagnosticGraph {
  nodes: Record<string, DiagnosticNode>;
  /** 题目按知识点归集 */
  bank: Record<string, DiagnosticQuestion[]>;
  /** 拓扑序（先修在前） */
  order: string[];
}

export type DiagnosticStatus = 'mastered' | 'shaky' | 'weak' | 'unknown';

export interface DiagnosticSession {
  targets: string[];
  limit: number;
  confirm: number;
  mode: 'target' | 'screen';
  /** 出题栈：栈顶优先出题 */
  stack: string[];
  status: Record<string, { s: DiagnosticStatus; src: 'direct' | 'inferred' }>;
  /** 每个知识点的作答记录 */
  attempts: Record<string, Array<{ qid: string | null; result: AnswerResult }>>;
  answers: DiagnosticAnswerRecord[];
  seed: string;
  /** 已出过的题 id（会话内不再重复） */
  asked: Record<string, string[]>;
}

export type AnswerResult = 'correct' | 'wrong' | 'skip';

export interface DiagnosticAnswerRecord {
  knowledgeId: string;
  qid: string | null;
  result: AnswerResult;
  text?: string;
  at: string;
}

/** 判「掌握」所需的连续答对题数（可选值） */
export const CONFIRM_CHOICES = [2, 3, 5] as const;
export const DEFAULT_CONFIRM = 3;
export const DEFAULT_LIMIT = 24;
export const SCREEN_LIMIT = 12;

const DIFF_RANK: Record<DifficultyTier, number> = {
  basic: 0,
  standard: 1,
  challenge: 2,
};

/** 题库 level → 难度档 */
export function levelToDifficulty(level: string): DifficultyTier {
  if (level.includes('迁移')) return 'challenge';
  if (level.includes('变式')) return 'standard';
  return 'basic';
}

// ---------------------------------------------------------------- 伪随机

function hashStr(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand01(seed: string, key: string): number {
  const f = mulberry32(hashStr(`${seed}|${key}`));
  f();
  return f();
}

// ---------------------------------------------------------------- 图构建

export interface GraphInput {
  /** 项目原生知识点：id / name / subject / prerequisites */
  knowledgePoints: Array<{
    id: string;
    name: string;
    subject: string;
    prerequisites?: string[];
  }>;
  /** 题库题目：knowledgeIds 命中知识点 */
  questions: Array<{
    id: string;
    level: string;
    questionType: string;
    stem: string;
    standardAnswer: string;
    knowledgeIds: string[];
    /** 选择题选项（可选，供前端渲染选项卡） */
    options?: string[];
  }>;
  /** 先修强度（可选）：默认全部 hard */
  prerequisiteStrength?: Record<string, 'hard' | 'soft'>;
}

/**
 * 构建诊断图。
 *
 * 先修顺序：hard 在前、soft 在后；同级按知识点在资产里的出现顺序 ——
 * 保证出题次序**确定性**，同样的资产永远得到同样的诊断顺序。
 */
export function buildDiagnosticGraph(input: GraphInput): DiagnosticGraph {
  const nodes: Record<string, DiagnosticNode> = {};
  const index: Record<string, number> = {};
  input.knowledgePoints.forEach((kp, i) => {
    index[kp.id] = i;
    nodes[kp.id] = {
      id: kp.id,
      name: kp.name,
      subject: kp.subject,
      prerequisites: [],
    };
  });

  for (const kp of input.knowledgePoints) {
    const pres = (kp.prerequisites ?? []).filter((p) => nodes[p]);
    const seen = new Set<string>();
    const list: DiagnosticNode['prerequisites'] = [];
    for (const p of pres) {
      if (seen.has(p)) continue;
      seen.add(p);
      list.push({
        id: p,
        strength: input.prerequisiteStrength?.[`${kp.id}<${p}`] ?? 'hard',
      });
    }
    list.sort((a, b) => {
      const sa = a.strength === 'hard' ? 0 : 1;
      const sb = b.strength === 'hard' ? 0 : 1;
      return sa !== sb ? sa - sb : index[a.id] - index[b.id];
    });
    nodes[kp.id].prerequisites = list;
  }

  // 题库
  const bank: Record<string, DiagnosticQuestion[]> = {};
  for (const id of Object.keys(nodes)) bank[id] = [];
  for (const q of input.questions) {
    for (const kid of q.knowledgeIds) {
      if (!nodes[kid]) continue;
      bank[kid].push({
        id: q.id,
        knowledgeId: kid,
        difficulty: levelToDifficulty(q.level),
        questionType: q.questionType,
        stem: q.stem,
        standardAnswer: q.standardAnswer,
        level: q.level,
        ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
      });
    }
  }
  for (const id of Object.keys(bank)) {
    bank[id].sort((a, b) => a.id.localeCompare(b.id));
  }

  // 拓扑序（先修在前）；存在环时退化为资产顺序，不抛错
  const order = topoSort(nodes);
  return { nodes, bank, order };
}

/** Kahn 拓扑排序；同层按资产顺序 */
function topoSort(nodes: Record<string, DiagnosticNode>): string[] {
  const indeg: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) {
    indeg[id] = 0;
    dependents[id] = [];
  }
  for (const id of Object.keys(nodes)) {
    for (const p of nodes[id].prerequisites) {
      indeg[id]++;
      dependents[p.id].push(id);
    }
  }
  const queue = Object.keys(nodes)
    .filter((id) => indeg[id] === 0)
    .sort();
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    out.push(id);
    for (const dep of dependents[id]) {
      indeg[dep]--;
      if (indeg[dep] === 0) queue.push(dep);
    }
  }
  // 有环：把剩下的按资产顺序追加，保证函数不抛错
  if (out.length < Object.keys(nodes).length) {
    const done = new Set(out);
    for (const id of Object.keys(nodes)) {
      if (!done.has(id)) out.push(id);
    }
  }
  return out;
}

/** 严格祖先集合（不含自身） */
export function ancestorSet(
  graph: DiagnosticGraph,
  id: string
): Set<string> {
  const out = new Set<string>();
  const stack = [...(graph.nodes[id]?.prerequisites ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop() as { id: string };
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.add(cur.id);
    stack.push(...(graph.nodes[cur.id]?.prerequisites ?? []));
  }
  return out;
}

/** 只沿 hard 先修走的祖先集合（筛查模式推断掌握时用） */
export function hardAncestorSet(
  graph: DiagnosticGraph,
  id: string
): Set<string> {
  const out = new Set<string>();
  const stack = [...(graph.nodes[id]?.prerequisites ?? []).filter((p) => p.strength === 'hard')];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop() as { id: string };
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.add(cur.id);
    stack.push(
      ...(graph.nodes[cur.id]?.prerequisites ?? []).filter((p) => p.strength === 'hard')
    );
  }
  return out;
}

// ---------------------------------------------------------------- 会话

export interface SessionOptions {
  limit?: number;
  confirm?: number;
  seed?: string;
  /** screen = 范围仅限目标集，不并入先修祖先 */
  mode?: 'target' | 'screen';
  avoid?: string[];
}

/** 界面可选的确认题数 */
export function clampConfirm(n: number): number {
  const v = Math.floor(Number(n));
  return (CONFIRM_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_CONFIRM;
}

/** 引擎内部允许 1..10（测试可用 1） */
export function normalizeConfirm(n: number): number {
  const v = Math.floor(Number(n));
  return v >= 1 && v <= 10 ? v : DEFAULT_CONFIRM;
}

/** 判「掌握」所需的连续答对题数：min(confirm, 该点题量)，至少 1 */
export function needConfirm(
  graph: DiagnosticGraph,
  session: DiagnosticSession,
  id: string
): number {
  const bankLen = (graph.bank[id] ?? []).length;
  return Math.max(1, Math.min(session.confirm, bankLen || 1));
}

/** 该知识点是否可测（题库里有题） */
export function isTestable(graph: DiagnosticGraph, id: string): boolean {
  return (graph.bank[id]?.length ?? 0) > 0;
}

export function createSession(
  graph: DiagnosticGraph,
  targets: string[],
  opts: SessionOptions = {}
): DiagnosticSession {
  const ts = Array.from(new Set(targets));
  if (!ts.length) throw new Error('至少需要一个目标知识点');
  for (const id of ts) {
    if (!graph.nodes[id]) throw new Error(`未知知识点：${id}`);
  }
  const mode = opts.mode === 'screen' ? 'screen' : 'target';
  const limit = Math.max(
    1,
    Math.floor(opts.limit ?? (mode === 'screen' ? SCREEN_LIMIT : DEFAULT_LIMIT))
  );
  const confirm = normalizeConfirm(opts.confirm ?? DEFAULT_CONFIRM);

  const pos: Record<string, number> = {};
  graph.order.forEach((id, i) => (pos[id] = i));

  // 目标模式：把先修祖先并入范围；筛查模式：范围就是目标集本身
  const scope =
    mode === 'screen'
      ? ts.slice()
      : Array.from(
          new Set([
            ...ts,
            ...ts.flatMap((t) => Array.from(ancestorSet(graph, t))),
          ])
        );

  // 离目标最近的先问（拓扑序靠后的先问）
  const stack = scope
    .filter((id) => isTestable(graph, id))
    .sort((a, b) => (pos[b] ?? 0) - (pos[a] ?? 0));

  return {
    targets: ts,
    limit,
    confirm,
    mode,
    stack,
    status: {},
    attempts: {},
    answers: [],
    seed: opts.seed ?? 'default',
    asked: {},
  };
}

/**
 * 选题。
 *
 * - 第一题：优先 standard（提高），退回 basic —— 尽量不出拓展题；
 * - 连续答对、尚未错过：优先 challenge（拓展）以确认掌握；
 * - **错过之后**的确认题：优先 basic → 与首题同档 → 其它更易 → 最后才是更难。
 *   难度优先于「没出过」，因为此时要的是**确认不会**而不是**再考一次**。
 *
 * 同一 (seed, 知识点, 第几次作答) 恒定产出同一题 → 会话可重放。
 */
export function pickQuestion(
  graph: DiagnosticGraph,
  session: DiagnosticSession,
  id: string,
  attempt: number,
  avoid: string[] = []
): DiagnosticQuestion | null {
  const all = graph.bank[id] ?? [];
  const tried = new Set((session.attempts[id] ?? []).map((a) => a.qid));
  const pool = all.filter((q) => !tried.has(q.id));
  if (!pool.length) return null;

  const avoidSet = new Set(avoid);
  const freshFirst = (list: DiagnosticQuestion[]): DiagnosticQuestion[] => {
    const f = list.filter((q) => !avoidSet.has(q.id));
    return f.length ? f : list;
  };
  const pickRank = (
    list: DiagnosticQuestion[],
    ranks: number[]
  ): DiagnosticQuestion[] => {
    for (const r of ranks) {
      const hit = list.filter((q) => DIFF_RANK[q.difficulty] === r);
      if (hit.length) return freshFirst(hit);
    }
    return freshFirst(list);
  };

  const prev = session.attempts[id] ?? [];
  const hadFail = prev.some((a) => a.result !== 'correct');
  let cand: DiagnosticQuestion[];
  if (attempt <= 1 || !hadFail) {
    const base = freshFirst(pool);
    cand = attempt <= 1 ? pickRank(base, [1, 0]) : pickRank(base, [2, 1, 0]);
  } else {
    const first = all.find((q) => q.id === (session.asked[id] ?? [])[0]);
    const r0 = first ? DIFF_RANK[first.difficulty] : 1;
    const tiers = [
      pool.filter((q) => DIFF_RANK[q.difficulty] === 0),
      pool.filter((q) => DIFF_RANK[q.difficulty] === r0),
      pool.filter((q) => DIFF_RANK[q.difficulty] < r0),
    ];
    const hit = tiers.find((t) => t.length);
    if (hit) cand = freshFirst(hit);
    else {
      const lo = Math.min(...pool.map((q) => DIFF_RANK[q.difficulty]));
      cand = freshFirst(pool.filter((q) => DIFF_RANK[q.difficulty] === lo));
    }
  }

  const idx = Math.min(
    cand.length - 1,
    Math.floor(rand01(session.seed, `${id}|${attempt}`) * cand.length)
  );
  return cand[idx];
}

/**
 * 记录一次作答。
 *
 * 返回**新的**会话对象（不修改入参），便于调用方安全地做「撤销 / 回放」。
 */
export function applyAnswer(
  graph: DiagnosticGraph,
  session: DiagnosticSession,
  id: string,
  result: AnswerResult,
  extra?: { text?: string; qid?: string }
): DiagnosticSession {
  if (!['correct', 'wrong', 'skip'].includes(result)) {
    throw new Error('作答结果必须是 correct / wrong / skip');
  }
  if (!graph.nodes[id]) throw new Error(`未知知识点：${id}`);

  const s: DiagnosticSession = {
    ...session,
    stack: [...session.stack],
    status: { ...session.status },
    attempts: { ...session.attempts },
    answers: [...session.answers],
    asked: { ...session.asked },
  };

  // 已有结论再作答 = 重新开始这个点
  if (s.status[id]) {
    delete s.status[id];
    s.attempts[id] = [];
    s.asked[id] = [];
  }

  const prev = s.attempts[id] ?? [];
  let q: DiagnosticQuestion | null = null;
  if (extra?.qid) {
    q = (graph.bank[id] ?? []).find((x) => x.id === extra.qid) ?? null;
    if (!q) return session;
  } else {
    q = pickQuestion(graph, s, id, prev.length + 1);
  }

  s.answers.push({
    knowledgeId: id,
    qid: q?.id ?? null,
    result,
    ...(extra?.text ? { text: extra.text } : {}),
    at: new Date().toISOString(),
  });
  s.attempts[id] = [...prev, { qid: q?.id ?? null, result }];
  s.asked[id] = [...(s.asked[id] ?? []), ...(q ? [q.id] : [])];

  const attempts = s.attempts[id];
  const fails = attempts.filter((a) => a.result !== 'correct').length;
  const corrects = attempts.filter((a) => a.result === 'correct').length;
  const need = needConfirm(graph, s, id);

  if (result === 'correct') {
    if (fails === 0 && corrects >= need) {
      s.status[id] = { s: 'mastered', src: 'direct' };
      const anc =
        s.mode === 'screen'
          ? hardAncestorSet(graph, id)
          : ancestorSet(graph, id);
      for (const a of anc) {
        if (!s.status[a]) s.status[a] = { s: 'mastered', src: 'inferred' };
      }
    } else if (fails > 0) {
      // 错过之后又答对 → 不稳：不回溯先修，但必须进学习路径
      s.status[id] = { s: 'shaky', src: 'direct' };
    }
    // 否则：连对未满额，继续出同点的下一题
  } else if (fails === 1 && pickQuestion(graph, s, id, attempts.length + 1)) {
    // 第一次没过：等确认题再下结论
  } else {
    s.status[id] = { s: 'weak', src: 'direct' };
    const scopeSet = s.mode === 'screen' ? new Set(s.targets) : null;
    const push = (graph.nodes[id]?.prerequisites ?? [])
      .map((p) => p.id)
      .filter(
        (p) =>
          isTestable(graph, p) &&
          !s.status[p] &&
          (!scopeSet || scopeSet.has(p))
      );
    const pushed = new Set(push);
    s.stack = [
      ...push,
      ...s.stack.filter((x) => !pushed.has(x)),
    ];
  }

  return s;
}

/** 下一个该出题的知识点 */
export function nextKnowledgeId(
  graph: DiagnosticGraph,
  session: DiagnosticSession
): string | null {
  if (session.answers.length >= session.limit) return null;
  for (const id of session.stack) {
    if (!session.status[id] && isTestable(graph, id)) return id;
  }
  return null;
}

/** 下一个出题项 */
export function nextItem(
  graph: DiagnosticGraph,
  session: DiagnosticSession
): { knowledgeId: string; question: DiagnosticQuestion; attempt: number } | null {
  const id = nextKnowledgeId(graph, session);
  if (!id) return null;
  const attempt = (session.attempts[id] ?? []).length + 1;
  const q = pickQuestion(graph, session, id, attempt);
  if (!q) return null;
  return { knowledgeId: id, question: q, attempt };
}

/** 由作答记录重建会话（刷新恢复 / 撤销 / 更正） */
export function replay(
  graph: DiagnosticGraph,
  targets: string[],
  answers: Array<{ knowledgeId: string; result: AnswerResult; qid?: string; text?: string }>,
  opts: SessionOptions = {}
): DiagnosticSession {
  let s = createSession(graph, targets, opts);
  for (const a of answers) {
    if (!a) continue;
    s = applyAnswer(graph, s, a.knowledgeId, a.result, {
      ...(a.text ? { text: a.text } : {}),
      ...(a.qid ? { qid: a.qid } : {}),
    });
  }
  return s;
}

/** 状态：mastered / shaky / weak / unknown */
export function statusOf(
  session: DiagnosticSession,
  id: string
): DiagnosticStatus {
  const st = session.status[id];
  if (st) return st.s;
  const a = session.attempts[id];
  if (!a || !a.length) return 'unknown';
  // 答错过但没来得及出确认题（题量用完）→ 算薄弱
  return a.some((x) => x.result !== 'correct') ? 'weak' : 'unknown';
}

/** 答错过、但没来得及出确认题 */
export function isUnconfirmed(session: DiagnosticSession, id: string): boolean {
  if (session.status[id]) return false;
  const a = session.attempts[id];
  if (!a || !a.length) return false;
  return a.some((x) => x.result !== 'correct');
}

export interface DiagnosticSummary {
  mastered: string[];
  shaky: string[];
  weak: string[];
  untested: string[];
  /** 建议回退补强的先修点（薄弱点的先修，按被依赖次数降序） */
  backtrack: Array<{ knowledgeId: string; name: string; dependedBy: number }>;
  answered: number;
  limit: number;
}

/** 汇总：分四类 + 给出回溯建议 */
export function summarize(
  graph: DiagnosticGraph,
  session: DiagnosticSession
): DiagnosticSummary {
  const scope =
    session.mode === 'screen'
      ? session.targets
      : Array.from(
          new Set([
            ...session.targets,
            ...session.targets.flatMap((t) => Array.from(ancestorSet(graph, t))),
          ])
        );
  const st = (id: string) => statusOf(session, id);

  const mastered = scope.filter((id) => st(id) === 'mastered');
  const shaky = scope.filter((id) => st(id) === 'shaky');
  const weak = scope.filter((id) => st(id) === 'weak');
  const untested = scope.filter((id) => st(id) === 'unknown');

  // 回溯建议：薄弱点的先修，按「被多少个薄弱点依赖」降序
  const dependCount: Record<string, number> = {};
  for (const w of weak) {
    for (const p of graph.nodes[w]?.prerequisites ?? []) {
      dependCount[p.id] = (dependCount[p.id] ?? 0) + 1;
    }
  }
  const backtrack = Object.entries(dependCount)
    .filter(([id]) => st(id) !== 'mastered')
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({
      knowledgeId: id,
      name: graph.nodes[id]?.name ?? id,
      dependedBy: n,
    }));

  return {
    mastered,
    shaky,
    weak,
    untested,
    backtrack,
    answered: session.answers.length,
    limit: session.limit,
  };
}

/**
 * 三态 → 项目掌握度状态的映射。
 *
 * - `mastered` → 初步掌握（单次诊断只给到「初步」，
 *   「掌握 / 稳定掌握」仍需变式与延迟复测来确认）；
 * - `shaky` → 学习中（会但不稳，不能算掌握）；
 * - `weak` → 待学习。
 */
export function diagnosticStatusToMasteryState(
  status: DiagnosticStatus
): '初步掌握' | '学习中' | '待学习' {
  if (status === 'mastered') return '初步掌握';
  if (status === 'shaky') return '学习中';
  if (status === 'weak') return '待学习';
  return '学习中';
}
