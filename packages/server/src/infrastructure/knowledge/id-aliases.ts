/**
 * 外部 id → 项目原生 id 的解析层。
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *
 * 项目主键只有一种形态（见 `id-namespace.ts`）：`cnm_* / cne_* / cnc_* / cnp_* / cnk_*`。
 * 但外部数据里仍会出现旧 id：
 *
 * - cn-mt 的 `cnm_ext_001..018`（已从 topics.json 删除的历史外节点）；
 * - china-skill-taxonomy 的 `mt_*`；
 * - junior-math-atlas 的 `m1-00-03-*`；
 * - workbuddy 的 `01.01.01.01`。
 *
 * 这些 id **只能做映射**。但旧链接（`?target=cnm_ext_002`）、旧截图、
 * 老师手里的资料都还带着它们，所以服务端要能**解析**外部 id，
 * 而不是让它们进入主键。
 *
 * ── 行为 ──────────────────────────────────────────────────────────────
 *
 * `resolveKnowledgeId(id)`：
 * - 已是原生 id → 原样返回（命中自身）；
 * - 是外部 id 且有别名映射 → 返回映射到的原生 id 列表；
 * - 是外部 id 但无映射 → 返回空数组（**不猜**）。
 *
 * 无映射时返回空而不是回退到「按名字模糊匹配」，是因为模糊匹配会把
 * 一个不存在的知识点变成另一个知识点 —— 静默错挂比明确失败更危险。
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.ts';
import { PACKAGED_ASSET_DIRS } from './asset-dirs.ts';
import { isNativeKnowledgeId } from './id-namespace.ts';

export interface IdAliasSet {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  source: {
    repo: string;
    path: string;
    license: string;
    licenseUrl?: string;
    note?: string;
  };
  aliases: Record<
    string,
    {
      name?: string;
      /** 映射到的项目原生 id（可多个） */
      targets: string[];
    }
  >;
}

const ALIAS_DIR = PACKAGED_ASSET_DIRS.ids;
const ALIAS_FILE = 'id-aliases.json';

let aliasCache: Map<string, string[]> | null = null;

function readAliasSets(): IdAliasSet[] {
  const dir = ALIAS_DIR();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f === ALIAS_FILE || f.startsWith('id-aliases-'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: IdAliasSet[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      ) as IdAliasSet;
      if (parsed && parsed.aliases && typeof parsed.aliases === 'object') {
        out.push(parsed);
      }
    } catch (err) {
      logger.error('alias.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** 生效中的别名表：外部 id → 原生 id 列表 */
export function getAliasMap(): Map<string, string[]> {
  if (aliasCache) return aliasCache;
  const map = new Map<string, string[]>();
  for (const set of readAliasSets()) {
    if (set.status !== 'ACTIVE') continue;
    for (const [externalId, entry] of Object.entries(set.aliases)) {
      const targets = (entry.targets ?? []).filter((t) => isNativeKnowledgeId(t));
      if (targets.length === 0) continue;
      const existing = map.get(externalId) ?? [];
      map.set(externalId, [...new Set([...existing, ...targets])]);
    }
  }
  aliasCache = map;
  return map;
}

/**
 * 解析单个 id → 项目原生 id 列表。
 *
 * - 原生 id → `[id]`
 * - 有别名的外部 id → 别名目标列表
 * - 无解 → `[]`
 */
export function resolveKnowledgeId(id: string): string[] {
  if (!id) return [];
  if (isNativeKnowledgeId(id)) return [id];
  return getAliasMap().get(id) ?? [];
}

/**
 * 批量解析：保留顺序、去重；无解的 id 单独返回（供接口告知调用方）。
 */
export function resolveKnowledgeIds(ids: string[]): {
  resolved: string[];
  unresolved: string[];
} {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const targets = resolveKnowledgeId(id);
    if (targets.length === 0) {
      unresolved.push(id);
      continue;
    }
    for (const t of targets) {
      if (seen.has(t)) continue;
      seen.add(t);
      resolved.push(t);
    }
  }
  return { resolved, unresolved };
}

/** 仅测试用：清缓存 */
export function resetAliasCache(): void {
  aliasCache = null;
}
