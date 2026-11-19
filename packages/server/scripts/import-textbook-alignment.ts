/**
 * 上海本地课本落点（教材对齐）→ daydayup 教材对齐资产导入脚本。
 *
 * 运行：
 *   npm run import:textbook --workspace=@daydayup/server
 *   npm run import:textbook --workspace=@daydayup/server -- --source=hujiao_math,yilin_english --dry-run
 *   npm run import:textbook --workspace=@daydayup/server -- --promote
 *
 * ── 为什么要这一层 ──────────────────────────────────────────────────────
 *
 * 知识资产（2760 个知识点）的 `chapter` 来自 **人教版**章节体系，
 * 而上海中考用 **沪教版数学** 与 **译林版英语**。
 * 排课、诊断、报告若报「人教版章节」，学生翻不到对应课本页。
 *
 * 这一层只存「知识点 → 课本落点」的映射，不复制知识点本体：
 * 换课本版本只需重导这一层，不必重导整个知识资产。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. 默认写 DRAFT：教材落点会进排课与报告，未经核对不得上线。
 * 2. 外键校验：knowledgeId 必须存在于当前生效的知识资产里。
 * 3. 许可闸门：cn-mt 为 CC BY-NC 4.0，商用须取得作者商业授权。
 * 4. 不覆盖现行 ACTIVE 资产：需要 `--force`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TextbookAlignmentSet, TextbookRef } from '@daydayup/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

// ---------------------------------------------------------------------------
// 来源定义
// ---------------------------------------------------------------------------

interface SourceDef {
  key: string;
  file: string;
  subject: string;
  /** 是否为上海本地教材（上海学生的课本） */
  shanghai: boolean;
  defaultOn: boolean;
  note?: string;
}

const SOURCES: Record<string, SourceDef> = {
  hujiao_math: {
    key: 'hujiao_math',
    file: 'hujiao_math.json',
    subject: '数学',
    shanghai: true,
    defaultOn: true,
    note: '沪教版数学（上海教育出版社），上海中考数学用书',
  },
  yilin_english: {
    key: 'yilin_english',
    file: 'yilin_english.json',
    subject: '英语',
    shanghai: true,
    defaultOn: true,
    note: '译林版英语（译林出版社），上海中考英语用书',
  },
  sujiao_math: {
    key: 'sujiao_math',
    file: 'sujiao_math.json',
    subject: '数学',
    shanghai: false,
    defaultOn: false,
    note: '苏教版数学，仅作跨版本对齐参考',
  },
  sd54_math: {
    key: 'sd54_math',
    file: 'sd54_math.json',
    subject: '数学',
    shanghai: false,
    defaultOn: false,
    note: '山东五四制数学，仅作跨版本对齐参考',
  },
};

const SOURCE_DIR = path.join(
  REPO_ROOT,
  'resources/cn-math-taxonomy/data/mappings'
);

const LICENSE = 'CC BY-NC 4.0';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-nc/4.0/';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface CliArgs {
  sources: string[];
  versionSuffix: string;
  publishedAt: string;
  dryRun: boolean;
  promote: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sources: [],
    versionSuffix: '2026.11',
    publishedAt: '2026-11-19T00:00:00.000Z',
    dryRun: false,
    promote: false,
    force: false,
  };

  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    switch (key) {
      case 'source':
        args.sources = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
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

  if (args.sources.length === 0) {
    args.sources = Object.values(SOURCES)
      .filter((s) => s.defaultOn)
      .map((s) => s.key);
  }
  return args;
}

function printHelp(): void {
  console.log(`
用法：npm run import:textbook --workspace=@daydayup/server -- [选项]

选项：
  --source=<a,b>          来源：hujiao_math,yilin_english（默认）/ sujiao_math / sd54_math / all
  --version-suffix=<s>    版本后缀（默认 2026.11）
  --published-at=<iso>    发布时间（默认固定值，保证幂等）
  --promote               审核通过：产出 ACTIVE 资产
  --dry-run               只打印统计，不写文件
  --force                 允许覆盖已是 ACTIVE 的现有教材对齐资产

注意：
  - 默认产物 status=DRAFT
  - 外键校验：knowledgeId 必须存在于生效知识资产中，否则导入失败
  - 许可 CC BY-NC 4.0：产品商业化前须取得作者商业授权
`);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** 当前生效知识资产的知识点 id 集合 */
function loadActiveKnowledgeIds(): Set<string> {
  const dir = path.join(DATA_DIR, 'knowledge');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: { status?: string; knowledgePoints?: Array<{ id: string }> } }> = [];
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
  const active = readable.find((r) => r.parsed.status === 'ACTIVE') ?? readable[readable.length - 1];
  if (!active) throw new Error(`未找到可用的知识资产：${dir}`);
  return new Set((active.parsed.knowledgePoints ?? []).map((k) => k.id));
}

const GRADE_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 年级数字 → 「七年级」 */
export function formatGrade(grade: number): string {
  return `${GRADE_CN[grade - 1] ?? String(grade)}年级`;
}

interface MappingFile {
  edition: string;
  label: string;
  status?: string;
  source?: string;
  entries: Array<{
    topicId: string;
    grade: number;
    term: string;
    unit: string;
    chapter: string;
    note?: string;
  }>;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const sourceKeys = args.sources.includes('all')
    ? Object.keys(SOURCES)
    : args.sources;

  for (const key of sourceKeys) {
    if (!SOURCES[key]) {
      console.error(`未知来源：${key}（可用：${Object.keys(SOURCES).join(', ')}）`);
      process.exit(1);
    }
  }

  console.log('┌─ 上海本地课本落点 → 教材对齐资产导入');
  console.log(`│  来源：${sourceKeys.join(', ')}`);

  const knowledgeIds = loadActiveKnowledgeIds();
  console.log(`│  知识资产：${knowledgeIds.size} 个知识点`);

  const status: TextbookAlignmentSet['status'] = args.promote ? 'ACTIVE' : 'DRAFT';
  const outDir = path.join(DATA_DIR, 'curriculum');
  const written: string[] = [];

  for (const key of sourceKeys) {
    const def = SOURCES[key];
    const file = path.join(SOURCE_DIR, def.file);
    if (!fs.existsSync(file)) {
      console.error(`│  ✗ 映射文件不存在：${file}`);
      process.exit(1);
    }

    const mapping = readJson<MappingFile>(file);
    const entries: TextbookAlignmentSet['entries'] = [];
    const dangling: string[] = [];

    for (const e of mapping.entries) {
      if (!knowledgeIds.has(e.topicId)) {
        dangling.push(e.topicId);
        continue;
      }
      const textbook: TextbookRef = {
        editionKey: mapping.edition,
        edition: mapping.label,
        grade: formatGrade(e.grade),
        term: e.term === '下' ? '下册' : '上册',
        unit: e.unit,
        chapter: e.chapter,
        ...(e.note ? { note: e.note } : {}),
      };
      entries.push({ knowledgeId: e.topicId, textbook });
    }

    if (dangling.length > 0) {
      console.error(
        `│  ✗ 外键校验失败：${dangling.length} 个 topicId 不在知识资产里（${dangling.slice(0, 5).join(', ')}）`
      );
      process.exit(1);
    }

    const version = `textbook-${def.key}-${args.versionSuffix}`;
    const set: TextbookAlignmentSet = {
      version,
      publishedAt: args.publishedAt,
      status,
      source: {
        repo: 'cn-math-taxonomy',
        path: 'resources/cn-math-taxonomy/data/mappings',
        license: LICENSE,
        licenseUrl: LICENSE_URL,
        note: def.note,
      },
      entries,
    };

    console.log('│');
    console.log(`│  ▸ ${def.key}（${mapping.label}）`);
    console.log(`│    条目 ${mapping.entries.length} 条 → 对齐 ${entries.length} 条`);
    console.log(`│    教材说明：${(mapping.source ?? '').slice(0, 60)}…`);

    if (args.dryRun) continue;

    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${version}.json`);
    if (fs.existsSync(outFile) && !args.force) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { status?: string };
      if (existing.status === 'ACTIVE') {
        console.error(`\n✗ 拒绝覆盖已是 ACTIVE 的教材对齐资产：${outFile}`);
        console.error('  请先归档，或显式加 --force。');
        process.exit(1);
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(set, null, 2) + '\n', 'utf8');
    written.push(outFile);
    console.log(`│  ✓ 已写入：${outFile}（${entries.length} 条，${status}）`);
  }

  if (args.dryRun) {
    console.log('│');
    console.log('└─ --dry-run：未写入任何文件');
    return;
  }

  console.log('│');
  console.log(`│  状态：${status}`);
  if (status === 'DRAFT') {
    console.log('│         ↳ DRAFT 不生效（加载器只加载 ACTIVE 教材对齐资产）');
    console.log('│         ↳ 教师核对课本页后用 --promote 发布');
  } else {
    console.log('│         ↳ 已生效：知识点会带上沪教版/译林版课本落点');
  }
  console.log('└─ 完成');
}

main();
