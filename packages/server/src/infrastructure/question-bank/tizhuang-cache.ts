/**
 * 题庄题目本地缓存层。
 *
 * ── 为什么必须有 ──────────────────────────────────────────────────────────
 *
 * 匿名试用每天只有 50 题，已注册账号 150 题。同一批题反复在线拉取会
 * 在几天内把配额烧光，而且「拉一次」和「答一次」不是一一对应的——
 * 用户可能只看知识点列表就走了。所以：
 *
 * 1. **缓存优先**：路由默认先读本地缓存，缓存够用就不发在线请求；
 * 2. **按 externalId 去重**：同一道真题重复拉取只写一次；
 * 3. **缓存文件独立目录**：写在 `data/tizhuang/`，不污染
 *    `data/questions/`（项目自有题库）和其他资产目录。
 *
 * 缓存文件格式（`data/tizhuang/questions-<subject>.json`）：
 * ```json
 * {
 *   "version": 1,
 *   "subject": "英语",
 *   "fetchedAt": "2026-11-19T10:00:00.000Z",
 *   "items": [
 *     {
 *       "externalId": 2826735,
 *       "stem": "...",
 *       "options": ["A. Both，and"],
 *       "answer": "C",
 *       "analysis": "...",
 *       "questionType": "选择题",
 *       "difficulty": 3,
 *       "year": 2014,
 *       "source": "2014•仁寿县校级模拟",
 *       "paperType": "32",
 *       "knowledgeNames": ["并列连词"],
 *       "autoGradable": true,
 *       "hasImages": false,
 *       "imageUrls": [],
 *       "knowledgeIds": ["cne_wb_02_05_01_01"],
 *       "fetchedAt": "2026-11-19T10:00:00.000Z"
 *     }
 *   ]
 * }
 * ```
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../knowledge/asset-dirs.ts';
import type { TizhuangQuestion } from './tizhuang.ts';

export const TIZHUANG_CACHE_VERSION = 1;

/** 缓存里的题目 = 题庄题目 + 映射后的项目原生知识点 id */
export interface CachedTizhuangQuestion extends TizhuangQuestion {
  /** 映射后的项目原生知识点 id（可为空数组 = 未能映射） */
  knowledgeIds: string[];
  /** 首次入库时间 */
  fetchedAt: string;
}

export interface TizhuangCacheFile {
  version: number;
  subject: string;
  fetchedAt: string;
  items: CachedTizhuangQuestion[];
}

/** 缓存目录（`<DATA_DIR>/tizhuang/`），与项目自有题库目录分开 */
export function tizhuangCacheDir(): string {
  return path.join(resolveDataDir(), 'tizhuang');
}

/** 某个学科的缓存文件路径 */
export function tizhuangCacheFile(subject: string): string {
  return path.join(tizhuangCacheDir(), `questions-${subject}.json`);
}

/**
 * 读取缓存。文件不存在或损坏时返回空结构（不抛错——缓存坏了不该让功能挂掉）。
 */
export function readCachedQuestions(subject: string): TizhuangCacheFile {
  const file = tizhuangCacheFile(subject);
  const empty: TizhuangCacheFile = {
    version: TIZHUANG_CACHE_VERSION,
    subject,
    fetchedAt: new Date(0).toISOString(),
    items: [],
  };
  try {
    if (!fs.existsSync(file)) return empty;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TizhuangCacheFile;
    if (!parsed || !Array.isArray(parsed.items)) return empty;
    return {
      version: parsed.version ?? TIZHUANG_CACHE_VERSION,
      subject: parsed.subject ?? subject,
      fetchedAt: parsed.fetchedAt ?? empty.fetchedAt,
      items: parsed.items,
    };
  } catch {
    return empty;
  }
}

/**
 * 写入缓存。同一 externalId 只保留一条（后来者覆盖先前者，刷新解析结果）。
 *
 * @param subject 学科名（文件名的一部分）
 * @param items   新抓到的题（knowledgeIds 由调用方填好）
 * @returns 写入后的完整缓存
 */
export function upsertQuestions(
  subject: string,
  items: CachedTizhuangQuestion[]
): TizhuangCacheFile {
  const existing = readCachedQuestions(subject);
  const byId = new Map<number, CachedTizhuangQuestion>();
  for (const item of existing.items) {
    if (typeof item?.externalId === 'number') byId.set(item.externalId, item);
  }
  for (const item of items) {
    if (!item || typeof item.externalId !== 'number') continue;
    byId.set(item.externalId, item);
  }

  const merged: TizhuangCacheFile = {
    version: TIZHUANG_CACHE_VERSION,
    subject,
    fetchedAt: new Date().toISOString(),
    items: [...byId.values()].sort((a, b) => a.externalId - b.externalId),
  };

  try {
    fs.mkdirSync(tizhuangCacheDir(), { recursive: true });
    fs.writeFileSync(
      tizhuangCacheFile(subject),
      JSON.stringify(merged, null, 2),
      'utf8'
    );
  } catch {
    // 写盘失败不抛：在线结果仍可返回，只是下次还得再拉一次
  }
  return merged;
}

/**
 * 从缓存里挑出命中某个原生知识点 id 的题。
 *
 * @param limit 最多返回多少道；0 或负数表示不限
 */
export function selectCachedByKnowledge(
  subject: string,
  knowledgeId: string,
  limit = 0
): CachedTizhuangQuestion[] {
  const { items } = readCachedQuestions(subject);
  const hit = items.filter((item) =>
    (item.knowledgeIds ?? []).includes(knowledgeId)
  );
  return limit > 0 ? hit.slice(0, limit) : hit;
}

/** 缓存里是否已有该知识点的足够题目（用于「缓存优先」的判定） */
export function hasEnoughCached(
  subject: string,
  knowledgeId: string,
  limit: number
): boolean {
  if (limit <= 0) return false;
  return selectCachedByKnowledge(subject, knowledgeId, limit).length >= limit;
}
