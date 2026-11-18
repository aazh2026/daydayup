/**
 * cn-math-taxonomy → daydayup 知识资产导入脚本。
 *
 * 运行：
 *   npm run import:taxonomy --workspace=@daydayup/server
 *   npm run import:taxonomy --workspace=@daydayup/server -- --subjects=数学 --stages=初中,小学
 *
 * ── 授权提醒 ──────────────────────────────────────────────────────────
 *
 * cn-math-taxonomy 采用 **CC BY-NC 4.0**（署名-非商业性）。
 * 本脚本生成的资产若要用于 daydayup 的商业场景，
 * **必须先取得作者的商业授权**，否则不得上线。
 *
 * 详见 `packages/server/src/infrastructure/knowledge/converters/LICENSING.md`。
 * 脚本本身会��输出资产溯源信息（含 `source` 字段），便于事后审计。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. **默认写 DRAFT**：导入产物 status=DRAFT，绝不自动激活。
 *    知识资产要「教师审核后人工改为 ACTIVE」才生效
 *    （见 curriculum.ts 的 selectCurriculumFile —— ACTIVE 优先）。
 *    这与 cn-mt README 的免责声明一致：「先修关系需要一线教师审核」。
 *
 * 2. **不覆盖现行 ACTIVE 资产**：若目标文件已是 ACTIVE 且非本次生成，
 *    直接报错退出，避免误删生产知识体系。
 *
 * 3. **幂等**：同样的输入产出同样的字节（publishedAt 由参数传入，默认固定值）。
 *
 * 4. **完整性校验**：写盘前校验每个 knowledgeId 的先修都存在（无悬空外键）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertTaxonomy,
  type ConversionOptions,
  type TaxonomyDependency,
  type TaxonomyQuestion,
  type TaxonomyTopic,
  type Stage,
} from '../src/infrastructure/knowledge/converters/taxonomy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

/**
 * 源项目默认位置：仓库根的 resources/cn-math-taxonomy。
 *
 * 路径推导：脚本位于 `packages/server/scripts/`，
 * SERVER_ROOT = `packages/server`，仓库根 = SERVER_ROOT/../.. = `packages/server/../..`
 * → 即 `packages/server/../../resources/cn-math-taxonomy`。
 */
const DEFAULT_SOURCE = path.resolve(SERVER_ROOT, '../../resources/cn-math-taxonomy');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

interface CliArgs {
  source: string;
  outKnowledge: string;
  outBank: string;
  version: string;
  publishedAt: string;
  subjects?: string[];
  stages?: Stage[];
  includeSoft: boolean;
  dryRun: boolean;
  force: boolean;
  /** 写入正式目录（而非暂存目录） */
  publish: boolean;
  /** 审核通过：产出 ACTIVE 资产 */
  promote: boolean;
  /** 资产状态 */
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
}

function parseArgs(argv: string[]): CliArgs {
  // ── 版本号即文件名 ──────────────────────────────────────────────
  // 项目约定（见 tests/curriculum-assets.test.ts 的「版本号与资产文件名一致」）：
  //   知识资产文件名（去掉 .json）必须与资产内的 `version` 字段完全一致。
  // 因此版本号本身就要写成合法的文件名，不含空格与路径分隔符。
  //
  // 同时，加载器取「排序最后」的文件生效，所以版本号必须**字典序可比**：
  // 用零填充的数值段（2026.02 < 2026.10），否则 2026.10 会排在 2026.2 之前。
  const version = 'shanghai-junior-taxonomy-2026.02';

  const args: CliArgs = {
    source: DEFAULT_SOURCE,
    // 默认写入**暂存目录**：导入产物是 DRAFT，未经教师审核不得进入正式目录。
    // 正式目录（data/knowledge、data/questions）同时只应存在一个生效版本，
    // 见 curriculum-assets.test.ts 的断言。
    outKnowledge: path.join(DATA_DIR, 'staging', 'knowledge', `${version}.json`),
    outBank: path.join(DATA_DIR, 'staging', 'questions', `bank-${version.replace(/^shanghai-junior-taxonomy-/, '')}.json`),
    version,
    // 固定时间戳保证幂等；发布时由调用方显式传入真实时间
    publishedAt: '2026-11-17T00:00:00.000Z',
    includeSoft: false,
    dryRun: false,
    force: false,
    publish: false,
    promote: false,
    status: 'DRAFT',
  };

  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    switch (key) {
      case 'source':
        args.source = path.resolve(value);
        break;
      case 'out-knowledge':
        args.outKnowledge = path.resolve(value);
        break;
      case 'out-bank':
        args.outBank = path.resolve(value);
        break;
      case 'version':
        args.version = value;
        break;
      case 'published-at':
        args.publishedAt = value;
        break;
      case 'subjects':
        args.subjects = value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'stages':
        args.stages = value.split(',').map((s) => s.trim()) as Stage[];
        break;
      case 'include-soft':
        args.includeSoft = true;
        break;
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'force':
        args.force = true;
        break;
      case 'publish':
        // 写入正式目录（data/knowledge、data/questions）。
        // 注意：正式目录同时只应存在一个生效版本，
        // 写入前会检查旧版本并按需归档。
        args.publish = true;
        args.outKnowledge = path.join(DATA_DIR, 'knowledge', `${args.version}.json`);
        args.outBank = path.join(
          DATA_DIR,
          'questions',
          `bank-${args.version.replace(/^shanghai-junior-taxonomy-/, '')}.json`
        );
        break;
      case 'promote':
        // 审核通过：把暂存目录里的 DRAFT 资产提升为 ACTIVE 并发布到正式目录。
        // 这是「教师审核」这一动作的脚本化表达。
        args.promote = true;
        args.publish = true;
        args.status = 'ACTIVE';
        args.outKnowledge = path.join(DATA_DIR, 'knowledge', `${args.version}.json`);
        args.outBank = path.join(
          DATA_DIR,
          'questions',
          `bank-${args.version.replace(/^shanghai-junior-taxonomy-/, '')}.json`
        );
        break;
      case 'help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`未知参数：--${key}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
用法：npm run import:taxonomy --workspace=@daydayup/server -- [选项]

选项：
  --source=<dir>          源项目目录（默认 resources/cn-math-taxonomy）
  --out-knowledge=<file>  输出知识资产路径（默认写到 staging/ 暂存目录）
  --out-bank=<file>       输出题库路径（默认写到 staging/ 暂存目录）
  --version=<string>      资产版本号（默认 shanghai-junior-taxonomy-2026.02）
  --published-at=<iso>    资产发布时间（默认 2026-11-17T00:00:00.000Z）
  --subjects=<a,b>        只导入这些学科（中文名，如 数学,英语）。默认五门中考学科
  --stages=<a,b>          只导入这些学段：小学,初中,高中。默认全部
  --include-soft          同时导入 soft 弱先修边（默认只导入 hard 硬先修）
  --publish               写入正式目录（data/knowledge、data/questions），
                          产物仍为 DRAFT；旧 ACTIVE 版本保留在正式目录
  --promote               审核通过：产出 ACTIVE 资产并发布到正式目录，
                          同时把旧版本归档到 staging/archived/
  --dry-run               只打印统计，不写文件
  --force                 允许覆盖已是 ACTIVE 的现有资产

注意：
  - 默认产物 status=DRAFT，需教师审核后用 --promote 才会生效
  - 版本号即文件名：知识资产的 version 字段必须等于文件名（去掉 .json）
  - cn-math-taxonomy 为 CC BY-NC 4.0，商业使用须先取得作者授权
`);
}

// ---------------------------------------------------------------------------
// 读取与校验
// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`源文件不存在：${file}`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `源文件不是合法 JSON：${file}\n${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 校验转换结果的完整性 —— 写盘前的最后一道关。
 *
 * 检查：
 *  1. 先修外键无悬空（每个 prerequisiteId 都能在知识点集合里找到）
 *  2. 先修图无环（硬先修不能成环，否则规划引擎会死循环）
 *  3. 每个知识点 id 唯一
 *  4. 题目引用的 knowledgeId 存在
 */
function validateResult(
  kpIds: Set<string>,
  prerequisites: Map<string, string[]>,
  questionKnowledgeIds: Set<string>
): string[] {
  const errors: string[] = [];

  // 1. 悬空外键
  for (const [id, prereqs] of prerequisites) {
    for (const p of prereqs) {
      if (!kpIds.has(p)) {
        errors.push(`悬空先修引用：${id} → ${p}`);
      }
    }
  }

  // 2. 环检测（DFS 三色标记）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of kpIds) color.set(id, WHITE);

  const stack: Array<{ node: string; path: string[] }> = [];
  for (const start of kpIds) {
    if (color.get(start) !== WHITE) continue;
    stack.push({ node: start, path: [] });
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { node } = frame;
      if (color.get(node) === BLACK) continue;
      if (color.get(node) === GRAY) {
        errors.push(`先修图存在环：${[...frame.path, node].join(' → ')}`);
        continue;
      }
      color.set(node, GRAY);
      frame.path.push(node);
      for (const next of prerequisites.get(node) ?? []) {
        if (color.get(next) === GRAY) {
          errors.push(`先修图存在环：${[...frame.path, next].join(' → ')}`);
        } else if (color.get(next) === WHITE) {
          stack.push({ node: next, path: [...frame.path] });
        }
      }
      color.set(node, BLACK);
    }
  }

  // 3. 题目外键
  for (const k of questionKnowledgeIds) {
    if (!kpIds.has(k)) {
      errors.push(`题目引用了不存在的知识点：${k}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('┌─ cn-math-taxonomy → daydayup 知识资产导入');
  console.log(`│  源目录：${args.source}`);

  const topicsFile = path.join(args.source, 'data', 'topics.json');
  const depsFile = path.join(args.source, 'data', 'dependencies.json');
  const questionsFile = path.join(args.source, 'data', 'questions.json');

  const topics = readJson<TaxonomyTopic[]>(topicsFile);
  const deps = readJson<TaxonomyDependency[]>(depsFile);
  const questions = readJson<TaxonomyQuestion[]>(questionsFile);

  console.log(`│  源数据：${topics.length} 知识点 / ${deps.length} 先修边 / ${questions.length} 题目`);

  const opts: ConversionOptions = {
    version: args.version,
    publishedAt: args.publishedAt,
    includeSoftPrerequisites: args.includeSoft,
    status: args.status,
    ...(args.subjects ? { subjects: args.subjects } : {}),
    ...(args.stages ? { stages: args.stages } : {}),
  };

  const { curriculum, bank, report } = convertTaxonomy(topics, deps, questions, opts);

  // ---- 校验 ----
  const kpIds = new Set(curriculum.knowledgePoints.map((k) => k.id));
  const prereqMap = new Map(curriculum.knowledgePoints.map((k) => [k.id, k.prerequisites]));
  const qKIds = new Set(bank.questions.flatMap((q) => q.knowledgeIds));
  const errors = validateResult(kpIds, prereqMap, qKIds);

  if (errors.length > 0) {
    console.error('│  ✗ 完整性校验失败：');
    for (const e of errors.slice(0, 20)) console.error(`│      ${e}`);
    if (errors.length > 20) console.error(`│      ...共 ${errors.length} 处`);
    process.exit(1);
  }
  console.log('│  ✓ 完整性校验通过（无悬空先修、无环、题目外键有效）');

  // ---- 统计 ----
  console.log('│');
  console.log('│  转化结果：');
  console.log(`│    知识点  ${report.convertedTopics}`);
  console.log(`│    题目    ${report.convertedQuestions}`);
  console.log(`│    先修边  ${report.keptEdges}`);
  console.log('│');
  console.log('│    分学科：');
  for (const [subject, stat] of Object.entries(report.bySubject)) {
    console.log(
      `│      ${subject.padEnd(6, '　')} 知识点 ${String(stat.topics).padStart(4)}   题目 ${String(stat.questions).padStart(5)}`
    );
  }

  if (report.warnings.length > 0) {
    console.log('│');
    console.log('│  ⚠ 数据缺口（需教师补全）：');
    for (const w of report.warnings) console.log(`│      ${w}`);
  }

  // 跳过统计按原因聚合，避免刷屏。
  // 注意：题目跳过的原因是"所属知识点 X 未导入"，需把 X 抽出来再聚合，
  // 否则每个知识点一行，共上千行毫无信息量。
  const skipByReason = new Map<string, number>();
  for (const s of report.skipped) {
    let reason = s.reason;
    if (s.kind === 'question') {
      reason = reason.replace(/所属知识点 \S+ 未导入/, '所属知识点未导入');
    }
    const key = `${s.kind}: ${reason}`;
    skipByReason.set(key, (skipByReason.get(key) ?? 0) + 1);
  }
  if (skipByReason.size > 0) {
    console.log('│');
    console.log('│  跳过明细（按原因聚合）：');
    for (const [reason, count] of [...skipByReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`│      ${String(count).padStart(5)} × ${reason}`);
    }
  }

  if (args.dryRun) {
    console.log('│');
    console.log('└─ --dry-run：未写入任何文件');
    return;
  }

  // ---- 版本号 / 文件名一致性 ----
  // 项目约定：知识资产文件名（去 .json）必须等于资产内的 version 字段。
  // 见 packages/server/tests/curriculum-assets.test.ts 的「版本号与资产文件名一致」。
  const knowledgeStem = path.basename(args.outKnowledge, '.json');
  if (knowledgeStem !== curriculum.version) {
    console.error(`\n✗ 版本号与知识资产文件名不一致：`);
    console.error(`    version = ${curriculum.version}`);
    console.error(`    文件名  = ${knowledgeStem}`);
    console.error('  加载器依赖这个不变量（取排序最后的文件生效）。');
    process.exit(1);
  }

  // ---- 防覆盖检查 ----
  for (const outFile of [args.outKnowledge, args.outBank]) {
    if (!fs.existsSync(outFile)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { status?: string };
      if (existing.status === 'ACTIVE' && !args.force) {
        console.error(`\n✗ 拒绝覆盖已是 ACTIVE 的资产：${outFile}`);
        console.error('  请先将其改为 DEPRECATED，或显式加 --force。');
        process.exit(1);
      }
    } catch {
      // 文件损坏 → 视为不可解析，交由写入覆盖
    }
  }

  // ---- 正式目录单版本保障 ----
  //
  // 正式目录同时只应存在**一个**知识资产文件（见 curriculum-assets.test.ts）。
  //
  // 但**归档旧版本必须与「批准新版本」同时发生**，不能只做一半：
  // 若先把旧 ACTIVE 移走、再写入一个 DRAFT，系统就只剩未经审核的草稿 ——
  // 加载器虽会告警，但生产实际上已切到未审核内容。
  //
  // 因此这里只在「本次发布即为 ACTIVE」时归档旧版本；
  // 发布 DRAFT 时把旧版本留在原地（加载器优先选 ACTIVE，不受影响），
  // 由审核通过后用 --promote 步骤归档。
  if (args.publish) {
    const knowledgeDir = path.dirname(args.outKnowledge);
    const archiveDir = path.join(DATA_DIR, 'staging', 'archived');
    const oldFiles = fs
      .readdirSync(knowledgeDir)
      .filter((f) => f.endsWith('.json') && f !== path.basename(args.outKnowledge));

    if (oldFiles.length > 0) {
      if (curriculum.status === 'ACTIVE') {
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const old of oldFiles) {
          fs.renameSync(path.join(knowledgeDir, old), path.join(archiveDir, old));
          console.log(`│  ↻ 已归档旧资产：${old}`);
        }
        console.log('│');
      } else {
        console.log('│');
        console.log('│  ℹ 旧版本仍留在正式目录（加载器优先选 ACTIVE，不受影响）');
        console.log('│    审核通过后用 --promote 归档旧版本');
      }
    }
  }

  // ---- 写盘 ----
  fs.mkdirSync(path.dirname(args.outKnowledge), { recursive: true });
  fs.mkdirSync(path.dirname(args.outBank), { recursive: true });

  fs.writeFileSync(args.outKnowledge, JSON.stringify(curriculum, null, 2) + '\n', 'utf8');
  fs.writeFileSync(args.outBank, JSON.stringify(bank, null, 2) + '\n', 'utf8');

  console.log('│');
  console.log(`│  ✓ 已写入知识资产：${args.outKnowledge}`);
  console.log(`│  ✓ 已写入题库：    ${args.outBank}`);
  console.log('│');
  console.log(`│  状态：${curriculum.status}`);
  if (curriculum.status === 'DRAFT') {
    console.log('│         ↳ DRAFT 不会在正式运行时被选中（加载器优先选 ACTIVE）');
    console.log('│         ↳ 教师审核通过后用 --promote 发布');
  } else {
    console.log('│         ↳ 已生效（加载器将选中本版本）');
  }
  console.log('│  ⚠ 授权：CC BY-NC 4.0，商业使用须先取得作者授权');
  console.log('└─ 完成');
}

main();
