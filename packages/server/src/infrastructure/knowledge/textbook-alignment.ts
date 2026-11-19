/**
 * 教材对齐资产加载器（上海本地课本落点）。
 *
 * 为什么单独一层：
 * - 知识资产的 `chapter` 来自人教版章节体系，而上海中考用沪教版数学、
 *   译林版英语 —— 排课与诊断必须报学生手上课本的章节；
 * - 教材对齐只存「知识点 → 课本落点」，不复制知识点本体，
 *   换课本版本时只重导这一层，不必重导 2760 个知识点。
 *
 * 与错因资产一致：**只有 ACTIVE 生效**，DRAFT 只告警。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgePoint, TextbookAlignmentSet, TextbookRef } from '@daydayup/contracts';
import { logger } from '../logging/logger.ts';
import { PACKAGED_ASSET_DIRS } from './asset-dirs.ts';

const ALIGNMENT_DIR = PACKAGED_ASSET_DIRS.curriculum;

let alignmentCache: TextbookAlignmentSet[] | null = null;

/**
 * 读取生效中的教材对齐资产。
 *
 * 目录不存在（尚未导入）时返回空数组 —— 缺教材对齐不应让服务起不来。
 */
export function readTextbookAlignmentSets(): TextbookAlignmentSet[] {
  const dir = ALIGNMENT_DIR();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: TextbookAlignmentSet }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      ) as TextbookAlignmentSet;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) continue;
      readable.push({ file, parsed });
    } catch (err) {
      logger.error('textbook.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const active = readable.filter((r) => r.parsed.status === 'ACTIVE');
  if (active.length > 0) return active.map((r) => r.parsed);

  const drafts = readable.filter((r) => r.parsed.status === 'DRAFT');
  if (drafts.length > 0) {
    logger.warn('textbook.only_draft_assets', { files: drafts.map((d) => d.file) });
  }
  return [];
}

/** 生效中的教材对齐资产（无则空数组） */
export function getTextbookAlignmentSets(): TextbookAlignmentSet[] {
  if (!alignmentCache) alignmentCache = readTextbookAlignmentSets();
  return alignmentCache;
}

/** 上海本地教材（学生手上课本）优先 */
const SHANGHAI_EDITIONS = ['hujiao_math', 'yilin_english'];

/**
 * 知识点 id → 课本落点。
 *
 * 多个来源指向同一知识点时，**上海本地教材优先**
 * （苏教/山东五四制只作跨版本参考，不能盖掉沪教版落点）。
 */
export function getTextbookMap(): Record<string, TextbookRef> {
  const map: Record<string, TextbookRef> = {};
  const preferred: Record<string, TextbookRef> = {};

  for (const set of getTextbookAlignmentSets()) {
    for (const entry of set.entries) {
      const isShanghai = SHANGHAI_EDITIONS.includes(entry.textbook.editionKey);
      if (isShanghai) {
        if (!preferred[entry.knowledgeId]) preferred[entry.knowledgeId] = entry.textbook;
      } else if (!map[entry.knowledgeId]) {
        map[entry.knowledgeId] = entry.textbook;
      }
    }
  }

  return { ...map, ...preferred };
}

/**
 * 把教材落点写回知识点（就地修改）。
 *
 * 纯函数语义上不成立（改了入参），但资产加载只做一次，
 * 避免为 2760 个知识点额外分配一份副本。
 */
export function applyTextbookAlignment(
  knowledgePoints: KnowledgePoint[],
  map: Record<string, TextbookRef>
): { aligned: number; missing: string[] } {
  const missing: string[] = [];
  let aligned = 0;

  for (const kp of knowledgePoints) {
    const ref = map[kp.id];
    if (!ref) {
      // 只留样本：未对齐是常态（人教版章节体系下大部分点无上海课本落点），
      // 全量收集会制造 2000+ 条噪音。
      if (missing.length < 20) missing.push(kp.id);
      continue;
    }
    kp.textbook = ref;
    aligned++;
  }

  return { aligned, missing };
}
