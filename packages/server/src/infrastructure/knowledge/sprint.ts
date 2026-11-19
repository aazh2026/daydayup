/**
 * 冲刺资产加载器（如「上海中考英语 30 天冲刺」）。
 *
 * 与错因资产、教材对齐资产一致：**只有 ACTIVE 生效**，DRAFT 只告警。
 *
 * 为什么单独一层：
 * - 冲刺资产是**教研资产**（来自实战手册等外部来源），
 *   粒度是「一天做什么、限时多久、做到什么算过关」，不是知识点；
 * - 它需要独立授权与独立下架：手册没授权就只发 DRAFT，不影响主流程；
 * - 冲刺日要落到真实知识点上，因此加载器同时提供
 *   「知识点索引」（主资产 + overlay 叠加层）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SprintSet, Subject } from '@daydayup/contracts';
import { logger } from '../logging/logger.ts';
import { PACKAGED_ASSET_DIRS } from './asset-dirs.ts';
import { getCurriculum } from './curriculum.ts';

/**
 * 冲刺资产目录 / overlay 目录（**惰性解析**）。
 *
 * 不在模块加载时固化路径：测试会在 import 之前设置 `process.env.DATA_DIR`，
 * 模块级常量会在首次 import 时就固定路径，导致「改了环境变量仍读打包资产」。
 */
function sprintDir(): string {
  return PACKAGED_ASSET_DIRS.sprints();
}

function overlayDir(): string {
  return PACKAGED_ASSET_DIRS.overlays();
}

let sprintCache: SprintSet[] | null = null;

/**
 * 读取生效中的冲刺资产。
 *
 * 目录不存在（尚未导入）时返回空数组 —— 缺冲刺资产不应让服务起不来。
 */
export function readSprintSets(): SprintSet[] {
  const dir = sprintDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: SprintSet }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      ) as SprintSet;
      // 形状校验：目录里可能有非资产文件
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.days)) continue;
      readable.push({ file, parsed });
    } catch (err) {
      logger.error('sprint.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const active = readable.filter((r) => r.parsed.status === 'ACTIVE');
  if (active.length > 0) return active.map((r) => r.parsed);

  const drafts = readable.filter((r) => r.parsed.status === 'DRAFT');
  if (drafts.length > 0) {
    logger.warn('sprint.only_draft_assets', { files: drafts.map((d) => d.file) });
  }
  return [];
}

/** 生效中的冲刺资产（无则空数组） */
export function getSprintSets(): SprintSet[] {
  if (!sprintCache) sprintCache = readSprintSets();
  return sprintCache;
}

/**
 * 当前应生效的冲刺资产（无则 null）。
 *
 * 多份 ACTIVE 时取 version 字典序最后一个（版本号字典序即版本序），
 * 保证**同样的磁盘状态 → 同样的结果**（确定性）。
 */
export function getActiveSprintSet(): SprintSet | null {
  const sets = getSprintSets();
  if (sets.length === 0) return null;
  return [...sets].sort((a, b) => (a.version < b.version ? -1 : 1))[sets.length - 1];
}

// ---------------------------------------------------------------------------
// 知识点索引（主资产 + overlay 叠加层）
// ---------------------------------------------------------------------------

/** 冲刺任务用到的最小知识点信息 */
export interface SprintKnowledgeRef {
  id: string;
  name: string;
  subject: Subject;
  domain: string;
  chapter: string;
  commonTraps: string[];
  /** 来自 overlay 叠加层（`cne_wb_*`） */
  fromOverlay: boolean;
}

function toRef(
  kp: {
    id: string;
    name: string;
    subject: Subject;
    domain?: string;
    chapter?: string;
    commonTraps?: string[];
  },
  fromOverlay: boolean
): SprintKnowledgeRef {
  return {
    id: kp.id,
    name: kp.name,
    subject: kp.subject,
    domain: kp.domain ?? '',
    chapter: kp.chapter ?? '',
    commonTraps: Array.isArray(kp.commonTraps) ? kp.commonTraps : [],
    fromOverlay,
  };
}

/**
 * 读取 overlay 叠加层里的知识点。
 *
 * 直接读目录里的 JSON（不依赖 overlay.ts）——
 * overlay 资产可能尚未存在，此时返回空数组。
 * 只有 ACTIVE 的叠加层生效。
 */
function readOverlayKnowledge(): SprintKnowledgeRef[] {
  const dir = overlayDir();
  if (!fs.existsSync(dir)) return [];

  const out: SprintKnowledgeRef[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8')
      ) as {
        status?: string;
        entries?: Array<{
          id: string;
          name: string;
          subject: Subject;
          domain?: string;
          chapter?: string;
          commonTraps?: string[];
        }>;
      };
      if (!parsed || parsed.status !== 'ACTIVE' || !Array.isArray(parsed.entries)) {
        continue;
      }
      for (const entry of parsed.entries) {
        if (!entry?.id) continue;
        out.push(toRef(entry, true));
      }
    } catch (err) {
      logger.error('sprint.overlay_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

let knowledgeIndexCache: Map<string, SprintKnowledgeRef> | null = null;

/**
 * 知识点索引：先查主知识资产，再查 overlay 叠加层。
 *
 * 「先主后 overlay」的原因：主资产是教材单元制知识点，
 * overlay 是缺口领域（音标/听力/写作/阅读策略等）——
 * 同一个 id 不会同时出现在两处（overlay 用独立命名空间 `cne_wb_*`），
 * 但万一重复，主资产优先。
 */
export function getSprintKnowledgeIndex(): Map<string, SprintKnowledgeRef> {
  if (knowledgeIndexCache) return knowledgeIndexCache;

  const index = new Map<string, SprintKnowledgeRef>();

  const curriculum = getCurriculum();
  for (const kp of curriculum.knowledgePoints) {
    index.set(kp.id, toRef(kp, false));
  }
  for (const kp of readOverlayKnowledge()) {
    if (!index.has(kp.id)) index.set(kp.id, kp);
  }

  knowledgeIndexCache = index;
  return index;
}

/** 学科（如「英语」）下的知识点，按 id 排序（确定性） */
export function getSprintKnowledgeBySubject(subject: Subject): SprintKnowledgeRef[] {
  return [...getSprintKnowledgeIndex().values()]
    .filter((kp) => kp.subject === subject)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 清空缓存（测试用：改 DATA_DIR / 资产后需重载） */
export function resetSprintCaches(): void {
  sprintCache = null;
  knowledgeIndexCache = null;
}
