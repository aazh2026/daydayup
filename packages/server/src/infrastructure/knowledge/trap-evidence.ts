/**
 * 错因证据匹配（**资产为中心**，纯函数）。
 *
 * ── 为什么是「资产为中心」而不是「条目为中心」 ────────────────────────
 *
 * 原来的 `trap-matcher.ts` 是「条目 → 知识点」：每条易错内容自己去知识库里
 * 找名字最像的知识点。实测这条路只能覆盖 315 个初中数学知识点里的 76.5%
 * （241/315），而且剩下的多是「行程问题」「销售利润」这类**应用型细分点** ——
 * 它们本来就没有对应的 atlas 篇目，硬凑只会错挂。
 *
 * 换一个方向：**知识点 → 来源主题**。
 * 每个知识点在「同册同章」的来源主题里找证据最强的那一个，把该主题的易错内容
 * 整体继承过来。理由：atlas 的 83 篇本身就是按人教版章节写的，
 * 一篇对应教材的一个小节，篇目里的易错点天然属于该节的所有细分点。
 *
 * ── 证据分级 ────────────────────────────────────────────────────────────
 *
 * 分数越高证据越硬：
 *   100 name==title       知识点名 == 来源标题
 *    95 name==keyword     知识点名 == 来源关键词
 *    90 name-in-title     知识点名短语 ⊂ 来源标题（长度 ≥ 3）
 *    88 name-in-body      知识点名短语出现在来源正文（长度 ≥ 3）
 *    85 term-in-title     知识点词 ⊂ 来源标题（长度 ≥ 3）
 *    82 term-in-body      知识点词出现在来源正文（不在 STOP 词表内）
 *    80 term==keyword     知识点词 == 来源关键词
 *    60+ keyword-overlap  知识点词与关键词部分重叠
 *    40 name-token-weak   只命中两字级碎词
 *    30 soft-in-item      子技能/定义里的短语出现在某条易错内容里
 *
 * 置信度：≥ 80 → high，≥ 30 → medium，否则视为未匹配。
 *
 * ── 硬门槛 ──────────────────────────────────────────────────────────────
 *
 * 册次一致 + 章号一致 + 节号前缀相交（知识点无节号时放行）。
 * 门槛不通过时**直接不参与打分** —— 宁可漏挂，不挂到别的册次去。
 *
 * ── 已验证的教训（勿轻易推翻） ──────────────────────────────────────────
 *
 *   1. 中文 bigram/Jaccard/LCS 相似度对短标题几乎无效 —— 别再写相似度。
 *   2. 切词不能只按「的」拆 —— 「相反数」「绝对值」会被误杀；
 *      切分结果必须与原短语**取并集**。
 *   3. STOP 词表只能作用于弱证据（正文/碎词），**不能**作用于知识点名本身。
 *   4. 不做 1:1 唯一分配 —— 一个来源主题可以同时服务多个细分知识点。
 */

import type { TrapConfidence } from '@daydayup/contracts';

import type { TrapCandidate } from './converters/traps.ts';
import {
  STOP_TERMS,
  cjkOnly,
  namePhrases,
  nameTerms,
  normalizeText,
  scopeHit,
  softPhrases,
  volumeConflict,
  type KnowledgeScope,
  type TrapScope,
} from './trap-text.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 参与匹配的知识点（资产侧） */
export interface EvidenceAsset {
  id: string;
  name: string;
  subject: string;
  stage: string;
  /** 教材落点（由资产 `chapter` 解析而来） */
  scope: KnowledgeScope;
  /** 子技能（弱证据来源） */
  subSkills?: string[];
  /** 定义（弱证据来源） */
  definition?: string;
}

/** 参与匹配的来源主题（来源侧） */
export interface EvidenceTopic {
  /** 来源主题 id（源项目内唯一） */
  id: string;
  /** 来源仓库名 */
  repo: string;
  /** 主题标题 */
  title: string;
  subject: string;
  stage: string;
  /** 主题关键词（强证据） */
  keywords?: string[];
  /** 正文（已规范化：小写、去标点、只留汉字/字母/数字） */
  body: string;
  /** 教材落点（来源侧） */
  scope: TrapScope;
  /** 该主题下的易错条目 */
  items: TrapCandidate[];
}

/** 一次证据打分的结果 */
export interface EvidenceScore {
  /** 证据分数（越大越硬） */
  score: number;
  /** 证据类型（用于审计与报告） */
  reason: string;
}

// ---------------------------------------------------------------------------
// 阈值
// ---------------------------------------------------------------------------

/** high 置信度的分数线 */
export const EVIDENCE_HIGH = 80;
/** medium 置信度的分数线（低于此值视为未匹配） */
export const EVIDENCE_MEDIUM = 30;

/** 证据类型 → 分数（供报告与测试引用） */
export const EVIDENCE_SCORES = {
  'name==title': 100,
  'name==keyword': 95,
  'name-in-title': 90,
  'name-in-body': 88,
  'term-in-title': 85,
  'term-in-body': 82,
  'term==keyword': 80,
  'keyword-overlap': 60,
  'name-token-weak': 40,
  'soft-in-item': 30,
} as const;

export type EvidenceReason = keyof typeof EVIDENCE_SCORES;

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/**
 * 正文规范化：与 `phrases()` 的字符集保持一致
 * （小写、去标点、只留汉字/字母/数字），否则「$-a$」这类片段匹配不上。
 */
export function normalizeBody(text: string | undefined | null): string {
  return cjkOnly(normalizeText(text ?? ''));
}

/** 证据来源的正文：标题 + 关键词 + 补充文本 */
export function buildTopicBody(...parts: Array<string | undefined | null>): string {
  return normalizeBody(parts.filter(Boolean).join(' '));
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

/**
 * 知识点与来源主题之间的证据分数。
 *
 * @returns 最高分的证据；没有任何证据时返回 null
 */
export function scoreEvidence(
  asset: EvidenceAsset,
  topic: EvidenceTopic
): EvidenceScore | null {
  const title = normalizeText(topic.title);
  const body = topic.body;
  const keywords = (topic.keywords ?? []).map(normalizeText).filter(Boolean);

  const namePhrasesNorm = namePhrases(asset.name)
    .map(normalizeText)
    .filter(Boolean);
  const nameTermsNorm = nameTerms(asset.name)
    .map(normalizeText)
    .filter(Boolean);

  let best: EvidenceScore | null = null;
  const put = (score: number, reason: EvidenceReason) => {
    if (!best || score > best.score) best = { score, reason };
  };

  // 1. 整名短语：与标题 / 关键词 / 正文比对
  for (const phrase of namePhrasesNorm) {
    if (phrase.length < 2) continue;
    if (phrase.length >= 3 && body.includes(phrase)) {
      put(EVIDENCE_SCORES['name-in-body'], 'name-in-body');
    }
    if (phrase === title) {
      put(EVIDENCE_SCORES['name==title'], 'name==title');
    } else if (phrase.length >= 3 && title.includes(phrase)) {
      put(EVIDENCE_SCORES['name-in-title'], 'name-in-title');
    }
    if (keywords.includes(phrase)) {
      put(EVIDENCE_SCORES['name==keyword'], 'name==keyword');
    }
  }

  // 2. 拆出来的词：与标题 / 关键词 / 正文比对
  for (const term of nameTermsNorm) {
    if (term.length < 3) continue;
    if (title.includes(term)) {
      put(EVIDENCE_SCORES['term-in-title'], 'term-in-title');
    }
    // STOP 词只在这里生效：通用词出现在正文里说明不了「这篇讲的就是这个点」
    if (!STOP_TERMS.has(term) && body.includes(term)) {
      put(EVIDENCE_SCORES['term-in-body'], 'term-in-body');
    }
    for (const kw of keywords) {
      if (kw === term) {
        put(EVIDENCE_SCORES['term==keyword'], 'term==keyword');
      } else if (kw.includes(term) || term.includes(kw)) {
        put(60 + 2 * Math.min(kw.length, term.length), 'keyword-overlap');
      }
    }
  }

  // 3. 碎词弱证据（两字级）
  for (const term of nameTermsNorm) {
    if (term.length < 2) continue;
    if (title.includes(term) || keywords.some((k) => k.includes(term))) {
      put(EVIDENCE_SCORES['name-token-weak'], 'name-token-weak');
    }
  }

  // 4. 条目级弱证据：子技能/定义里的短语出现在某条易错内容里
  if (!best || best.score < EVIDENCE_SCORES['soft-in-item']) {
    const softs = softPhrases([
      asset.definition ?? '',
      ...(asset.subSkills ?? []),
    ]);
    for (const soft of softs) {
      if (soft.length < 3) continue;
      const hit = topic.items.some((item) =>
        normalizeBody(
          item.sourceText ?? `${item.wrong} ${item.why} ${item.right}`
        ).includes(soft)
      );
      if (hit) {
        put(EVIDENCE_SCORES['soft-in-item'], 'soft-in-item');
        break;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// 分配
// ---------------------------------------------------------------------------

/** 一个知识点采纳的来源主题 */
export interface EvidenceAssignment {
  assetId: string;
  assetName: string;
  topic: EvidenceTopic;
  score: number;
  reason: string;
  confidence: TrapConfidence;
}

export interface EvidenceAssignOptions {
  /** 低于该分数不采纳（默认 EVIDENCE_MEDIUM） */
  minScore?: number;
}

export interface EvidenceAssignResult {
  /** 每个采纳了主题的知识点 */
  assignments: EvidenceAssignment[];
  /** 没有采纳任何主题的知识点 id */
  unmatchedAssetIds: string[];
  /** 没有被任何知识点采纳的来源主题 id */
  unmatchedTopicIds: string[];
  /** 按证据类型统计（命中分数最高的那条） */
  byReason: Record<string, number>;
}

/**
 * 把来源主题分配给知识点：每个知识点只取**分数最高**的那一个来源主题。
 *
 * 不做 1:1 唯一分配 —— atlas 的一篇往往覆盖教材的一整节，
 * 该节下的多个细分知识点都会继承同一篇的易错内容。
 */
export function assignEvidence(
  assets: EvidenceAsset[],
  topics: EvidenceTopic[],
  opts: EvidenceAssignOptions = {}
): EvidenceAssignResult {
  const minScore = opts.minScore ?? EVIDENCE_MEDIUM;

  const assignments: EvidenceAssignment[] = [];
  const byReason: Record<string, number> = {};
  const usedTopicIds = new Set<string>();

  for (const asset of assets) {
    let best: { topic: EvidenceTopic; score: EvidenceScore } | null = null;

    for (const topic of topics) {
      // 学科 / 学段硬门槛
      if (topic.subject && asset.subject && topic.subject !== asset.subject) continue;
      if (topic.stage && asset.stage && topic.stage !== asset.stage) continue;
      // 教材落点硬门槛（册次 / 章号 / 节号）
      if (!scopeHit(asset.scope, topic.scope)) continue;

      const score = scoreEvidence(asset, topic);
      if (!score) continue;
      if (!best || score.score > best.score.score) {
        best = { topic, score };
      }
    }

    if (!best || best.score.score < minScore) continue;

    // 册次冲突：**降级而非丢弃**。这篇确实讲的是类似内容，但不是这一册 ——
    // 保留为 medium（进待审池），绝不能算 high（否则运行时 commonTraps 会挂错册次）。
    const conflict = volumeConflict(asset.scope, best.topic.scope);
    const confidence: TrapConfidence =
      !conflict && best.score.score >= EVIDENCE_HIGH ? 'high' : 'medium';

    assignments.push({
      assetId: asset.id,
      assetName: asset.name,
      topic: best.topic,
      score: best.score.score,
      reason: best.score.reason,
      confidence,
    });
    usedTopicIds.add(best.topic.id);
    byReason[best.score.reason] = (byReason[best.score.reason] ?? 0) + 1;
  }

  const matchedAssetIds = new Set(assignments.map((a) => a.assetId));

  return {
    assignments,
    unmatchedAssetIds: assets.filter((a) => !matchedAssetIds.has(a.id)).map((a) => a.id),
    unmatchedTopicIds: topics.filter((t) => !usedTopicIds.has(t.id)).map((t) => t.id),
    byReason,
  };
}
