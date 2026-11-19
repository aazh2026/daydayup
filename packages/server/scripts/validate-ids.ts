/**
 * id 收敛校验脚本。
 *
 * 运行：
 *   npm run validate:ids --workspace=@daydayup/server
 *   npm run validate:ids --workspace=@daydayup/server -- --json
 *
 * ── 检查什么 ──────────────────────────────────────────────────────────
 *
 * 项目主键只有一种形态（`cnm_* / cne_* / cnc_* / cnp_* / cnk_*`）。
 * 任何资产里出现外部 id（`cnm_ext_*` / `mt_*` / `m1-*` / `01.01.01.01`），
 * 都意味着**外部 id 混进了主键位**。
 *
 * 后果不是报错，而是静默失效：
 * - 掌握度记录挂不上知识点 → 学生「什么都没学过」；
 * - 错因挂不上去 → AI 教练说教没有针对性；
 * - 排课查不到点 → 计划里少任务。
 *
 * 所以这条检查是**闸门**：非零退出码 = 资产不合法，不能发布。
 *
 * ── 检查范围 ──────────────────────────────────────────────────────────
 *
 * - knowledge/  知识点 id 本身 + prerequisites
 * - questions/  题目的 knowledgeIds
 * - traps/      错因条目的 knowledgeId
 * - overlays/   叠加层的 id + prerequisites + relatedKnowledgeIds
 * - ids/        别名表的键必须是外部 id、值必须是原生 id
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isExternalId,
  isNativeKnowledgeId,
  subjectOfNativeId,
} from '../src/infrastructure/knowledge/id-namespace.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data');

interface Violation {
  file: string;
  where: string;
  id: string;
  reason: string;
}

const violations: Violation[] = [];
const stats = { knowledgePoints: 0, questions: 0, traps: 0, overlayEntries: 0, aliases: 0 };

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    violations.push({
      file: path.relative(DATA_DIR, file),
      where: '-',
      id: '-',
      reason: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

function listJson(dirName: string): string[] {
  const dir = path.join(DATA_DIR, dirName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function checkNativeId(
  file: string,
  where: string,
  id: string,
  expectSubject?: string
): void {
  if (!id) return;
  if (isExternalId(id)) {
    violations.push({ file, where, id, reason: '外部 id 出现在主键位' });
    return;
  }
  if (!isNativeKnowledgeId(id)) {
    violations.push({ file, where, id, reason: '不符合项目原生 id 形态' });
    return;
  }
  if (expectSubject) {
    const subject = subjectOfNativeId(id);
    if (subject && subject !== expectSubject) {
      violations.push({
        file,
        where,
        id,
        reason: `学科前缀与所属学科不一致（${subject} ≠ ${expectSubject}）`,
      });
    }
  }
}

function checkKnowledge(): void {
  for (const file of listJson('knowledge')) {
    const rel = path.relative(DATA_DIR, file);
    const parsed = readJson(file) as
      | { knowledgePoints?: Array<{ id: string; subject?: string; prerequisites?: string[] }> }
      | null;
    for (const kp of parsed?.knowledgePoints ?? []) {
      stats.knowledgePoints++;
      checkNativeId(rel, 'knowledgePoints[].id', kp.id, kp.subject);
      for (const pre of kp.prerequisites ?? []) {
        checkNativeId(rel, `knowledgePoints[${kp.id}].prerequisites`, pre);
      }
    }
  }
}

function checkQuestions(): void {
  for (const file of listJson('questions')) {
    const rel = path.relative(DATA_DIR, file);
    const parsed = readJson(file) as
      | { questions?: Array<{ id: string; knowledgeIds?: string[] }> }
      | null;
    for (const q of parsed?.questions ?? []) {
      stats.questions++;
      for (const kid of q.knowledgeIds ?? []) {
        checkNativeId(rel, `questions[${q.id}].knowledgeIds`, kid);
      }
    }
  }
}

function checkTraps(): void {
  for (const file of listJson('traps')) {
    const rel = path.relative(DATA_DIR, file);
    const parsed = readJson(file) as
      | { entries?: Array<{ id: string; knowledgeId: string | null }> }
      | null;
    for (const e of parsed?.entries ?? []) {
      stats.traps++;
      if (e.knowledgeId) checkNativeId(rel, `entries[${e.id}].knowledgeId`, e.knowledgeId);
    }
  }
}

function checkOverlays(): void {
  for (const file of listJson('overlays')) {
    const rel = path.relative(DATA_DIR, file);
    const parsed = readJson(file) as
      | {
          entries?: Array<{
            id: string;
            subject?: string;
            prerequisites?: string[];
            relatedKnowledgeIds?: string[];
          }>;
        }
      | null;
    for (const e of parsed?.entries ?? []) {
      stats.overlayEntries++;
      checkNativeId(rel, 'entries[].id', e.id, e.subject);
      for (const pre of e.prerequisites ?? []) {
        checkNativeId(rel, `entries[${e.id}].prerequisites`, pre);
      }
      for (const rel2 of e.relatedKnowledgeIds ?? []) {
        checkNativeId(rel, `entries[${e.id}].relatedKnowledgeIds`, rel2);
      }
    }
  }
}

function checkAliases(): void {
  for (const file of listJson('ids')) {
    const rel = path.relative(DATA_DIR, file);
    const parsed = readJson(file) as
      | { aliases?: Record<string, { targets: string[] }> }
      | null;
    for (const [externalId, entry] of Object.entries(parsed?.aliases ?? {})) {
      stats.aliases++;
      if (!isExternalId(externalId)) {
        violations.push({
          file: rel,
          where: 'aliases',
          id: externalId,
          reason: '别名键必须是外部 id',
        });
      }
      for (const t of entry.targets ?? []) {
        checkNativeId(rel, `aliases[${externalId}].targets`, t);
      }
    }
  }
}

checkKnowledge();
checkQuestions();
checkTraps();
checkOverlays();
checkAliases();

const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(
    JSON.stringify({ stats, violations }, null, 2)
  );
} else {
  console.log('│  id 收敛校验');
  console.log(
    `│    知识点 ${stats.knowledgePoints} · 题目 ${stats.questions} · 错因 ${stats.traps} · 叠加层 ${stats.overlayEntries} · 别名 ${stats.aliases}`
  );
  if (violations.length === 0) {
    console.log('│    ✓ 未发现外部 id 混入主键位');
  } else {
    console.log(`│    ✗ ${violations.length} 处违规：`);
    for (const v of violations.slice(0, 30)) {
      console.log(`│        ${v.file} · ${v.where} · ${v.id} —— ${v.reason}`);
    }
    if (violations.length > 30) {
      console.log(`│        ...（其余 ${violations.length - 30} 处省略）`);
    }
  }
}

process.exit(violations.length === 0 ? 0 : 1);
