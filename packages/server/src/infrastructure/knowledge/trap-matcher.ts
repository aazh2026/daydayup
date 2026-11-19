/**
 * 错因候选 → 知识点 的匹配器（纯函数）。
 *
 * 三级匹配，逐级降级，命中即停：
 *
 *   1. `manual-map`      人工维护的 id 映射表（sourceRepo:sourceId → 知识点 id）
 *   2. `source-topic`    源项目自带知识点 id（cn-mt 场景）
 *   3. `exact-name`      主题名规范化后精确命中
 *   3b. `exact-name-alias` 主题名别名精确命中（转换器显式给出的别名）
 *   4. `name-contains`   主题名互相包含且长度差 < 4 字 → 置信度 **medium**
 *
 * 匹配失败不丢弃：条目保留，`knowledgeId = null`、`matchConfidence = 'unmatched'`，
 * 由 CLI 导出成待审表。
 *
 * 学段不一致直接判否 —— 初中数学 atlas 的点不能挂到小学同名主题上。
 */

import type { TrapConfidence, TrapEntry, TrapMatchMethod } from '@daydayup/contracts';
import type { TrapCandidate } from './converters/traps.ts';

export interface KnowledgeIndexItem {
  id: string;
  name: string;
  subject: string;
  stage: string;
}

export interface KnowledgeIndex {
  byId: Map<string, KnowledgeIndexItem>;
  /** 规范化名称 → 知识点列表 */
  byName: Map<string, KnowledgeIndexItem[]>;
  /** 规范化名称（去掉「的」）→ 知识点列表（别名匹配用） */
  byNameNoDe: Map<string, KnowledgeIndexItem[]>;
}

/**
 * 名称规范化：全角转半角、去空白与标点、小写。
 * 「有理数的概念与分类」与「有理数（概念与分类）」应视为同一个名称。
 */
export function normalizeName(name: string): string {
  return name
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s·・．.,;:!?'"()（）\[\]【】《》「」『』、·\-_]/g, '')
    .toLowerCase();
}

/**
 * 知识点学段判定。
 *
 * 规则与 `curriculum.ts` 的 `resolveKnowledgeStage` 保持一致
 * （cn-mt id 后缀 + 章节名特征），但在这里独立实现，避免与加载器产生循环依赖。
 *
 * ⚠️ 小学的判定必须**逐个列出**一~六年级，不能用 `/年级/` 这种宽泛匹配 ——
 * 否则「七年级上册」「九年级下册」也会被判成小学（初中英语知识点会全部错挂）。
 */
export function resolveIndexStage(kp: { id: string; chapter?: string }): string {
  if (kp.id.includes('_p') || /cn._p/.test(kp.id)) return '小学';
  if (kp.id.includes('_h') || /cn._h/.test(kp.id)) return '高中';
  const ch = kp.chapter || '';
  if (
    /六年级|六上|六下|五年级|五上|五下|四年级|四上|四下|三年级|三上|三下|二年级|二上|二下|一年级|一上|一下/.test(
      ch
    )
  ) {
    return '小学';
  }
  if (/高一|高二|高三|必修|选择性必修|选必/.test(ch)) return '高中';
  return '初中';
}

/**
 * 由知识点列表建索引。
 */
export function buildKnowledgeIndex(
  kps: Array<{ id: string; name: string; subject: string; chapter?: string }>
): KnowledgeIndex {
  const byId = new Map<string, KnowledgeIndexItem>();
  const byName = new Map<string, KnowledgeIndexItem[]>();
  const byNameNoDe = new Map<string, KnowledgeIndexItem[]>();

  for (const kp of kps) {
    const item: KnowledgeIndexItem = {
      id: kp.id,
      name: kp.name,
      subject: kp.subject,
      stage: resolveIndexStage(kp),
    };
    byId.set(item.id, item);
    const key = normalizeName(item.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(item);
    byName.set(key, list);

    const keyNoDe = key.replace(/的/g, '');
    if (keyNoDe && keyNoDe !== key) {
      const listNoDe = byNameNoDe.get(keyNoDe) ?? [];
      listNoDe.push(item);
      byNameNoDe.set(keyNoDe, listNoDe);
    }
  }

  return { byId, byName, byNameNoDe };
}

/** 主题名包含匹配的最大长度差（超过则认为不是同一个点） */
export const NAME_CONTAINS_MAX_DIFF = 4;

export interface MatchOptions {
  /**
   * 人工 id 映射表：键为 `sourceRepo:sourceId`，值为知识点 id。
   * 由 `data/traps/id-map.json` 维护（教师确认过的映射）。
   *
   * 键的粒度有两种，按具体优先：
   *   - `junior-math-atlas:m1-02-03-quadratic-equation#p3` —— 精确到某一条易错点
   *   - `junior-math-atlas:m1-02-03-quadratic-equation`        —— 整个来源条目
   *
   * 原因：来源条目（如 atlas 的一篇知识点）往往覆盖多个资产知识点，
   * 只按条目级映射会把整篇的易错点全挂到同一个点上。
   */
  manualMap?: Record<string, string>;
}

export interface MatchSummary {
  total: number;
  byMethod: Record<TrapMatchMethod, number>;
  byConfidence: Record<TrapConfidence, number>;
  unmatched: TrapEntry[];
}

function emptySummary(): MatchSummary {
  return {
    total: 0,
    byMethod: {
      'source-topic': 0,
      'manual-map': 0,
      'exact-name': 0,
      'exact-name-alias': 0,
      'name-contains': 0,
      evidence: 0,
      none: 0,
    },
    byConfidence: { high: 0, medium: 0, low: 0, unmatched: 0 },
    unmatched: [],
  };
}

/**
 * 判断两个条目的学科/学段是否兼容。
 * 候选未声明学科或学段时视为不限制。
 */
function scopeOk(candidate: TrapCandidate, item: KnowledgeIndexItem): boolean {
  if (candidate.subject && candidate.subject !== item.subject) return false;
  if (candidate.stage && candidate.stage !== item.stage) return false;
  return true;
}

/**
 * 名称包含匹配：在名称索引里找互相包含、长度差 < 4 字的候选。
 */
function findContainsMatch(
  candidate: TrapCandidate,
  index: KnowledgeIndex
): KnowledgeIndexItem | null {
  const topicName = candidate.topicName;
  if (!topicName) return null;
  const key = normalizeName(topicName);
  if (!key) return null;

  let best: { item: KnowledgeIndexItem; diff: number } | null = null;

  for (const [nameKey, items] of index.byName) {
    const contains =
      key.includes(nameKey) || nameKey.includes(key);
    if (!contains) continue;
    const diff = Math.abs(key.length - nameKey.length);
    if (diff >= NAME_CONTAINS_MAX_DIFF) continue;

    for (const item of items) {
      if (!scopeOk(candidate, item)) continue;
      if (!best || diff < best.diff) best = { item, diff };
    }
  }

  return best?.item ?? null;
}

/**
 * 主匹配函数：候选 → TrapEntry。
 */
export function matchTrapCandidates(
  candidates: TrapCandidate[],
  index: KnowledgeIndex,
  opts: MatchOptions = {}
): { entries: TrapEntry[]; summary: MatchSummary } {
  const summary = emptySummary();
  const entries: TrapEntry[] = [];

  for (const candidate of candidates) {
    let matched: KnowledgeIndexItem | null = null;
    let method: TrapMatchMethod = 'none';
    let confidence: TrapConfidence = 'unmatched';

    // 1. 人工映射表（先按条目级 `repo:sourceId`，再按 `repo:sourceId#序号` 精确到单条易错点）
    const manualKeys = [`${candidate.sourceRepo}:${candidate.sourceId}`];
    const seq = candidate.id.includes('#')
      ? candidate.id.slice(candidate.id.indexOf('#') + 1)
      : '';
    if (seq) manualKeys.unshift(`${candidate.sourceRepo}:${candidate.sourceId}#${seq}`);

    for (const key of manualKeys) {
      const manualId = opts.manualMap?.[key];
      if (!manualId) continue;
      const item = index.byId.get(manualId);
      if (!item) continue;
      matched = item;
      method = 'manual-map';
      confidence = 'high';
      break;
    }

    // 2. 源项目自带 id
    if (!matched && candidate.sourceTopicId) {
      const item = index.byId.get(candidate.sourceTopicId);
      if (item) {
        matched = item;
        method = 'source-topic';
        confidence = 'high';
      }
    }

    // 2b. 转换器显式给出的匹配置信度提示（英语知识地图 → 主资产点的名称挂载）
    //     提示只在**确实匹配到知识点**时生效，避免「提示 + 未匹配」自相矛盾。
    if (matched && candidate.matchConfidenceHint) {
      confidence = 'high';
      method = 'exact-name-alias';
    }

    // 3. 名称精确匹配
    if (!matched && candidate.topicName) {
      const key = normalizeName(candidate.topicName);
      const items = index.byName.get(key) ?? [];
      const scoped = items.filter((i) => scopeOk(candidate, i));
      if (scoped.length === 1) {
        matched = scoped[0];
        method = 'exact-name';
        confidence = 'high';
      } else if (scoped.length > 1) {
        // 同名多点：学科相同优先，否则视为歧义 → 降级为名称包含
        matched = scoped[0];
        method = 'name-contains';
        confidence = 'medium';
      }
    }

    // 3b. 名称别名精确匹配（次级入口）
    //     cst 与项目知识点用同一套上游命名，但「的」的写法常有差异：
    //       「同分母分数加减法」(cst) ↔ 「同分母分数的加减法」(项目)
    //     因此**两侧都去掉「的」**再比一次，仍要求命中唯一。
    if (!matched && candidate.topicName) {
      const stripped = normalizeName(candidate.topicName).replace(/的/g, '');
      if (stripped) {
        const hits = index.byNameNoDe.get(stripped) ?? [];
        const scoped = hits.filter((i) => scopeOk(candidate, i));
        if (scoped.length === 1) {
          matched = scoped[0];
          method = 'exact-name-alias';
          confidence = 'high';
        }
      }
    }

    // 3c. 转换器显式给出的别名（如手工整理的同义写法）
    if (!matched && candidate.topicAliases?.length) {
      for (const alias of candidate.topicAliases) {
        const aliasKey = normalizeName(alias);
        if (!aliasKey) continue;
        const hits = [
          ...(index.byName.get(aliasKey) ?? []),
          ...(index.byNameNoDe.get(aliasKey.replace(/的/g, '')) ?? []),
        ];
        const scoped = hits.filter((i) => scopeOk(candidate, i));
        if (scoped.length === 1) {
          matched = scoped[0];
          method = 'exact-name-alias';
          confidence = 'high';
          break;
        }
      }
    }

    // 4. 名称包含匹配
    if (!matched) {
      const item = findContainsMatch(candidate, index);
      if (item) {
        matched = item;
        method = 'name-contains';
        confidence = 'medium';
      }
    }

    const subject = candidate.subject || matched?.subject || '';
    const stage = candidate.stage || matched?.stage || '';

    const entry: TrapEntry = {
      id: candidate.id,
      knowledgeId: matched?.id ?? null,
      questionIds: candidate.questionIds ?? [],
      subject,
      stage,
      matchConfidence: confidence,
      matchMethod: method,
      wrong: candidate.wrong,
      why: candidate.why,
      right: candidate.right,
      sourceId: candidate.sourceId,
      ...(candidate.sourceText ? { sourceText: candidate.sourceText } : {}),
    };

    entries.push(entry);
    summary.total++;
    summary.byMethod[method]++;
    summary.byConfidence[confidence]++;
    if (!matched) summary.unmatched.push(entry);
  }

  return { entries, summary };
}
