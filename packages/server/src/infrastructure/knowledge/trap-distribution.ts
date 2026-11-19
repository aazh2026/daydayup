/**
 * 学生的**错因形态分布**统计（服务端聚合）。
 *
 * 回答的问题：学生的失分集中在哪些**具体陷阱形态**上？
 * 这与五维错因（知识/方法/计算/熟练度/审题）是**两条正交的轴**：
 *   - 五维错因来自 AI 诊断，是「错在哪个环节」；
 *   - 陷阱形态来自错因资产（TrapSet），是「错成了什么样子」。
 *
 * 统计口径（务必与实现一致）：
 *   1. 错题记录（ErrorRecord）的 `knowledgeId` → 该知识点在错因资产里的
 *      所有条目（`TrapEntry.wrong`）→ 逐条分类 → **去重计数**：
 *      一道错题在同一形态下只计 1 次（否则一条陷阱挂 3 个知识点会放大 3 倍）。
 *   2. 失分（scoreLost）按形态归集：同一形态下取该错题关联形态的**最大**失分，
 *      避免同一形态重复累加导致失分虚高。
 *   3. 命中不到任何错因条目的错题归入「未匹配错因资产」——
 *      **不丢数据**，让用户看见「这条错题还没有对应的资产化陷阱」。
 */

import type { ErrorRecord } from '@daydayup/contracts';
import { getTrapSets } from './curriculum.ts';
import {
  classifyTrapText,
  listTrapTypes,
  TRAP_TYPE_LABELS,
  type TrapType,
} from './trap-taxonomy.ts';

/** 一条错因条目（聚合用的最小形态）。 */
interface TrapLike {
  knowledgeId: string | null;
  wrong: string;
}

/** 读取生效中的错因资产条目（按知识点 id 归组）。 */
export function collectTrapEntriesByKnowledge(): Map<string, TrapLike[]> {
  const byKnowledge = new Map<string, TrapLike[]>();
  for (const set of getTrapSets()) {
    if (set.status !== 'ACTIVE') continue;
    for (const entry of set.entries) {
      if (!entry.knowledgeId) continue;
      const text = (entry.wrong ?? '').trim();
      if (!text) continue;
      const list = byKnowledge.get(entry.knowledgeId) ?? [];
      list.push({ knowledgeId: entry.knowledgeId, wrong: text });
      byKnowledge.set(entry.knowledgeId, list);
    }
  }
  return byKnowledge;
}

/** 某个错题命中的形态集合（同一形态只算一次）。 */
export function classifyErrorRecordTraps(
  record: Pick<ErrorRecord, 'knowledgeId'>,
  byKnowledge: Map<string, TrapLike[]>
): TrapType[] {
  const entries = byKnowledge.get(record.knowledgeId) ?? [];
  const types = new Set<TrapType>();
  for (const e of entries) {
    types.add(classifyTrapText(e.wrong));
  }
  return [...types];
}

export interface TrapTypeBucket {
  type: TrapType;
  label: string;
  /** 命中该形态的错题数（一道错题在同一形态下只计一次） */
  count: number;
  /** 该形态归集到的失分（同一形态取最大失分，不重复累加） */
  lost: number;
  /** 占全部已归因失分的百分比 */
  pct: number;
  /** 该形态下的代表考点（按失分降序，最多 5 个） */
  topKnowledge: Array<{ knowledgeId: string; knowledgeName: string; count: number; lost: number }>;
}

export interface TrapDistribution {
  /** 参与统计的错题数 */
  totalErrors: number;
  /** 已归因到错因资产的错题数 */
  attributedErrors: number;
  /** 未命中任何错因资产的错题数 */
  unattributedErrors: number;
  /** 已归因失分总额 */
  attributedLost: number;
  /** 未归因失分总额 */
  unattributedLost: number;
  /** 按形态分桶（按 count 降序） */
  buckets: TrapTypeBucket[];
  /** 命中形态最多的错题样例（便于报告页点进去看） */
  samples: Array<{
    errorId: string;
    knowledgeId: string;
    knowledgeName: string;
    types: TrapType[];
    scoreLost: number;
  }>;
}

/**
 * 统计学生的错因形态分布。
 *
 * @param errors 学生的错题记录
 * @param knowledgeNameOf 知识点 id → 名称（用于展示）
 */
export function computeTrapDistribution(
  errors: ErrorRecord[],
  knowledgeNameOf: (knowledgeId: string) => string = (id) => id
): TrapDistribution {
  const byKnowledge = collectTrapEntriesByKnowledge();

  const counts = new Map<TrapType, number>();
  const lostByType = new Map<TrapType, number>();
  const kpAgg = new Map<
    TrapType,
    Map<string, { name: string; count: number; lost: number }>
  >();
  const samples: TrapDistribution['samples'] = [];

  let attributedErrors = 0;
  let unattributedErrors = 0;
  let attributedLost = 0;
  let unattributedLost = 0;

  for (const err of errors) {
    const types = classifyErrorRecordTraps(err, byKnowledge);
    const lost = Number(err.scoreLost ?? 0);

    if (types.length === 0) {
      unattributedErrors++;
      unattributedLost += lost;
      continue;
    }

    attributedErrors++;
    attributedLost += lost;

    for (const type of types) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      // 同一形态只归集一次失分：取该形态下的最大失分
      lostByType.set(type, Math.max(lostByType.get(type) ?? 0, lost));

      // 考点维度的失分是**真实累计**（同一考点的多道错题确实丢了这么多分），
      // 与桶级 lost 的「取最大值」口径不同：后者用于避免跨形态重复累加，
      // 前者用于回答「这个考点一共丢了多少分」。
      const kpMap = kpAgg.get(type) ?? new Map();
      const cur = kpMap.get(err.knowledgeId) ?? {
        name: knowledgeNameOf(err.knowledgeId),
        count: 0,
        lost: 0,
      };
      cur.count++;
      cur.lost += lost;
      kpMap.set(err.knowledgeId, cur);
      kpAgg.set(type, kpMap);
    }

    if (samples.length < 12) {
      samples.push({
        errorId: err.id,
        knowledgeId: err.knowledgeId,
        knowledgeName: knowledgeNameOf(err.knowledgeId),
        types,
        scoreLost: lost,
      });
    }
  }

  const buckets: TrapTypeBucket[] = listTrapTypes()
    .filter((t) => (counts.get(t) ?? 0) > 0)
    .map((type) => {
      const count = counts.get(type) ?? 0;
      const lost = lostByType.get(type) ?? 0;
      const kpMap = kpAgg.get(type) ?? new Map();
      const topKnowledge = [...kpMap.entries()]
        .map(([knowledgeId, v]) => ({
          knowledgeId,
          knowledgeName: v.name,
          count: v.count,
          lost: v.lost,
        }))
        .sort((a, b) => b.lost - a.lost || b.count - a.count)
        .slice(0, 5);
      return {
        type,
        label: TRAP_TYPE_LABELS[type],
        count,
        lost,
        pct: attributedLost > 0 ? Math.round((lost / attributedLost) * 100) : 0,
        topKnowledge,
      };
    })
    .sort((a, b) => b.count - a.count || b.lost - a.lost);

  return {
    totalErrors: errors.length,
    attributedErrors,
    unattributedErrors,
    attributedLost,
    unattributedLost,
    buckets,
    samples,
  };
}
