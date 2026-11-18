/**
 * 测试辅助：从**当前生效的知识资产**里取样。
 *
 * 为什么需要
 * ----------
 * 换版前测试直接写死 `math-alg-rational` / `math-eq-ineq` 这类人工 id。
 * 2026.02 版资产把这些换成了教材小节 id（`cnm_165` 等），于是：
 *
 *   - 依赖先修关系的测试找不到先修边 → 断言恒真（**静默失效**）
 *   - 取题测试查不到知识点 → 直接失败（噪音）
 *
 * 两种情况都不是我们想验证的东西。测试要验证的是**引擎行为**，
 * 不是「资产里恰好有某个 id」。所以统一从这里按**结构特征**取样：
 * 「有先修边的点」「没有先修边的点」「题库里有基础题的点」。
 *
 * 这样换资产版本时，测试继续验证同一套行为。
 */
import type { KnowledgePoint } from '@daydayup/contracts';
import {
  getCurriculum,
  getKnowledgeMap,
  getQuestionBank,
} from '../../src/infrastructure/knowledge/curriculum.ts';

/** 当前资产的全部知识点（按资产顺序） */
export function allPoints(): KnowledgePoint[] {
  return getCurriculum().knowledgePoints;
}

/**
 * 取若干**没有先修依赖**的知识点。
 *
 * 用它们当「可直接开工」的样本：不会被 `blockedByPrerequisite` 降权，
 * 适合验证排期/预算这类与先修无关的约束。
 */
export function pickUnblockedKnowledge(
  count = 1,
  subject?: KnowledgePoint['subject']
): KnowledgePoint[] {
  const picked = allPoints().filter(
    (kp) =>
      kp.prerequisites.length === 0 && (!subject || kp.subject === subject)
  );
  if (picked.length < count) {
    throw new Error(
      `当前资产只有 ${picked.length} 个无先修知识点${
        subject ? `（${subject}）` : ''
      }，不足 ${count} 个`
    );
  }
  return picked.slice(0, count);
}

/**
 * 取一对真实的「目标 ← 先修」。
 *
 * 先修必须真实存在于资产中，否则引擎查不到它的掌握度，
 * 测出来的是"悬空引用"而不是"先修锁定"。
 */
export function pickPrerequisitePair(): {
  target: KnowledgePoint;
  prereq: KnowledgePoint;
} {
  const map = getKnowledgeMap();
  for (const kp of allPoints()) {
    for (const preId of kp.prerequisites) {
      const prereq = map[preId];
      if (prereq && prereq.id !== kp.id) return { target: kp, prereq };
    }
  }
  throw new Error('当前知识资产没有任何先修边，无法验证先修锁定');
}

/** 取一个有指定难度题目的知识点 id（用于题库取题测试） */
export function pickKnowledgeWithLevel(level: string): string {
  const hit = getQuestionBank().questions.find(
    (q) => q.level === level && q.knowledgeIds.length > 0
  );
  if (!hit) throw new Error(`题库里没有 ${level} 题目`);
  return hit.knowledgeIds[0];
}
