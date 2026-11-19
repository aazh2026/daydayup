/**
 * 「上海中考英语提分实战手册 · 30天冲刺」→ daydayup 冲刺资产导入脚本。
 *
 * 运行：
 *   npm run import:sprint --workspace=@daydayup/server
 *   npm run import:sprint --workspace=@daydayup/server -- --dry-run
 *   npm run import:sprint --workspace=@daydayup/server -- --promote
 *
 * ── 为什么要这一层 ──────────────────────────────────────────────────────
 *
 * 排课引擎的 7 天计划是「按提分优先级动态排」，而这份手册给的是
 * **教研老师手排的 30 天冲刺表**：每天做什么、限时多久、做到什么算过关。
 * 两者的节奏不一样（冲刺表有明确阶段：止血 → 攻拉分题 → 限时整套），
 * 所以它作为**独立资产层**导入，引擎侧再把它落到真实知识点上。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. 默认写 DRAFT：冲刺表未经教师核对不得上线。
 * 2. 只有 ACTIVE 生效（见 src/infrastructure/knowledge/sprint.ts）。
 * 3. 外键校验：knowledgeIds 里的 id 必须真实存在于当前生效的知识资产。
 * 4. 不覆盖现行 ACTIVE 资产：需要 --force。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { SprintDay, SprintSet, SprintStage } from '@daydayup/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

/** xlsx 是仓库根的 devDependency，服务端包内没有 —— 用根 package.json 解析 */
const require = createRequire(path.join(REPO_ROOT, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require('xlsx') as {
  readFile(file: string): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: {
    sheet_to_json(
      sheet: unknown,
      opts?: Record<string, unknown>
    ): Array<Array<string | number>>;
  };
};

const SOURCE_FILE = path.join(
  REPO_ROOT,
  'resources/workbuddy-research/上海中考英语提分实战手册.xlsx'
);
const SOURCE_SHEET = '30天冲刺';
const SUBJECT = '英语';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface CliArgs {
  versionSuffix: string;
  publishedAt: string;
  dryRun: boolean;
  promote: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    versionSuffix: '2026.11',
    publishedAt: '2026-11-19T00:00:00.000Z',
    dryRun: false,
    promote: false,
    force: false,
  };

  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    switch (key) {
      case 'version-suffix':
        args.versionSuffix = value;
        break;
      case 'published-at':
        args.publishedAt = value;
        break;
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'promote':
        args.promote = true;
        break;
      case 'force':
        args.force = true;
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
用法：npm run import:sprint --workspace=@daydayup/server -- [选项]

选项：
  --version-suffix=<s>    版本后缀（默认 2026.11）
  --published-at=<iso>    发布时间（默认固定值，保证幂等）
  --promote               审核通过：产出 ACTIVE 资产
  --dry-run               只打印统计，不写文件
  --force                 允许覆盖已是 ACTIVE 的现有冲刺资产

注意：
  - 默认产物 status=DRAFT（加载器只加载 ACTIVE 冲刺资产）
  - 知识点映射是**启发式**的：映射不到的冲刺日 knowledgeIds 为空，
    由引擎侧挂到英语学科兜底知识点
`);
}

// ---------------------------------------------------------------------------
// 知识资产（外键校验 + 名称解析）
// ---------------------------------------------------------------------------

interface KnowledgeAsset {
  status?: string;
  knowledgePoints?: Array<{
    id: string;
    name: string;
    subject: string;
    domain?: string;
    chapter?: string;
  }>;
}

function resolveKnowledgeDir(): string {
  const override = path.join(DATA_DIR, 'knowledge');
  if (
    fs.existsSync(override) &&
    fs.readdirSync(override).some((f) => f.endsWith('.json'))
  ) {
    return override;
  }
  return path.join(SERVER_ROOT, 'data', 'knowledge');
}

function loadKnowledgePoints(): Array<{
  id: string;
  name: string;
  subject: string;
}> {
  const dir = resolveKnowledgeDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: KnowledgeAsset }> = [];
  for (const file of files) {
    try {
      readable.push({
        file,
        parsed: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
      });
    } catch {
      // 跳过损坏文件
    }
  }
  const active = readable.find((r) => r.parsed.status === 'ACTIVE');
  if (!active) throw new Error(`未找到生效的知识资产：${dir}`);
  return active.parsed.knowledgePoints ?? [];
}

// ---------------------------------------------------------------------------
// 启发式知识点映射
// ---------------------------------------------------------------------------

/**
 * 任务文本关键词 → 知识点名候选。
 *
 * 说明：手册里的任务全是自然语言（「重做 2022 语法选择 21–35」），
 * 没有知识点 id，只能靠关键词启发式映射。
 * 规则按顺序匹配，命中后按名字去真实知识资产里解析 id；
 * **解析不到就跳过**（绝不写不存在的 id）。
 */
const KEYWORD_RULES: Array<{ test: RegExp; names: string[] }> = [
  { test: /作文|书面表达/, names: ['书面表达要点'] },
  { test: /首字母/, names: ['完形填空'] },
  { test: /完形/, names: ['完形填空'] },
  { test: /被动语态/, names: ['一般现在时被动语态'] },
  { test: /定语从句/, names: ['定语从句'] },
  { test: /Having done|动名词|不定式/, names: ['动名词与不定式'] },
  { test: /宾语从句|Why 用 Because|How 用/, names: ['疑问词宾语从句'] },
  { test: /词形|词性|复数/, names: ['名词复数'] },
  { test: /主谓一致/, names: ['主谓一致'] },
  { test: /反意疑问/, names: ['反意疑问句'] },
  { test: /阅读/, names: ['读学习建议'] },
  { test: /句型转换|句转|句子升级/, names: ['定语从句', '动名词与不定式'] },
  { test: /语法选择|语法|完成时/, names: ['时态选择'] },
  // 整套卷日覆盖全部板块 → 挂语法/完形/写作三个板块知识点
  { test: /整套|限时卷/, names: ['书面表达要点', '完形填空', '时态选择'] },
  // 听力/听说在教材单元制知识点里没有对应点 → 不映射，走引擎兜底
];

function buildNameIndex(
  points: Array<{ id: string; name: string; subject: string }>
): Map<string, string> {
  const index = new Map<string, string>();
  const english = points
    .filter((p) => p.subject === SUBJECT)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const p of english) {
    if (!index.has(p.name)) index.set(p.name, p.id);
  }
  return index;
}

function mapKnowledgeIds(
  task: string,
  nameIndex: Map<string, string>
): string[] {
  const ids: string[] = [];
  for (const rule of KEYWORD_RULES) {
    if (!rule.test.test(task)) continue;
    for (const name of rule.names) {
      const id = nameIndex.get(name);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 读取 xlsx
// ---------------------------------------------------------------------------

interface SprintRow {
  dayIndex: number;
  stage: string;
  task: string;
  timeLimit: string;
  acceptanceCriteria: string;
}

function readSprintRows(): SprintRow[] {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error(`源文件不存在：${SOURCE_FILE}`);
  }
  const workbook = XLSX.readFile(SOURCE_FILE);
  const sheet = workbook.Sheets[SOURCE_SHEET];
  if (!sheet) {
    throw new Error(`源文件缺少工作表「${SOURCE_SHEET}」`);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as Array<Array<string | number>>;

  // 表头行 = 第一列等于「天数」的那一行（容错：前面可能有标题行）
  const headerIdx = rows.findIndex(
    (r) => String(r?.[0] ?? '').trim() === '天数'
  );
  if (headerIdx === -1) throw new Error('未找到表头行（第一列应为「天数」）');

  const out: SprintRow[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const dayIndex = Number(row?.[0]);
    const stage = String(row?.[1] ?? '').trim();
    const task = String(row?.[2] ?? '').trim();
    if (!Number.isFinite(dayIndex) || dayIndex <= 0) continue;
    if (!stage || !task) continue;
    out.push({
      dayIndex,
      stage,
      task,
      timeLimit: String(row?.[3] ?? '').trim(),
      acceptanceCriteria: String(row?.[4] ?? '').trim(),
    });
  }
  return out.sort((a, b) => a.dayIndex - b.dayIndex);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('┌─ workbuddy「30天冲刺」→ 冲刺资产导入');
  console.log(`│  源文件：${path.relative(REPO_ROOT, SOURCE_FILE)}`);

  const rows = readSprintRows();
  if (rows.length === 0) throw new Error('源工作表里没有冲刺数据行');

  const points = loadKnowledgePoints();
  const nameIndex = buildNameIndex(points);
  console.log(`│  知识资产：${points.length} 个知识点（英语 ${nameIndex.size} 个名称索引）`);

  const days: SprintDay[] = rows.map((row) => ({
    dayIndex: row.dayIndex,
    stage: row.stage,
    task: row.task,
    timeLimit: row.timeLimit,
    acceptanceCriteria: row.acceptanceCriteria,
    subject: SUBJECT,
    knowledgeIds: mapKnowledgeIds(row.task, nameIndex),
  }));

  // 阶段（保持首次出现顺序）
  const stageMap = new Map<string, SprintStage>();
  for (const day of days) {
    const existing = stageMap.get(day.stage);
    if (existing) {
      existing.toDay = day.dayIndex;
    } else {
      stageMap.set(day.stage, {
        name: day.stage,
        acceptanceCriteria: day.acceptanceCriteria,
        fromDay: day.dayIndex,
        toDay: day.dayIndex,
      });
    }
  }
  const stages = [...stageMap.values()];

  const status: SprintSet['status'] = args.promote ? 'ACTIVE' : 'DRAFT';
  const version = `workbuddy-english-${args.versionSuffix}`;
  const set: SprintSet = {
    version,
    publishedAt: args.publishedAt,
    status,
    source: {
      repo: 'workbuddy-research',
      path: 'resources/workbuddy-research/上海中考英语提分实战手册.xlsx',
      license: '内部教研资料（未声明公开许可）',
      note: '产品商业化前须取得作者授权；冲刺表经教师核对后再 --promote 发布',
    },
    stages,
    days,
  };

  console.log('│');
  console.log(`│  ▸ ${SOURCE_SHEET}`);
  console.log(`│    天数：${days.length} 天（day${days[0].dayIndex} – day${days[days.length - 1].dayIndex}）`);
  for (const stage of stages) {
    console.log(
      `│    阶段：${stage.name}（day${stage.fromDay}-${stage.toDay}）`
    );
  }
  const mapped = days.filter((d) => d.knowledgeIds.length > 0);
  console.log(
    `│    知识点映射：${mapped.length}/${days.length} 天命中（每天 ≤3 个）`
  );
  for (const day of days.filter((d) => d.knowledgeIds.length === 0)) {
    console.log(`│      ↳ day${day.dayIndex} 未命中知识点（引擎走兜底）：${day.task.slice(0, 28)}…`);
  }

  if (args.dryRun) {
    console.log('│');
    console.log('└─ --dry-run：未写入任何文件');
    return;
  }

  const outDir = path.join(DATA_DIR, 'sprints');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${version}.json`);
  if (fs.existsSync(outFile) && !args.force) {
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      status?: string;
    };
    if (existing.status === 'ACTIVE') {
      console.error(`\n✗ 拒绝覆盖已是 ACTIVE 的冲刺资产：${outFile}`);
      console.error('  请先归档，或显式加 --force。');
      process.exit(1);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(set, null, 2) + '\n', 'utf8');

  console.log('│');
  console.log(`│  ✓ 已写入：${outFile}`);
  console.log(`│  状态：${status}`);
  if (status === 'DRAFT') {
    console.log('│         ↳ DRAFT 不生效（加载器只加载 ACTIVE 冲刺资产）');
    console.log('│         ↳ 教师核对后用 --promote 发布');
  } else {
    console.log('│         ↳ 已生效：GET /api/v1/students/:id/sprint-plan 可返回 30 天冲刺计划');
  }
  console.log('└─ 完成');
}

main();
