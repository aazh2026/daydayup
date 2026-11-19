/**
 * 错因资产 → 知识点/题目 的覆盖层（纯函数）。
 *
 * 覆盖而非改写：`commonTraps` / `commonErrors` 原本可能已有内容
 * （例如教师手工补的），这里只在末尾追加，不覆盖、不删除。
 *
 * 生效规则：
 *  - 只处理 `knowledgeId` 非空、且 `matchConfidence` 不为 `unmatched` 的条目；
 *  - `medium`（名称包含匹配）默认**不生效** —— 红线：中等置信度必须人工确认，
 *    确认的方式是把它写进 ACTIVE 资产（CLI 用 --allow-medium 才会写入）。
 *    但为保险，覆盖层仍按资产里实际存在的条目生效 —— ACTIVE 资产本身
 *    就是「人工确认过」的产物。
 */

import type { TrapEntry, TrapSet } from '@daydayup/contracts';

export interface OverlayTargetKnowledgePoint {
  id: string;
  commonTraps: string[];
}

export interface OverlayTargetQuestion {
  id: string;
  commonErrors: string[];
}

/**
 * 把三段式压成一行文本。
 *
 * 形如：`把符号「-」当成「负」的标签（忽略了它在这里是「取相反数」的运算）→ 先看 a 是什么数`
 */
export function formatTrapText(entry: {
  wrong: string;
  why: string;
  right: string;
}): string {
  const wrong = entry.wrong.trim();
  const why = entry.why.trim();
  const right = entry.right.trim();

  if (wrong && why && right) return `${wrong}（${why}）→ ${right}`;
  if (wrong && why) return `${wrong}（${why}）`;
  if (wrong && right) return `${wrong} → ${right}`;
  if (wrong) return wrong;
  if (why && right) return `${why} → ${right}`;
  return why || right;
}

export interface OverlayResult {
  /** 挂到知识点上的条目数 */
  knowledgeTraps: number;
  /** 挂到题目上的条目数 */
  questionErrors: number;
  /** 因为没有知识点 id 而未生效的条目数 */
  skippedUnmatched: number;
  /** 受影响的知识点 id */
  affectedKnowledgeIds: string[];
}

/**
 * 把 TrapSet 覆盖到知识点与题目上。
 *
 * @param knowledgePoints 知识点数组（原地修改 commonTraps）
 * @param questions 题目数组（原地修改 commonErrors）
 * @param sets 生效中的错因资产（通常只有 ACTIVE 版本）
 */
export function applyTrapSets(
  knowledgePoints: OverlayTargetKnowledgePoint[],
  questions: OverlayTargetQuestion[],
  sets: TrapSet[]
): OverlayResult {
  const result: OverlayResult = {
    knowledgeTraps: 0,
    questionErrors: 0,
    skippedUnmatched: 0,
    affectedKnowledgeIds: [],
  };

  const kpById = new Map(knowledgePoints.map((kp) => [kp.id, kp]));
  const qById = new Map(questions.map((q) => [q.id, q]));
  const affected = new Set<string>();

  for (const set of sets) {
    if (set.status !== 'ACTIVE') continue;

    for (const entry of set.entries) {
      if (!entry.knowledgeId && entry.questionIds.length === 0) {
        result.skippedUnmatched++;
        continue;
      }

      const text = formatTrapText(entry);
      if (!text) {
        result.skippedUnmatched++;
        continue;
      }

      if (entry.knowledgeId) {
        const kp = kpById.get(entry.knowledgeId);
        if (kp && !kp.commonTraps.includes(text)) {
          kp.commonTraps.push(text);
          result.knowledgeTraps++;
          affected.add(kp.id);
        }
      }

      for (const qid of entry.questionIds) {
        const q = qById.get(qid);
        if (q && !q.commonErrors.includes(text)) {
          q.commonErrors.push(text);
          result.questionErrors++;
        }
      }
    }
  }

  result.affectedKnowledgeIds = [...affected];
  return result;
}
