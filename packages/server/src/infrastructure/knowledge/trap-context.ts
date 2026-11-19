/**
 * 出题/教练场景的错因兜底（服务端）。
 *
 * 背景：前端在生成变式题时会把自己的 `commonTraps` 传上来，
 * 但有两个漏洞：
 *
 * 1. **前端不传就没有**：任何直接调 `/api/v1/practice/generate` 的调用方
 *    （家长端 App、脚本、教师批改工具）拿不到任何错因，
 *    生成的题目也就不会针对学生的真实易错点做变式。
 * 2. **题目级错因完全没接进 prompt**：题库里的 `commonErrors`
 *    （如「不要把圆加进去」）是**题目**维度的错因，
 *    比知识点维度的更贴近这道题，但服务端从来没把它喂给模型。
 *
 * 本模块负责在服务端把这两层错因补齐：
 *   - 知识点维度：`getCurriculum()` 里知识点的 `commonTraps`
 *   - 题目维度：题库题目的 `commonErrors`
 */

import { getCurriculum, getQuestionBank } from './curriculum.ts';

/** 取知识点的错因（commonTraps）。知识点不存在时返回空数组。 */
export function getKnowledgeTraps(knowledgeId?: string | null): string[] {
  if (!knowledgeId) return [];
  const kp = getCurriculum().knowledgePoints.find((k) => k.id === knowledgeId);
  return kp?.commonTraps ?? [];
}

/**
 * 取「与该知识点相关」的题目级错因。
 *
 * 题库题目通过 `knowledgeId` 关联知识点；取不到时按题干关键词命中。
 * 最多返回 `limit` 条，避免提示词被无关错因撑爆。
 */
export function getQuestionTraps(
  knowledgeId?: string | null,
  limit = 3
): string[] {
  const bank = getQuestionBank();
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (text: string) => {
    const t = text.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  if (knowledgeId) {
    for (const q of bank.questions) {
      if (!(q.knowledgeIds ?? []).includes(knowledgeId)) continue;
      for (const e of q.commonErrors ?? []) push(e);
      if (out.length >= limit) break;
    }
  }

  return out.slice(0, limit);
}

/**
 * 合并前端传入与服务端兜底的错因。
 *
 * 规则：**前端传的在前**（那是调用方明确指定的语境），
 * 服务端补的知识点/题目错因在后，且去重。
 */
export function mergeTraps(
  frontendTraps: string[] | undefined,
  knowledgeId?: string | null,
  opts: { includeQuestionTraps?: boolean; limit?: number } = {}
): string[] {
  const limit = opts.limit ?? 8;
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (text: string) => {
    const t = text.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const t of frontendTraps ?? []) push(t);
  for (const t of getKnowledgeTraps(knowledgeId)) push(t);
  if (opts.includeQuestionTraps !== false) {
    for (const t of getQuestionTraps(knowledgeId, limit)) push(t);
  }

  return out.slice(0, limit);
}
