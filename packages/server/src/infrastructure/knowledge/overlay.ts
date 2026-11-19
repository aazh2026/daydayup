/**
 * 知识叠加层（overlay）加载器。
 *
 * ── 这一层解决什么问题 ────────────────────────────────────────────────
 *
 * 主知识资产（2760 个知识点）按**教材单元**组织，`chapter` 就是人教版/沪教版
 * 章节。但有些应试点型根本不属于任何教材单元：
 *
 * - 音标与语音语调（语音基础）
 * - 听力技巧、朗读与口语交际
 * - 中考题型应试策略（首字母填空三步法、概括题要点）
 * - 写作提分要点（应用文格式、书信邮件）
 *
 * 这些内容要进知识体系，但**不能**硬塞进 `chapter`（会污染章节体系），
 * 也不值得重导整个主资产（2760 条要重新审核）。
 *
 * 于是走 overlay 层：独立 id 命名空间（`cne_wb_*`）+ 独立资产目录，
 * 由本模块在加载期合并进知识体系。overlay 资产可以单独下架/回滚。
 *
 * 与教材对齐、错因资产一致：**只有 ACTIVE 生效**，DRAFT 只告警。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeOverlaySet, KnowledgePoint } from '@daydayup/contracts';
import { logger } from '../logging/logger.ts';
import { PACKAGED_ASSET_DIRS, PACKAGED_DATA_DIR, resolveDataDir } from './asset-dirs.ts';

/**
 * 解析 overlay 资产目录。
 *
 * 规则（比 asset-dirs 的通用回落更严格）：
 * 1. `DATA_DIR/overlays` 里有 .json → 用它；
 * 2. 否则**只有当生效的知识体系就是打包知识体系时**才回落到打包 overlay 目录；
 * 3. 否则返回 `DATA_DIR/overlays`（通常不存在 → 视为没有 overlay）。
 *
 * 为什么第 2 条要额外判断：overlay 条目与知识体系版本是**强绑定**的
 * （`cne_wb_*` 是为 `shanghai-junior-taxonomy-2026.02` 写的）。
 * 把打包 overlay 混进一份自定义知识体系，会凭空多出几百个知识点 ——
 * 这正是 curriculum-loader.test.ts「自定义 DATA_DIR 优先用之」用例要挡的事。
 */
function resolveOverlayDir(): string {
  const override = path.join(resolveDataDir(), 'overlays');
  if (
    fs.existsSync(override) &&
    fs.readdirSync(override).some((f) => f.endsWith('.json'))
  ) {
    return override;
  }
  const packagedKnowledge = path.join(PACKAGED_DATA_DIR, 'knowledge');
  if (PACKAGED_ASSET_DIRS.knowledge() === packagedKnowledge) {
    return path.join(PACKAGED_DATA_DIR, 'overlays');
  }
  return override;
}

/**
 * 读取生效中的知识叠加层资产。
 *
 * 规则（与教材对齐一致）：
 * 1. 目录不存在（尚未导入）→ 返回空数组（缺 overlay 不应让服务起不来）；
 * 2. 只加载 `status === 'ACTIVE'` 的文件；
 * 3. 没有 ACTIVE 但存在 DRAFT → `logger.warn('overlay.only_draft_assets')`。
 *
 * 注意：目录路径**每次调用时求解**（不缓存），与 asset-dirs 的约定一致 ——
 * 测试会在 import 之前改 `DATA_DIR`。
 */
export function readActiveOverlaySets(): KnowledgeOverlaySet[] {
  const dir = resolveOverlayDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: KnowledgeOverlaySet }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      ) as KnowledgeOverlaySet;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) continue;
      readable.push({ file, parsed });
    } catch (err) {
      logger.error('overlay.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const active = readable.filter((r) => r.parsed.status === 'ACTIVE');
  if (active.length > 0) return active.map((r) => r.parsed);

  const drafts = readable.filter((r) => r.parsed.status === 'DRAFT');
  if (drafts.length > 0) {
    logger.warn('overlay.only_draft_assets', { files: drafts.map((d) => d.file) });
  }
  return [];
}

/**
 * 把 overlay 条目转成知识点，追加到知识点列表尾部。
 *
 * - **id 冲突跳过**：主资产已有同 id 时不覆盖（主资产优先）；
 * - **prerequisites 收敛**：只保留能在「合并后集合」里解析到的 id，
 *   悬空前置引用会让提分优先级算错（见 curriculum-assets.test.ts）。
 *
 * 返回新数组（不改入参）。
 */
export function applyKnowledgeOverlays(points: KnowledgePoint[]): KnowledgePoint[] {
  const sets = readActiveOverlaySets();
  if (sets.length === 0) return points;

  const merged: KnowledgePoint[] = [...points];
  const existingIds = new Set(points.map((p) => p.id));
  let added = 0;
  let skipped = 0;

  for (const set of sets) {
    for (const entry of set.entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      if (existingIds.has(entry.id)) {
        skipped++;
        continue;
      }

      merged.push({
        id: entry.id,
        subject: entry.subject,
        chapter: entry.chapter,
        domain: entry.domain,
        name: entry.name,
        subSkills: [...(entry.subSkills ?? [])],
        definition: entry.definition,
        prerequisites: [...(entry.prerequisites ?? [])],
        commonExamForms: [...(entry.commonExamForms ?? [])],
        commonTraps: [...(entry.commonTraps ?? [])],
        examWeight: entry.examWeight,
        learningCostHours: entry.learningCostHours,
      });
      existingIds.add(entry.id);
      added++;
    }
  }

  // 前置引用只保留能解析到的 id（合并后的全集）
  const resolvable = new Set(merged.map((p) => p.id));
  let dangling = 0;
  for (const kp of merged) {
    const before = kp.prerequisites.length;
    kp.prerequisites = kp.prerequisites.filter((p) => resolvable.has(p));
    dangling += before - kp.prerequisites.length;
  }

  logger.info('overlay.overlay_applied', {
    sets: sets.length,
    added,
    skipped,
    danglingPrerequisites: dangling,
    total: merged.length,
  });

  return merged;
}
