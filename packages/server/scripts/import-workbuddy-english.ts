/**
 * workbuddy 上海中考英语资产 → daydayup 知识叠加层 + 题库资产导入脚本。
 *
 * 运行：
 *   npx tsx scripts/import-workbuddy-english.ts --dry-run
 *   npx tsx scripts/import-workbuddy-english.ts --promote
 *   npx tsx scripts/import-workbuddy-english.ts --promote --force
 *
 * ── 数据来源 ──────────────────────────────────────────────────────────
 *
 * resources/workbuddy-research/ 下三份 xlsx（外部收集的上海中考英语资料）：
 *  1. 上海中考英语完整知识地图.xlsx    → 工作表「知识地图」（338 行，四级编码）
 *  2. 上海中考英语核心知识点详解表.xlsx → 工作表「知识点总表」（169 行，序号）
 *  3. 上海中考英语提分实战手册.xlsx     → 工作表「真题拆解」（61 行）
 *
 * ── 为什么走 overlay 层 ────────────────────────────────────────────────
 *
 * 知识地图里的应试点型（音标、听力技巧、题型策略、写作要点）**不属于任何
 * 教材单元**，无法用主资产的 `chapter` 表达；而主资产 2760 个知识点重新
 * 导入/审核代价极高。于是：
 *
 *  - 知识点 → `data/overlays/workbuddy-english-2026.11.json`（KnowledgeOverlaySet）
 *  - 题目   → `data/questions/bank-workbuddy-english-2026.02.json`（题库增量文件）
 *
 * 两份文件互相独立：overlay 可单独下架，题目题库合并进主题库。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. 默认写 DRAFT：未经教师审核的应试点型不得直接进线上排课（`--promote` 才 ACTIVE）；
 * 2. id 必须是**项目原生 id**（`cne_wb_*`），绝不把中文/外部编码写进 id；
 * 3. 外键自检：每道题的 knowledgeIds 必须能在 overlay 条目或现有知识点里解析到；
 * 4. 不覆盖现行 ACTIVE 资产：需要 `--force`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import type { KnowledgeOverlayEntry, KnowledgeOverlaySet } from '@daydayup/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');
const SOURCE_DIR = path.join(REPO_ROOT, 'resources/workbuddy-research');

// xlsx 装在仓库根 node_modules（workspace hoist 提升），用 createRequire 定位
const require = createRequire(path.join(REPO_ROOT, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require('xlsx') as typeof import('xlsx');

const FILE_MAP = '上海中考英语完整知识地图.xlsx';
const FILE_DETAIL = '上海中考英语核心知识点详解表.xlsx';
const FILE_MANUAL = '上海中考英语提分实战手册.xlsx';

const OVERLAY_VERSION = 'workbuddy-english-2026.11';
const BANK_VERSION = 'shanghai-junior-taxonomy-2026.02+questions';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface CliArgs {
  publishedAt: string;
  dryRun: boolean;
  promote: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    publishedAt: new Date().toISOString(),
    dryRun: false,
    promote: false,
    force: false,
  };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    switch (key) {
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
用法：npx tsx scripts/import-workbuddy-english.ts [选项]

选项：
  --published-at=<iso>    发布时间（默认脚本运行时间）
  --promote               产出 ACTIVE 资产（默认 DRAFT）
  --dry-run               只打印统计，不写文件
  --force                 允许覆盖已是 ACTIVE 的现有资产

产物：
  data/overlays/workbuddy-english-2026.11.json
  data/questions/bank-workbuddy-english-2026.02.json
`);
}

// ---------------------------------------------------------------------------
// xlsx 读取
// ---------------------------------------------------------------------------

type Row = Array<string | number | null>;

/** 读工作表并去掉「标题行 + 表头行」，返回数据行 */
function readSheet(file: string, sheet: string): Row[] {
  const full = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`来源文件不存在：${full}`);
  }
  const wb = XLSX.readFile(full);
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`工作表不存在：${file} → ${sheet}`);
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw: true,
  }) as Row[];
  // 第 1 行是大标题，第 2 行是列名
  return rows.slice(2);
}

function str(row: Row, i: number): string {
  const v = row[i];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// 考点 → 知识点 映射
// ---------------------------------------------------------------------------

/**
 * 人工映射表：考点 → overlay 知识点名。
 *
 * 为什么需要人工表：源表的「考点」是**题型视角**的说法（如「固定搭配中的冠词」、
 * 「对金额提问」），overlay 知识点是**语法/词汇视角**的名字，
 * 两者不是一一对应，机器匹配不了。
 *
 * 每条都指向语义最贴近的 overlay 知识点；不存在同名知识点时，
 * 指向同一技能域下最接近的一条（例如「对金额提问」→「划线部分提问」）。
 */
const MANUAL_TOPIC_MAP: Record<string, string> = {
  // —— 冠词 / 固定搭配 ——
  固定搭配中的冠词: '不定冠词 a/an', // give a helping hand：a/an/零冠词的选择
  动词短语介词: '动词+介词搭配', // take charge of
  情态动词表请求: 'can / could / may 表请求', // May I...?
  'spend + doing': 'spend / cost / pay / take', // spend + doing 固定结构
  'enable sb. to do': 'to do 常见动词', // enable sb. to do

  // —— 词形 / 词性 ——
  感叹句: '感叹句 What / How', // What an + 中心词
  名词复数: '名词复数规则',
  名词化: '词性转换链', // reduce air pollution
  副词修饰动词: '副词位置', // correctly 修饰 operate
  动名词: '动名词作宾语',
  形容词: '形容词位置',
  名词: '十大词类',
  '名词 / 动词': '十大词类',
  动词: '实义动词',
  副词: '副词构成',
  '副词、动词过去式、名词复数、代词、副词': '十大词类', // 回忆版 7 空：词性分布

  // —— 时态 / 语态 / 句型 ——
  '一般过去时被动': '各时态被动',
  同义短语: '同义词与近义词', // have a good time = enjoy oneself
  间接引语三变化: '直接引语变间接引语',
  间接引语时态后移: '直接引语变间接引语',
  连词成句: '主干先行的分析方法', // 先找主语谓语，再补宾语状语
  '对金额提问': '划线部分提问',
  对距离提问: '划线部分提问',
  'Why 用 Because + 完整句': '原因状语从句',
  'Because + 完整因果': '原因状语从句',
  '时态与人称转换': '复述时态人称', // I → He 的转述

  // —— 阅读问答 / 写作 ——
  '一般疑问句完整回答': '一般疑问句',
  '补句 · 上下文逻辑': '六选五/七选五', // 补句题同属句子填空题型
  'How 用 By doing': '方式介词',
  '概括题 · 三条要点': '主旨大意题',
  年龄完整句: '完整句作答',
  名词短语可接受: '阅读问答',
  开放题也要给理由: '因果句型',
  '应用文 · 双要点': '应用文格式',
  '应用文 · 中国文化': '传统文化话题',
  '申请信 · 四要点': '书信与邮件',
  '回信 · 两问 + 建议': '回信建议类',
};

/**
 * 机器兜底匹配（在人工表未命中时用）：
 * 1. 名称完全相同；
 * 2. 知识点名**包含**考点（如「比较级」→「比较级构成」），取最短；
 * 3. 考点**包含**知识点名（如「系动词后接形容词」→「系动词」），取最短。
 */
function autoMatchTopic(topic: string, names: string[]): string | undefined {
  if (names.includes(topic)) return topic;

  const containing = names.filter((n) => n.includes(topic));
  if (containing.length > 0) {
    return containing.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }

  const contained = names.filter((n) => topic.includes(n) && n.length >= 2);
  if (contained.length > 0) {
    return contained.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// overlay 条目
// ---------------------------------------------------------------------------

/** 一级领域/一级模块 → 默认 examWeight / learningCostHours */
const DEFAULTS: Record<string, { weight: number; hours: number }> = {
  '01 语音基础': { weight: 0.3, hours: 0.5 },
  '02 词汇系统': { weight: 0.5, hours: 0.8 },
  '03 语法体系': { weight: 0.6, hours: 1.2 },
  '04 听力与听说': { weight: 0.5, hours: 0.8 },
  '05 阅读与语篇': { weight: 0.6, hours: 1.0 },
  '06 写作与表达': { weight: 0.6, hours: 1.5 },
  '07 话题与文化': { weight: 0.4, hours: 0.8 },
  '08 学习策略与测评': { weight: 0.4, hours: 0.6 },
  词汇: { weight: 0.5, hours: 0.8 },
  语法基础: { weight: 0.6, hours: 1.2 },
  题型策略: { weight: 0.6, hours: 1.0 },
  句型转换与翻译: { weight: 0.5, hours: 1.0 },
};

const FALLBACK_DEFAULT = { weight: 0.5, hours: 1.0 };

interface OverlayDraft {
  entry: KnowledgeOverlayEntry;
  /** 供题目考点映射用的名称索引 */
  name: string;
}

/** 编码「01.01.01.01」→「cne_wb_01_01_01_01」 */
function codeToId(code: string): string {
  const digits = code.replace(/\./g, '_').replace(/[^0-9a-zA-Z_]/g, '');
  return `cne_wb_${digits.toLowerCase()}`;
}

function buildOverlayEntries(): OverlayDraft[] {
  const mapRows = readSheet(FILE_MAP, '知识地图');
  const detailRows = readSheet(FILE_DETAIL, '知识点总表');

  const byName = new Map<string, OverlayDraft>();

  // 先放「知识点总表」里独有的（同名会被「知识地图」覆盖）
  for (const row of detailRows) {
    const name = str(row, 3);
    if (!name) continue;
    const chapter = str(row, 1);
    const domain = str(row, 2);
    const seq = str(row, 0);
    const def = DEFAULTS[chapter] ?? FALLBACK_DEFAULT;
    byName.set(name, {
      name,
      entry: {
        id: `cne_wb_d${String(seq).padStart(3, '0')}`,
        subject: '英语',
        chapter,
        domain,
        name,
        subSkills: [],
        definition: str(row, 4),
        prerequisites: [],
        commonExamForms: [str(row, 5)].filter(Boolean),
        commonTraps: [str(row, 7)].filter(Boolean),
        examWeight: def.weight,
        learningCostHours: def.hours,
        relatedKnowledgeIds: [],
        sourceId: seq,
      },
    });
  }

  // 「知识地图」优先（同名时覆盖）
  for (const row of mapRows) {
    const name = str(row, 4);
    if (!name) continue;
    const chapter = str(row, 1);
    const domain = str(row, 2);
    const code = str(row, 0);
    const def = DEFAULTS[chapter] ?? FALLBACK_DEFAULT;
    byName.set(name, {
      name,
      entry: {
        id: codeToId(code),
        subject: '英语',
        chapter,
        domain,
        name,
        subSkills: [],
        definition: str(row, 5),
        prerequisites: [],
        commonExamForms: [str(row, 6)].filter(Boolean),
        commonTraps: [str(row, 8)].filter(Boolean),
        examWeight: def.weight,
        learningCostHours: def.hours,
        relatedKnowledgeIds: [],
        sourceId: code,
      },
    });
  }

  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// 题目
// ---------------------------------------------------------------------------

interface QuestionTypeDef {
  questionType: '选择' | '填空' | '解答' | '词汇语法';
  level: '基础题' | '变式题' | '迁移题' | '延迟复测';
  scoreValue: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
}

/** 题型 → 题面属性。完形/阅读按阅读理解处理，映射为「选择」。 */
const TYPE_DEFS: Record<string, QuestionTypeDef> = {
  语法选择: { questionType: '选择', level: '基础题', scoreValue: 2, difficulty: 3 },
  词形转换: { questionType: '词汇语法', level: '基础题', scoreValue: 2, difficulty: 3 },
  句型转换: { questionType: '词汇语法', level: '变式题', scoreValue: 3, difficulty: 4 },
  '阅读问答 D篇': { questionType: '解答', level: '变式题', scoreValue: 4, difficulty: 4 },
  首字母填空: { questionType: '填空', level: '变式题', scoreValue: 3, difficulty: 4 },
  '完形/阅读': { questionType: '选择', level: '变式题', scoreValue: 4, difficulty: 4 },
  作文: { questionType: '解答', level: '迁移题', scoreValue: 6, difficulty: 5 },
};

/** 从题干里解析 A/B/C/D 选项 */
function parseOptions(stem: string): string[] | undefined {
  const idx = stem.search(/(?:^|\s)A\.\s/);
  if (idx < 0) return undefined;
  const parts = stem.slice(idx).split(/\s+(?=[A-D]\.\s)/);
  const options = parts
    .map((p) => p.replace(/^[A-D]\.\s*/, '').trim())
    .filter((p) => p.length > 0);
  return options.length >= 2 ? options : undefined;
}

/** 当前生效知识资产的知识点 id（用于外键自检） */
function loadActiveKnowledgeIds(): Set<string> {
  const dir = path.join(DATA_DIR, 'knowledge');
  if (!fs.existsSync(dir)) return new Set();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const readable: Array<{ parsed: { status?: string; knowledgePoints?: Array<{ id: string }> } }> = [];
  for (const file of files) {
    try {
      readable.push({
        parsed: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
      });
    } catch {
      // 跳过损坏文件
    }
  }
  const active =
    readable.find((r) => r.parsed.status === 'ACTIVE') ?? readable[readable.length - 1];
  if (!active) return new Set();
  return new Set((active.parsed.knowledgePoints ?? []).map((k) => k.id));
}

interface BuiltQuestion {
  id: string;
  region: '上海';
  grade: '初三';
  subject: '英语';
  questionType: string;
  level: string;
  stem: string;
  options?: string[];
  standardAnswer: string;
  scoreValue: number;
  difficulty: number;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

function buildQuestions(
  overlay: OverlayDraft[]
): {
  questions: BuiltQuestion[];
  skipped: number;
  unresolved: string[];
  manualTopics: string[];
  autoTopics: string[];
} {
  const truthRows = readSheet(FILE_MANUAL, '真题拆解');

  const nameToId = new Map(overlay.map((o) => [o.name, o.entry.id]));
  const names = overlay.map((o) => o.name);

  const questions: BuiltQuestion[] = [];
  const unresolved: string[] = [];
  const manualTopics = new Set<string>();
  const autoTopics = new Set<string>();
  let skipped = 0;
  let seq = 1;

  for (const row of truthRows) {
    const qno = str(row, 2);
    // 「回忆」「趋势」两行是元信息，不是可作答题目
    if (qno === '回忆' || qno === '趋势') {
      skipped++;
      continue;
    }

    const type = str(row, 1);
    const def = TYPE_DEFS[type];
    if (!def) throw new Error(`未知题型：${type}`);

    const topic = str(row, 5);
    let targetName = MANUAL_TOPIC_MAP[topic];
    if (targetName) {
      manualTopics.add(topic);
    } else {
      targetName = autoMatchTopic(topic, names);
      autoTopics.add(topic);
    }
    if (!targetName || !nameToId.has(targetName)) {
      unresolved.push(topic);
      continue;
    }

    const steps: string[] = [];
    const key = str(row, 6);
    const move = str(row, 8);
    if (key) steps.push(`得分关键：${key}`);
    if (move) steps.push(`迁移动作：${move}`);
    if (steps.length === 0) steps.push('按题干要求逐项作答。');

    const stem = str(row, 3);
    const options = parseOptions(stem);

    questions.push({
      id: `cne_wb_q${String(seq).padStart(3, '0')}`,
      region: '上海',
      grade: '初三',
      subject: '英语',
      questionType: def.questionType,
      level: def.level,
      stem,
      ...(options ? { options } : {}),
      standardAnswer: str(row, 4),
      scoreValue: def.scoreValue,
      difficulty: def.difficulty,
      solutionSteps: steps,
      commonErrors: [str(row, 7)].filter(Boolean),
      knowledgeIds: [nameToId.get(targetName)!],
    });
    seq++;
  }

  return {
    questions,
    skipped,
    unresolved: [...new Set(unresolved)],
    manualTopics: [...manualTopics],
    autoTopics: [...autoTopics],
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const status: KnowledgeOverlaySet['status'] = args.promote ? 'ACTIVE' : 'DRAFT';

  console.log('┌─ workbuddy 上海中考英语 → overlay + 题库导入');

  const overlay = buildOverlayEntries();
  const entries = overlay.map((o) => o.entry);

  // id 唯一性 + 原生 id 校验
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`overlay id 重复：${e.id}`);
    ids.add(e.id);
    if (!/^(cnm|cne|cnc|cnp|cnk)(_[a-z0-9]+)+$/.test(e.id)) {
      throw new Error(`overlay id 不是项目原生 id：${e.id}`);
    }
  }

  const { questions, skipped, unresolved, manualTopics, autoTopics } =
    buildQuestions(overlay);
  if (unresolved.length > 0) {
    throw new Error(`以下考点未能映射到知识点：${unresolved.join(', ')}`);
  }

  // 外键自检：题目的 knowledgeIds 必须能解析到 overlay 条目或现有知识点
  const knownIds = loadActiveKnowledgeIds();
  for (const id of ids) knownIds.add(id);
  for (const q of questions) {
    if (q.knowledgeIds.length === 0) throw new Error(`题目 ${q.id} 没有知识点`);
    for (const k of q.knowledgeIds) {
      if (!knownIds.has(k)) {
        throw new Error(`题目 ${q.id} 的知识点 ${k} 既不在 overlay 也不在知识资产里`);
      }
    }
  }

  const manualCount = Object.keys(MANUAL_TOPIC_MAP).length;

  console.log(`│  overlay 条目：${entries.length} 条`);
  console.log(`│  题目：${questions.length} 道（跳过元信息行 ${skipped} 行）`);
  console.log(
    `│  考点映射：人工表 ${manualCount} 条（本次命中 ${manualTopics.length} 个考点）+ 机器兜底 ${autoTopics.length} 个考点`
  );

  if (args.dryRun) {
    console.log('└─ --dry-run：未写入任何文件');
    return;
  }

  const overlayDir = path.join(DATA_DIR, 'overlays');
  const questionDir = path.join(DATA_DIR, 'questions');
  fs.mkdirSync(overlayDir, { recursive: true });
  fs.mkdirSync(questionDir, { recursive: true });

  const set: KnowledgeOverlaySet = {
    version: OVERLAY_VERSION,
    publishedAt: args.publishedAt,
    status,
    source: {
      repo: 'resources/workbuddy-research',
      path: '上海中考英语完整知识地图.xlsx + 核心知识点详解表.xlsx',
      license: '见 resources/workbuddy-research 内的原始说明',
      note: '上海中考英语知识地图 + 核心知识点详解表合并去重',
    },
    entries,
  };

  const bank = {
    version: BANK_VERSION,
    questions,
  };

  const overlayFile = path.join(overlayDir, `${OVERLAY_VERSION}.json`);
  const bankFile = path.join(questionDir, 'bank-workbuddy-english-2026.02.json');

  for (const file of [overlayFile, bankFile]) {
    if (!fs.existsSync(file) || !args.force) continue;
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as { status?: string };
    if (existing.status === 'ACTIVE') {
      console.error(`\n✗ 拒绝覆盖已是 ACTIVE 的资产：${file}`);
      console.error('  请先归档，或显式加 --force。');
      process.exit(1);
    }
  }

  fs.writeFileSync(overlayFile, JSON.stringify(set, null, 2) + '\n', 'utf8');
  fs.writeFileSync(bankFile, JSON.stringify(bank, null, 2) + '\n', 'utf8');

  console.log(`│  ✓ 已写入：${overlayFile}（${entries.length} 条，${status}）`);
  console.log(`│  ✓ 已写入：${bankFile}（${questions.length} 道）`);
  console.log(`│  状态：${status}`);
  if (status === 'DRAFT') {
    console.log('│         ↳ DRAFT 不生效（加载器只加载 ACTIVE overlay 资产）');
  }
  console.log('└─ 完成');
}

main();
