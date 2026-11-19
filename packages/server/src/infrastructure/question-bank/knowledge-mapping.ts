/**
 * 题庄知识点名 → 项目原生知识点 id 的映射。
 *
 * ── 为什么需要这层 ────────────────────────────────────────────────────────
 *
 * 题庄的知识点是**试卷视角**的名字（"ing形容词和ed形容词"、"人物故事类阅读"），
 * 项目 curriculum 的知识点是**教学视角**的名字（"形容词位置"、"记叙文"）。
 * 两边名字不同，但语义指向同一考点。
 *
 * ── 三级命中规则 ──────────────────────────────────────────────────────────
 *
 * ① `exact`  —— 完全同名（归一化去空白后相等）；
 * ② `contains` —— 一方是另一方的前缀或后缀（**边界对齐**），取最短的候选
 *    （最通用、最贴近考点本身）；
 * ③ `alias`  —— 显式别名表命中。
 *
 * ② 之所以要求「前缀/后缀对齐」而不是任意包含，是为了避免
 * 「谓语」被匹配到「非谓语动词」——后者在内部包含前者，但不是同一个考点。
 * 用后缀/前缀对齐后，「非谓语动词」被拒绝，「谓语」才能正确落到同名点。
 *
 * 别名表里的目标名**必须在运行时用 `getCurriculum().knowledgePoints` 校验存在**：
 * overlay 资产（cne_wb_*）可能随另一条产线增删，写死 id 一定会漂。
 * 目标名不存在时按候选顺序降级到更通用的真实名字；全部不存在则返回 `none`。
 */

export interface KnowledgePointLite {
  id: string;
  name: string;
  domain?: string;
  chapter?: string;
  subject?: string;
}

export type MatchConfidence = 'exact' | 'contains' | 'alias' | 'none';

export interface KnowledgeMatch {
  /** 项目原生知识点 id；未命中时为 '' */
  id: string;
  /** 命中的项目知识点名；未命中时为 '' */
  matchedName: string;
  confidence: MatchConfidence;
  /** 原始的题庄知识点名（便于排查） */
  original: string;
}

/**
 * 别名表：题庄知识点名 → 项目知识点名的**候选序列**（按优先级）。
 *
 * 候选按顺序在运行时校验，取第一个真实存在的名字。
 * 全部不存在时用 `TIZHUANG_ALIAS_FALLBACK` 里的兜底名（同样校验）。
 */
export const TIZHUANG_KNOWLEDGE_ALIASES: Record<string, string[]> = {
  // 词汇 · 词法
  'ing形容词和ed形容词': ['-ed 与 -ing 形容词', '形容词位置', '四词转换链'],
  '复合形容词': ['描述性形容词', '形容词比较级', '形容词位置'],
  '数词的用法': ['序数词', '基数词与序数词', '分数与 hundred/thousand'],
  '名词复数': ['可数名词复数', '名词复数规则'],
  '不可数名词': ['可数与不可数名词', '不可数名词量化'],
  '冠词用法': ['不定冠词 a/an', '定冠词 the', '零冠词场景'],
  '代词': ['人称代词格', '指示代词 this、that、these、those'],
  '介词': ['方位介词', '常见介词搭配'],
  '情态动词': ['情态动词基本', '情态动词表推测'],
  '不定式': ['动名词与不定式', '不定式作宾语'],
  '动名词': ['动名词与不定式', '动名词作宾语'],
  '时态': ['时态选择', '时态呼应'],
  '被动语态': ['各时态被动', '各时态被动结构'],
  '主谓一致': ['主谓一致', '集合名词与主谓一致'],
  '比较级': ['形容词比较级', '原级比较'],
  '最高级': ['形容词最高级', '最高级构成'],
  '频度': ['频度副词', '副词位置'],
  '反意疑问句': ['反意疑问句', '反意疑问句语调'],
  '形式宾语': ['it 作形式宾语', 'it 作形式主语/宾语'],
  '形式主语': ['it 作形式主语/宾语', 'it 作形式宾语'],
  '宾语': ['宾语', '动名词作宾语'],
  '宾补': ['宾语补足语', '不定式作宾补'],
  '谓语': ['谓语', '主谓一致'],
  '并列连词': ['并列连词 and/but/or/so', '并列连词'],
  '从属连词': ['关联连词', '宾语从句陈述语序'],
  '非谓语动词': ['不定式作宾语', '动名词作宾语'],
  '量词': ['量词表达'],
  '谚语': ['传统文化词块', '熟词生义'],
  '词块': ['话题词块输出', '传统文化词块'],

  // 阅读 · 语篇
  '人物故事类阅读': ['记叙文', '主旨大意题', '事实细节题'],
  '教育文化类阅读': ['记叙文', '主旨大意题', '事实细节题'],
  '逸闻趣事类阅读': ['记叙文', '主旨大意题', '事实细节题'],
  '阅读理解': ['主旨大意题', '事实细节题', '阅读问答'],
  '判断推理': ['推理判断题', '事实细节题'],
  '内容归纳': ['主旨大意题', '事实细节题'],
  '词义猜测': ['词义猜测题', '熟词生义'],
  '标题': ['标题选择题', '主旨大意题'],
  '任务型阅读': ['任务型阅读', '阅读问答'],
  '完形填空': ['完形填空'],

  // 交际 · 文化
  '情境对话': ['交际应答', '问候与介绍'],
  '询问别人的意见': ['疑问词 + 不定式', '宾语补足语', '特殊疑问句'],
  '建议': ['建议与劝告', '祈使句'],
  '邀请': ['邀请与拒绝', '特殊疑问句'],
  '英文常识': ['文化习俗', '文化遗产', '多元文化'],
  '写作': ['常见话题万能句', '应用文格式'],
};

/**
 * 别名兜底：当别名表里所有候选名在运行时都不存在时尝试的名字。
 * 同样在运行时校验存在性。
 */
export const TIZHUANG_ALIAS_FALLBACK: Record<string, string[]> = {
  'ing形容词和ed形容词': ['形容词位置'],
  '复合形容词': ['形容词位置'],
  '数词的用法': ['序数词'],
  '名词复数': ['名词复数规则'],
  '不可数名词': ['可数与不可数名词'],
  '冠词用法': ['不定冠词 a/an'],
  '代词': ['人称代词格'],
  '介词': ['方位介词'],
  '情态动词': ['情态动词基本'],
  '不定式': ['动名词与不定式'],
  '动名词': ['动名词与不定式'],
  '时态': ['时态选择'],
  '被动语态': ['各时态被动'],
  '主谓一致': ['主谓一致'],
  '比较级': ['形容词比较级'],
  '最高级': ['形容词最高级'],
  '频度': ['频度副词'],
  '反意疑问句': ['反意疑问句'],
  '形式宾语': ['it 作形式宾语'],
  '形式主语': ['it 作形式主语/宾语'],
  '宾语': ['宾语'],
  '宾补': ['宾语补足语'],
  '谓语': ['谓语'],
  '并列连词': ['并列连词 and/but/or/so'],
  '从属连词': ['关联连词'],
  '非谓语动词': ['不定式作宾语'],
  '量词': ['量词表达'],
  '谚语': ['传统文化词块'],
  '词块': ['话题词块输出'],
  '人物故事类阅读': ['记叙文'],
  '教育文化类阅读': ['记叙文'],
  '逸闻趣事类阅读': ['记叙文'],
  '阅读理解': ['主旨大意题'],
  '判断推理': ['推理判断题'],
  '内容归纳': ['主旨大意题'],
  '词义猜测': ['词义猜测题'],
  '标题': ['标题选择题'],
  '任务型阅读': ['任务型阅读'],
  '完形填空': ['完形填空'],
  '情境对话': ['交际应答'],
  '询问别人的意见': ['宾语补足语'],
  '建议': ['建议与劝告'],
  '邀请': ['邀请与拒绝'],
  '英文常识': ['文化习俗'],
  '写作': ['常见话题万能句'],
};

// ---------------------------------------------------------------------------
// 名称归一化
// ---------------------------------------------------------------------------

/** 归一化：去首尾空白、内部连续空白压成单个空格、统一小写 */
export function normalizePointName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 边界对齐判定：short 是否是 long 的前缀或后缀 */
function isAlignedPrefixOrSuffix(short: string, long: string): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  if (short.length === long.length) return short === long;
  return (
    long.startsWith(short) ||
    long.endsWith(short) ||
    short.startsWith(long) ||
    short.endsWith(long)
  );
}

// ---------------------------------------------------------------------------
// 单个名字的映射
// ---------------------------------------------------------------------------

/**
 * 把一个题庄知识点名映射到项目原生知识点。
 *
 * @param name            题庄知识点名
 * @param knowledgePoints 运行时知识点集合（必须来自 getCurriculum()）
 */
export function mapTizhuangKnowledgeName(
  name: string,
  knowledgePoints: KnowledgePointLite[]
): KnowledgeMatch {
  const original = name;
  const target = normalizePointName(name);
  if (!target) {
    return { id: '', matchedName: '', confidence: 'none', original };
  }

  // ① 精确同名
  for (const point of knowledgePoints) {
    if (normalizePointName(point.name) === target) {
      return {
        id: point.id,
        matchedName: point.name,
        confidence: 'exact',
        original,
      };
    }
  }

  // ② 边界对齐包含（取最短候选 = 最通用、最贴近考点本身）
  let best: KnowledgePointLite | undefined;
  for (const point of knowledgePoints) {
    const candidate = normalizePointName(point.name);
    if (!isAlignedPrefixOrSuffix(target, candidate)) continue;
    if (!best || candidate.length < normalizePointName(best.name).length) {
      best = point;
    }
  }
  if (best) {
    return {
      id: best.id,
      matchedName: best.name,
      confidence: 'contains',
      original,
    };
  }

  // ③ 别名表
  const aliasHit = resolveAlias(name, knowledgePoints);
  if (aliasHit) {
    return {
      id: aliasHit.id,
      matchedName: aliasHit.name,
      confidence: 'alias',
      original,
    };
  }

  return { id: '', matchedName: '', confidence: 'none', original };
}

/**
 * 批量映射：保持输入顺序，一个题庄名字对应一条结果。
 */
export function mapTizhuangKnowledgeNames(
  names: string[],
  knowledgePoints: KnowledgePointLite[]
): KnowledgeMatch[] {
  return names.map((name) => mapTizhuangKnowledgeName(name, knowledgePoints));
}

/**
 * 批量映射并去重 id：只返回真正命中的原生 id。
 */
export function resolveNativeKnowledgeIds(
  names: string[],
  knowledgePoints: KnowledgePointLite[]
): { ids: string[]; matches: KnowledgeMatch[] } {
  const matches = mapTizhuangKnowledgeNames(names, knowledgePoints);
  const ids: string[] = [];
  for (const match of matches) {
    if (match.id && !ids.includes(match.id)) ids.push(match.id);
  }
  return { ids, matches };
}

// ---------------------------------------------------------------------------
// 反向：项目知识点 → 题庄知识点（供路由按 knowledgeId 找题庄 knowledge id）
// ---------------------------------------------------------------------------

export interface TizhuangKnowledgeNodeLite {
  id: number;
  knowledgeId: number;
  name: string;
  parentId?: number;
  level?: number;
  hasChildren?: boolean;
}

export interface TizhuangNodeMatch {
  node: TizhuangKnowledgeNodeLite;
  confidence: MatchConfidence;
}

/**
 * 反向匹配：给定项目知识点名，找出题庄知识点树里的候选节点。
 *
 * 规则与正向一致（exact → contains → alias），但 alias 方向是反的：
 * 正向 `形式宾语 → it 作形式宾语`，反向 `it 作形式宾语 → 形式宾语`。
 *
 * 返回的节点**按置信度与匹配度排序**，路由取前几个作为 knowledge_tree_id 候选。
 */
export function matchTizhuangKnowledgeNodes(
  projectName: string,
  tizhuangNodes: TizhuangKnowledgeNodeLite[],
  knowledgePoints: KnowledgePointLite[] = []
): TizhuangNodeMatch[] {
  const target = normalizePointName(projectName);
  if (!target) return [];

  // 反向别名：项目名 → 题庄名
  const reverseAliases: string[] = [];
  for (const [tizhuangName, candidates] of Object.entries(
    TIZHUANG_KNOWLEDGE_ALIASES
  )) {
    if (candidates.some((c) => normalizePointName(c) === target)) {
      reverseAliases.push(tizhuangName);
    }
  }

  const results: TizhuangNodeMatch[] = [];
  for (const node of tizhuangNodes) {
    const nodeName = normalizePointName(node.name);
    let confidence: MatchConfidence = 'none';
    if (nodeName === target) {
      confidence = 'exact';
    } else if (isAlignedPrefixOrSuffix(target, nodeName)) {
      confidence = 'contains';
    } else if (
      reverseAliases.some((alias) => normalizePointName(alias) === nodeName)
    ) {
      confidence = 'alias';
    }
    if (confidence !== 'none') {
      results.push({ node, confidence });
    }
  }

  // 排序：exact > alias > contains；同级按节点名长度升序（更具体的在前）
  const weight: Record<MatchConfidence, number> = {
    exact: 0,
    alias: 1,
    contains: 2,
    none: 3,
  };
  results.sort((a, b) => {
    if (weight[a.confidence] !== weight[b.confidence]) {
      return weight[a.confidence] - weight[b.confidence];
    }
    const lenA = a.node.name.length;
    const lenB = b.node.name.length;
    if (lenA !== lenB) return lenA - lenB;
    return a.node.id - b.node.id;
  });

  return results;
}

// ---------------------------------------------------------------------------
// 内部：别名解析
// ---------------------------------------------------------------------------

function resolveAlias(
  name: string,
  knowledgePoints: KnowledgePointLite[]
): KnowledgePointLite | undefined {
  const byName = new Map<string, KnowledgePointLite>();
  for (const point of knowledgePoints) {
    const key = normalizePointName(point.name);
    if (!byName.has(key)) byName.set(key, point);
  }

  const candidates = TIZHUANG_KNOWLEDGE_ALIASES[name];
  if (candidates) {
    for (const candidate of candidates) {
      const hit = byName.get(normalizePointName(candidate));
      if (hit) return hit;
    }
  }

  const fallbacks = TIZHUANG_ALIAS_FALLBACK[name];
  if (fallbacks) {
    for (const candidate of fallbacks) {
      const hit = byName.get(normalizePointName(candidate));
      if (hit) return hit;
    }
  }

  return undefined;
}
