/**
 * 易错（错因）资源 → daydayup 错因资产（TrapSet）导入脚本。
 *
 * 运行：
 *   npm run import:traps --workspace=@daydayup/server
 *   npm run import:traps --workspace=@daydayup/server -- --source=cn-mt --dry-run
 *   npm run import:traps --workspace=@daydayup/server -- --source=atlas,cst --report
 *   npm run import:traps --workspace=@daydayup/server -- --source=cn-mt --promote
 *
 * ── 与 import-taxonomy 的关系 ──────────────────────────────────────────
 *
 * 知识资产（cn-mt 全量知识点/题库）由 `import-taxonomy.ts` 负责；
 * **错因资产单独一层**，因为：
 *   - 来源多、授权不同 → 必须能单独下架某个来源；
 *   - 匹配置信度不同 → 中等置信度必须人工确认后才能发布；
 *   - 更新频率不同 → 错因不需要跟着知识体系整体重导。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. **默认写 DRAFT**：错因直接进 AI 教练与出题提示词，未经审核不得上线。
 * 2. **不覆盖现行 ACTIVE 资产**：需要 `--force`。
 * 3. **外键校验**：条目的 knowledgeId 必须存在于当前生效的知识资产里。
 * 4. **许可闸门**：来源许可未确认（如 junior-math-atlas）时禁止 `--promote`，
 *    必须显式 `--confirm-license="<许可文本>"`。
 * 5. **不凭空生成**：错因文本全部取自源项目原句，源数据没写错因就留空。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TrapConfidence, TrapEntry, TrapSet } from '@daydayup/contracts';
import {
  buildAtlasTopics,
  buildCstResearchTopics,
  convertAtlasPoints,
  convertCnMtTrapQuestions,
  convertCnMtTrapTopics,
  convertCstCourses,
  convertCstRefuteQuestions,
  convertCstTeachingResearch,
  cstGradeRangeToStage,
  type AtlasPoint,
  type CnMtQuestionLike,
  type CnMtTopicLike,
  type CstCourse,
  type CstQuestionLike,
  type CstResearchRecord,
  type CstTopicLike,
  type TrapCandidate,
} from '../src/infrastructure/knowledge/converters/traps.ts';
import {
  convertEnActionEntries,
  convertEnDetailEntries,
  convertEnMapEntries,
  enMapCodeToId,
  matchEnName,
  normalizeEnName,
  type EnDetailEntry,
  type EnMapEntry,
} from '../src/infrastructure/knowledge/converters/traps-en-map.ts';
import {
  EN_MAP_FILES,
  loadEnActionEntries,
  loadEnDetailEntries,
  loadEnMapEntries,
} from '../src/infrastructure/knowledge/converters/traps-en-map-source.ts';
import {
  buildKnowledgeIndex,
  matchTrapCandidates,
  resolveIndexStage,
  type KnowledgeIndex,
} from '../src/infrastructure/knowledge/trap-matcher.ts';
import {
  assignEvidence,
  type EvidenceAsset,
  type EvidenceAssignment,
  type EvidenceTopic,
} from '../src/infrastructure/knowledge/trap-evidence.ts';
import { parseChapterScope } from '../src/infrastructure/knowledge/trap-text.ts';

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
  repo: string;
  /** 相对仓库根的目录 */
  relPath: string;
  license: string;
  licenseUrl?: string;
  /** 许可是否已确认。false → 禁止 --promote */
  licenseConfirmed: boolean;
  note?: string;
  /** 默认是否纳入（--source 默认取这些） */
  defaultOn: boolean;
}

const SOURCES: Record<string, SourceDef> = {
  'cn-mt': {
    key: 'cn-mt',
    repo: 'cn-math-taxonomy',
    relPath: 'resources/cn-math-taxonomy',
    license: 'CC BY-NC 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    licenseConfirmed: true,
    note: '非商业许可：产品商业化前须取得作者商业授权',
    defaultOn: true,
  },
  atlas: {
    key: 'atlas',
    repo: 'junior-math-atlas',
    relPath: 'resources/junior-math-atlas',
    license: '作者自有原创（2026-11-19 作者确认权利并授权 daydayup 使用与发布；仓库仍缺 LICENSE 文件）',
    // 闸门保留：每次 promote 仍须显式 --confirm-license，避免「口头确认」被当成
    // 可长期自动放行的许可状态。确认文本会写进产物的 source.license。
    licenseConfirmed: false,
    note: '作者已确认权利；promote 时须带 --confirm-license="<许可文本>"',
    defaultOn: false,
  },
  cst: {
    key: 'cst',
    repo: 'china-skill-taxonomy',
    relPath: 'resources/china-skill-taxonomy',
    license: 'ODbL 1.0（数据库层）+ CC BY-SA 4.0（原创文本）',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    licenseConfirmed: true,
    note: '需署名；衍生数据库须保持同许可开放',
    defaultOn: false,
  },
  'en-map': {
    key: 'en-map',
    repo: 'workbuddy-english-map',
    relPath: 'resources/workbuddy-research',
    license: '自有原创（2026-11-19 作者确认权利并授权 daydayup 使用与发布；仓库仍缺 LICENSE 文件）',
    // 闸门保留：每次 promote 仍须显式 --confirm-license
    licenseConfirmed: false,
    note: '上海中考英语知识地图 + 核心知识点详解表 + 提分实战手册；作者已确认权利',
    defaultOn: false,
  },
};

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface CliArgs {
  sources: string[];
  versionSuffix: string;
  publishedAt: string;
  dryRun: boolean;
  promote: boolean;
  publish: boolean;
  force: boolean;
  report: boolean;
  /** 允许把 medium 置信度的条目一并写入（视为人工已确认） */
  allowMedium: boolean;
  confirmLicense?: string;
  manualMapFile: string;
  /** 匹配策略：auto（atlas/cst 用证据匹配）/ evidence / candidate */
  strategy: 'auto' | 'evidence' | 'candidate';
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sources: [],
    versionSuffix: '2026.11',
    publishedAt: '2026-11-18T00:00:00.000Z',
    dryRun: false,
    promote: false,
    publish: false,
    force: false,
    report: false,
    allowMedium: false,
    manualMapFile: path.join(DATA_DIR, 'traps', 'id-map.json'),
    strategy: 'auto',
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
      case 'publish':
        args.publish = true;
        break;
      case 'promote':
        args.promote = true;
        args.publish = true;
        break;
      case 'force':
        args.force = true;
        break;
      case 'report':
        args.report = true;
        break;
      case 'allow-medium':
        args.allowMedium = true;
        break;
      case 'confirm-license':
        args.confirmLicense = value;
        break;
      case 'manual-map':
        args.manualMapFile = path.resolve(value);
        break;
      case 'strategy':
        if (value !== 'auto' && value !== 'evidence' && value !== 'candidate') {
          console.error(`未知策略：${value}（可用：auto / evidence / candidate）`);
          process.exit(1);
        }
        args.strategy = value;
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
用法：npm run import:traps --workspace=@daydayup/server -- [选项]

选项：
  --source=<a,b>          来源：cn-mt（默认）/ atlas / cst，或 all
  --version-suffix=<s>    版本后缀（默认 2026.11）
  --published-at=<iso>    发布时间（默认固定值，保证幂等）
  --publish               写入正式目录（data/traps），产物仍为 DRAFT
  --promote               审核通过：产出 ACTIVE 资产并发布到正式目录
  --allow-medium          允许把 medium 置信度条目写入（视为人工已确认）
  --confirm-license=<t>   确认来源许可文本（许可未确认的来源 promote 时必填）
  --manual-map=<file>     人工 id 映射表（默认 data/traps/id-map.json）
  --strategy=<s>          匹配策略：auto（默认，atlas/cst 走证据匹配）/ evidence / candidate
  --report                打印匹配明细与待审清单，并导出待审文件
  --dry-run               只打印统计，不写文件
  --force                 允许覆盖已是 ACTIVE 的现有错因资产

注意：
  - 默认产物 status=DRAFT；错因会进 AI 教练提示词，必须审核后才 promote
  - 许可未确认的来源（junior-math-atlas）禁止 --promote
  - 错因文本全部来自源项目原句，脚本不会生成任何易错点
  - 证据匹配（atlas/cst）：知识点在「同册同章」的来源主题里找证据最强的一篇，整篇继承
`);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `不是合法 JSON：${file}\n${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** 读取当前生效的知识资产，用于建索引与外键校验 */
function loadActiveKnowledge(): {
  version: string;
  knowledgePoints: Array<{
    id: string;
    name: string;
    subject: string;
    chapter?: string;
    subSkills?: string[];
    definition?: string;
  }>;
} {
  const dir = path.join(DATA_DIR, 'knowledge');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: { status?: string } & Record<string, unknown> }> = [];
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

  const parsed = active.parsed as unknown as {
    version: string;
    knowledgePoints: Array<{
      id: string;
      name: string;
      subject: string;
      chapter?: string;
      subSkills?: string[];
      definition?: string;
    }>;
  };
  return parsed;
}

/**
 * 读取 ACTIVE 叠加层的知识点（英语等）。
 *
 * 叠加层知识点 id 形如 `cne_wb_*`，在运行时由 `applyKnowledgeOverlays` 追加到
 * 知识资产里。错因资产若要挂到这些点上，导入时的索引必须认识它们，
 * 否则 source-topic 匹配会全部落空（英语知识地图就是这种情况）。
 */
function loadActiveOverlayKnowledgePoints(): Array<{
  id: string;
  name: string;
  subject: string;
  chapter?: string;
}> {
  const dir = path.join(DATA_DIR, 'overlays');
  if (!fs.existsSync(dir)) return [];

  const out: Array<{ id: string; name: string; subject: string; chapter?: string }> = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let parsed: {
      status?: string;
      entries?: Array<{ id: string; name: string; subject?: string; chapter?: string }>;
    };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (parsed.status !== 'ACTIVE') continue;
    for (const e of parsed.entries ?? []) {
      if (!e?.id || !e?.name) continue;
      out.push({
        id: e.id,
        name: e.name,
        subject: e.subject ?? '',
        ...(e.chapter ? { chapter: e.chapter } : {}),
      });
    }
  }
  return out;
}

function loadManualMap(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const parsed = readJson<Record<string, string>>(file);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * 当前生效题库的题目 id 集合（用于校验题目级错因的外键）。
 * 题库不存在时返回 null —— 表示不做校验。
 */
function loadQuestionBankIds(): Set<string> | null {
  const dir = path.join(DATA_DIR, 'questions');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files.reverse()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const list: Array<{ id?: string }> = Array.isArray(parsed)
        ? parsed
        : (parsed.questions ?? []);
      if (list.length > 0) return new Set(list.map((q) => q.id).filter(Boolean) as string[]);
    } catch {
      // 跳过损坏文件
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 各来源的候选构造
// ---------------------------------------------------------------------------

function candidatesForCnMt(sourceDir: string): TrapCandidate[] {
  const topics = readJson<CnMtTopicLike[]>(path.join(sourceDir, 'data', 'topics.json'));
  const questions = readJson<CnMtQuestionLike[]>(
    path.join(sourceDir, 'data', 'questions.json')
  );
  return [
    ...convertCnMtTrapTopics(topics),
    ...convertCnMtTrapQuestions(questions),
  ];
}

function candidatesForAtlas(sourceDir: string): TrapCandidate[] {
  const pointsDir = path.join(sourceDir, 'content', 'points');
  const files = fs
    .readdirSync(pointsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const points = files.map(
    (f) => readJson<AtlasPoint>(path.join(pointsDir, f))
  );
  return convertAtlasPoints(points);
}

/**
 * workbuddy 上海中考英语 → 错因候选。
 *
 * 三份资源各自独立：
 *   - 知识地图 338 条 → 落点 `cne_wb_<code>`（叠加层知识点，source-topic 精确命中）
 *   - 详解表 169 条 → 落点 `cne_wb_dNNN`（叠加层知识点）
 *   - 抢分动作 19 条 → 没有知识点 id，进待审池（教师确认考点后补 id-map.json）
 *
 * 另有一路**主资产高置信挂载**：地图/详解表的知识点名与主资产英语点的名称
 * 做 exact / prefix / suffix 匹配（排除泛成分名，地图名 ≥ 3 字）。
 * 地图是语法/题型视角、主资产是教材单元视角，两者大面积不重合，
 * 实测只能覆盖约 51/791 个主资产点 —— 这正是英语侧错因覆盖的真实上限。
 */
function candidatesForEnMap(
  sourceDir: string,
  knowledge: KnowledgeLike[]
): { candidates: TrapCandidate[]; mainAssetHits: number } {
  const mapEntries: EnMapEntry[] = loadEnMapEntries(
    path.join(sourceDir, '上海中考英语完整知识地图.xlsx')
  );
  const detailEntries: EnDetailEntry[] = loadEnDetailEntries(
    path.join(sourceDir, '上海中考英语核心知识点详解表.xlsx')
  );
  const actionEntries = loadEnActionEntries(
    path.join(sourceDir, '上海中考英语提分实战手册.xlsx')
  );

  // 详解表与地图同名的 39 行：叠加层里地图条目优先，详解表自己的
  // `cne_wb_dNNN` id 并不存在 → 按名字回退到地图条目的 id。
  // 注意：此时叠加层保留的是**地图那句**，详解表那句更细 → 会作为
  // 独立一条挂在同一个点上（`applyTrapSets` 是追加语义，两句都在）。
  const mapIdByName = new Map<string, string>();
  for (const e of mapEntries) mapIdByName.set(e.name, enMapCodeToId(e.code));

  const candidates: TrapCandidate[] = [
    ...convertEnMapEntries(mapEntries),
    ...convertEnDetailEntries(detailEntries, (e, defaultId) => {
      const fallback = mapIdByName.get(e.name);
      return fallback ?? defaultId;
    }),
    ...convertEnActionEntries(actionEntries),
  ];

  // 主资产高置信挂载：知识点名 ← 地图名/详解表名的 exact / prefix / suffix
  const namePool = [
    ...mapEntries.map((e) => e.name),
    ...detailEntries.map((e) => e.name),
  ].filter(Boolean);

  const mainAssetEnglish = knowledge.filter((k) => k.subject === '英语');

  // 名称 → 候选条目（一个知识点名可能对应多条资源条目）
  const poolByName = new Map<string, TrapCandidate[]>();
  for (const c of candidates) {
    if (!c.topicName) continue;
    const key = normalizeEnName(c.topicName);
    if (!key) continue;
    const list = poolByName.get(key) ?? [];
    list.push(c);
    poolByName.set(key, list);
  }

  let mainAssetHits = 0;
  for (const kp of mainAssetEnglish) {
    const m = matchEnName(kp.name, namePool);
    if (!m) continue;
    const key = normalizeEnName(m.matched);
    const linked = poolByName.get(key) ?? [];
    if (linked.length === 0) continue;
    mainAssetHits++;

    for (const c of linked) {
      candidates.push({
        ...c,
        id: `${c.id}@main:${kp.id}`,
        sourceTopicId: kp.id,
        // 名称完全相等才算高置信；前后缀包含算「已人工核对」
        matchConfidenceHint: m.kind,
      } as TrapCandidate);
    }
  }

  return { candidates, mainAssetHits };
}

function candidatesForCst(sourceDir: string): TrapCandidate[] {
  const coursesDir = path.join(sourceDir, 'courses');
  const dirs = fs.readdirSync(coursesDir);
  const courses: CstCourse[] = [];
  for (const d of dirs) {
    const file = path.join(coursesDir, d, 'content.json');
    if (!fs.existsSync(file)) continue;
    courses.push(readJson<CstCourse>(file));
  }

  // 教学研究（assess.errors + nextMoves）
  const researchFile = path.join(sourceDir, 'data', 'teaching-research.json');
  const research = fs.existsSync(researchFile)
    ? readJson<{ records?: CstResearchRecord[] }>(researchFile).records ?? []
    : [];

  // 主题表（给 refute 题目补主题名/学科/学段）
  const topicsFile = path.join(sourceDir, 'data', 'topics.json');
  const topicList = fs.existsSync(topicsFile)
    ? readJson<{ topics?: CstTopicLike[] }>(topicsFile).topics ?? []
    : [];
  const topicById = new Map(topicList.map((t) => [t.id, t]));

  // 题目里的 refute（错误选项 → 为什么错）
  const questionsFile = path.join(sourceDir, 'data', 'questions.json');
  const questions = fs.existsSync(questionsFile)
    ? readJson<{ questions?: CstQuestionLike[] }>(questionsFile).questions ?? []
    : [];

  return [
    ...convertCstCourses(courses),
    ...convertCstTeachingResearch(research),
    ...convertCstRefuteQuestions(questions, topicById),
  ];
}

// ---------------------------------------------------------------------------
// 证据策略（资产为中心）
// ---------------------------------------------------------------------------

type KnowledgeLike = {
  id: string;
  name: string;
  subject: string;
  chapter?: string;
  subSkills?: string[];
  definition?: string;
};

/** 知识点 → 证据资产 */
function buildEvidenceAssets(knowledge: KnowledgeLike[]): EvidenceAsset[] {
  return knowledge.map((k) => ({
    id: k.id,
    name: k.name,
    subject: k.subject,
    stage: resolveIndexStage(k),
    scope: parseChapterScope(k.chapter),
    subSkills: k.subSkills ?? [],
    definition: k.definition ?? '',
  }));
}

/** atlas 的来源主题（83 篇） */
function evidenceTopicsForAtlas(sourceDir: string): EvidenceTopic[] {
  const pointsDir = path.join(sourceDir, 'content', 'points');
  const files = fs
    .readdirSync(pointsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const points = files.map((f) => readJson<AtlasPoint>(path.join(pointsDir, f)));
  return buildAtlasTopics(points);
}

/**
 * cst 的来源主题（教学研究记录）。
 *
 * 课例提示与题目反驳按 topicId 归并到同一个主题 —— 它们讲的是同一件事，
 * 合并后该主题的正文更完整、证据更容易命中。
 *
 * 学段判定不明确的记录（跨学段年级区间）**不参与**证据匹配：
 * 宁可漏挂，也不要把小学的内容挂到初中知识点上。
 */
function evidenceTopicsForCst(sourceDir: string): EvidenceTopic[] {
  const researchFile = path.join(sourceDir, 'data', 'teaching-research.json');
  const records = fs.existsSync(researchFile)
    ? readJson<{ records?: CstResearchRecord[] }>(researchFile).records ?? []
    : [];

  const topicsFile = path.join(sourceDir, 'data', 'topics.json');
  const topicList = fs.existsSync(topicsFile)
    ? readJson<{ topics?: CstTopicLike[] }>(topicsFile).topics ?? []
    : [];
  const topicById = new Map(topicList.map((t) => [t.id, t]));

  const questionsFile = path.join(sourceDir, 'data', 'questions.json');
  const questions = fs.existsSync(questionsFile)
    ? readJson<{ questions?: CstQuestionLike[] }>(questionsFile).questions ?? []
    : [];

  const coursesDir = path.join(sourceDir, 'courses');
  const courses: CstCourse[] = [];
  if (fs.existsSync(coursesDir)) {
    for (const d of fs.readdirSync(coursesDir)) {
      const file = path.join(coursesDir, d, 'content.json');
      if (!fs.existsSync(file)) continue;
      courses.push(readJson<CstCourse>(file));
    }
  }

  // 额外条目按 topicId 归并
  const extraItems = new Map<string, TrapCandidate[]>();
  const addExtra = (topicId: string | undefined, item: TrapCandidate) => {
    if (!topicId) return;
    const list = extraItems.get(topicId) ?? [];
    list.push(item);
    extraItems.set(topicId, list);
  };

  for (const course of courses) {
    for (const item of convertCstCourses([course])) {
      addExtra(course.topicId, item);
    }
  }
  for (const item of convertCstRefuteQuestions(questions, topicById)) {
    const q = questions.find((x) => x.id === item.sourceId);
    addExtra(q?.topicId, item);
  }

  const scoped = records.filter(
    (r) => cstGradeRangeToStage(r.gradeRangeStart, r.gradeRangeEnd) !== ''
  );

  // topics.json 的主题表用于**正文富化**：主题名 / 描述 / 表现性证据 / 测评提示语
  // 全部是源文本原句，并入正文让「这篇确实讲这个点」有据可查。
  return buildCstResearchTopics(scoped, extraItems, topicById);
}

interface EvidenceOutcome {
  entries: TrapEntry[];
  unmatched: TrapEntry[];
  assignments: EvidenceAssignment[];
  topicCount: number;
}

/** 证据策略：知识点 ← 来源主题，整篇继承 */
function runEvidenceStrategy(
  topics: EvidenceTopic[],
  assets: EvidenceAsset[],
  assetById: Map<string, EvidenceAsset>
): EvidenceOutcome {
  const { assignments, unmatchedTopicIds } = assignEvidence(assets, topics);
  const entries: TrapEntry[] = [];
  const topicById = new Map(topics.map((t) => [t.id, t]));

  for (const a of assignments) {
    const asset = assetById.get(a.assetId);
    for (const item of a.topic.items) {
      entries.push({
        id: `${item.id}@${a.assetId}`,
        knowledgeId: a.assetId,
        questionIds: item.questionIds ?? [],
        subject: asset?.subject ?? item.subject,
        stage: asset?.stage ?? item.stage,
        matchConfidence: a.confidence,
        matchMethod: 'evidence',
        wrong: item.wrong,
        why: item.why,
        right: item.right,
        sourceId: item.sourceId,
        ...(item.sourceText ? { sourceText: item.sourceText } : {}),
      });
    }
  }

  // 没有被任何知识点采纳的主题 → 待审池
  const unmatched: TrapEntry[] = [];
  for (const topicId of unmatchedTopicIds) {
    const topic = topicById.get(topicId);
    if (!topic) continue;
    for (const item of topic.items) {
      unmatched.push({
        id: item.id,
        knowledgeId: null,
        questionIds: item.questionIds ?? [],
        subject: item.subject,
        stage: item.stage,
        matchConfidence: 'unmatched',
        matchMethod: 'none',
        wrong: item.wrong,
        why: item.why,
        right: item.right,
        sourceId: item.sourceId,
        ...(item.sourceText ? { sourceText: item.sourceText } : {}),
      });
    }
  }

  return { entries, unmatched, assignments, topicCount: topics.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const sourceKeys =
    args.sources.includes('all')
      ? Object.keys(SOURCES)
      : args.sources;

  for (const key of sourceKeys) {
    if (!SOURCES[key]) {
      console.error(`未知来源：${key}（可用：${Object.keys(SOURCES).join(', ')}）`);
      process.exit(1);
    }
  }

  console.log('┌─ 易错资源 → daydayup 错因资产（TrapSet）导入');
  console.log(`│  来源：${sourceKeys.join(', ')}`);

  const knowledge = loadActiveKnowledge();
  // 错因资产可以挂在**叠加层知识点**上（英语知识地图的 code → `cne_wb_*`），
  // 所以索引必须同时包含主资产与 ACTIVE 叠加层，否则 source-topic 匹配会全部落空。
  const overlayPoints = loadActiveOverlayKnowledgePoints();
  const index: KnowledgeIndex = buildKnowledgeIndex([
    ...knowledge.knowledgePoints,
    ...overlayPoints,
  ]);
  const manualMap = loadManualMap(args.manualMapFile);

  console.log(
    `│  知识资产版本：${knowledge.version}（${knowledge.knowledgePoints.length} 个知识点）`
  );
  if (overlayPoints.length > 0) {
    console.log(`│  叠加层知识点：${overlayPoints.length} 个（用于英语等叠加层错因落点）`);
  }
  if (Object.keys(manualMap).length > 0) {
    console.log(`│  人工映射表：${Object.keys(manualMap).length} 条`);
  }

  const status: TrapSet['status'] = args.promote ? 'ACTIVE' : 'DRAFT';

  // ---- 逐来源转换 + 匹配 ----
  const allEntries: TrapEntry[] = [];
  const perSource: Array<{
    def: SourceDef;
    candidates: number;
    entries: TrapEntry[];
    unmatched: TrapEntry[];
  }> = [];

  /** 证据策略下：知识点 id → 最高置信度（跨来源合并用） */
  const evidenceCoverage = new Map<string, TrapConfidence>();
  /** 证据策略下：知识点 id → 采纳的来源主题明细 */
  const evidenceDetail = new Map<
    string,
    { confidence: TrapConfidence; sourceRepo: string; topicId: string; title: string; score: number; reason: string }
  >();

  for (const key of sourceKeys) {
    const def = SOURCES[key];
    const sourceDir = path.join(REPO_ROOT, def.relPath);

    if (!fs.existsSync(sourceDir)) {
      console.error(`│  ✗ 来源目录不存在：${sourceDir}`);
      process.exit(1);
    }

    const useEvidence =
      args.strategy === 'evidence' ||
      (args.strategy === 'auto' && (key === 'atlas' || key === 'cst'));

    if (useEvidence && key === 'cn-mt') {
      console.error('│  ✗ cn-mt 只有条目级候选，没有来源主题，无法走证据策略');
      process.exit(1);
    }

    if (useEvidence) {
      const topics =
        key === 'atlas'
          ? evidenceTopicsForAtlas(sourceDir)
          : evidenceTopicsForCst(sourceDir);
      const assets = buildEvidenceAssets(knowledge.knowledgePoints);
      const assetById = new Map(assets.map((a) => [a.id, a]));
      const outcome = runEvidenceStrategy(topics, assets, assetById);

      const kept = outcome.entries.filter(
        (e) =>
          e.matchConfidence !== 'unmatched' &&
          (args.allowMedium || e.matchConfidence === 'high')
      );
      const droppedMedium = outcome.entries.filter(
        (e) => e.matchConfidence === 'medium' && !args.allowMedium
      );

      const highAssets = new Set(
        outcome.assignments.filter((a) => a.confidence === 'high').map((a) => a.assetId)
      );
      const mediumAssets = new Set(
        outcome.assignments.filter((a) => a.confidence === 'medium').map((a) => a.assetId)
      );
      for (const a of outcome.assignments) {
        const prev = evidenceCoverage.get(a.assetId);
        if (!prev || (prev === 'medium' && a.confidence === 'high')) {
          evidenceCoverage.set(a.assetId, a.confidence);
        }
        const prevDetail = evidenceDetail.get(a.assetId);
        if (!prevDetail || (prevDetail.confidence === 'medium' && a.confidence === 'high')) {
          evidenceDetail.set(a.assetId, {
            confidence: a.confidence,
            sourceRepo: a.topic.repo,
            topicId: a.topic.id,
            title: a.topic.title,
            score: a.score,
            reason: a.reason,
          });
        }
      }

      console.log('│');
      console.log(`│  ▸ ${def.repo}（证据匹配）`);
      console.log(
        `│    来源主题 ${outcome.topicCount} 篇 → 采纳 ${outcome.assignments.length} 个知识点（high ${highAssets.size} / medium ${mediumAssets.size}）`
      );
      console.log(
        `│    证据类型：${Object.entries(
          outcome.assignments.reduce<Record<string, number>>((acc, a) => {
            acc[a.reason] = (acc[a.reason] ?? 0) + 1;
            return acc;
          }, {})
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(' / ')}`
      );
      console.log(`│    条目：${outcome.entries.length} 条（未采纳主题 ${outcome.unmatched.length} 条进待审池）`);
      if (droppedMedium.length > 0) {
        console.log(
          `│    ⨯ 丢弃 medium ${droppedMedium.length} 条（需 --allow-medium 或人工确认后写入）`
        );
      }

      perSource.push({
        def,
        candidates: outcome.entries.length,
        entries: kept,
        unmatched: outcome.unmatched,
      });
      allEntries.push(...kept);
      continue;
    }

    let candidates: TrapCandidate[];
    let enMapMainHits = 0;
    if (key === 'cn-mt') {
      candidates = candidatesForCnMt(sourceDir);
    } else if (key === 'atlas') {
      candidates = candidatesForAtlas(sourceDir);
    } else if (key === 'en-map') {
      const built = candidatesForEnMap(sourceDir, knowledge.knowledgePoints);
      candidates = built.candidates;
      enMapMainHits = built.mainAssetHits;
    } else {
      candidates = candidatesForCst(sourceDir);
    }

    const { entries, summary } = matchTrapCandidates(candidates, index, { manualMap });

    // medium 置信度：默认不写入（红线：必须人工确认）
    const kept = entries.filter(
      (e) => e.matchConfidence !== 'unmatched' && (args.allowMedium || e.matchConfidence === 'high')
    );
    const droppedMedium = entries.filter(
      (e) => e.matchConfidence === 'medium' && !args.allowMedium
    );

    console.log('│');
    console.log(`│  ▸ ${def.repo}`);
    console.log(`│    候选 ${candidates.length} 条 → 匹配 ${summary.total} 条`);
    console.log(
      `│    置信度：high ${summary.byConfidence.high} / medium ${summary.byConfidence.medium} / unmatched ${summary.byConfidence.unmatched}`
    );
    console.log(
      `│    方式：source-topic ${summary.byMethod['source-topic']} / manual-map ${summary.byMethod['manual-map']} / exact-name ${summary.byMethod['exact-name']} / exact-name-alias ${summary.byMethod['exact-name-alias']} / name-contains ${summary.byMethod['name-contains']}`
    );
    if (key === 'en-map') {
      console.log(
        `│    主资产英语点高置信挂载 ${enMapMainHits} 个（名称 exact/prefix/suffix，排除泛成分名）`
      );
    }
    if (droppedMedium.length > 0) {
      console.log(
        `│    ⨯ 丢弃 medium ${droppedMedium.length} 条（需 --allow-medium 或人工确认后写入）`
      );
    }

    perSource.push({
      def,
      candidates: candidates.length,
      entries: kept,
      unmatched: summary.unmatched,
    });
    allEntries.push(...kept);
  }

  // ---- 覆盖率（P1 验收口径：初中数学知识点的 commonTraps 覆盖率） ----
  if (evidenceCoverage.size > 0) {
    const juniorMath = knowledge.knowledgePoints.filter(
      (k) => k.subject === '数学' && resolveIndexStage(k) === '初中'
    );
    const coveredHigh = juniorMath.filter(
      (k) => evidenceCoverage.get(k.id) === 'high'
    );
    const coveredAny = juniorMath.filter((k) => evidenceCoverage.has(k.id));
    const pct = juniorMath.length
      ? (coveredHigh.length / juniorMath.length) * 100
      : 0;
    const pctAny = juniorMath.length
      ? (coveredAny.length / juniorMath.length) * 100
      : 0;
    console.log('│');
    console.log(
      `│  📊 初中数学知识点覆盖：high ${coveredHigh.length}/${juniorMath.length} = ${pct.toFixed(1)}%`
    );
    console.log(
      `│     含 medium：${coveredAny.length}/${juniorMath.length} = ${pctAny.toFixed(1)}%`
    );
    if (pct < 70) {
      console.log('│     ⚠ 低于 P1 验收线 70%（high 口径）');
    }
  }

  // ---- 外键校验：knowledgeId 必须存在于知识资产（含 ACTIVE 叠加层） ----
  const knowledgeIds = new Set<string>([
    ...knowledge.knowledgePoints.map((k) => k.id),
    ...overlayPoints.map((k) => k.id),
  ]);
  const dangling = allEntries.filter(
    (e) => e.knowledgeId && !knowledgeIds.has(e.knowledgeId)
  );
  if (dangling.length > 0) {
    console.error('│  ✗ 外键校验失败（knowledgeId 不在知识资产里）：');
    for (const d of dangling.slice(0, 10)) console.error(`│      ${d.id} → ${d.knowledgeId}`);
    process.exit(1);
  }
  console.log('│  ✓ 外键校验通过');

  // ---- 重复 id 检查 ----
  const ids = new Set<string>();
  const dupes = allEntries.filter((e) => (ids.has(e.id) ? true : (ids.add(e.id), false)));
  if (dupes.length > 0) {
    console.error(`│  ✗ 条目 id 重复：${dupes.slice(0, 5).map((d) => d.id).join(', ')}`);
    process.exit(1);
  }

  // ---- 题目外键校验：题目级错因的 questionIds 必须存在于当前题库 ----
  const questionIds = loadQuestionBankIds();
  let droppedQuestionIds = 0;
  let droppedEntries = 0;
  if (questionIds) {
    for (const entry of allEntries) {
      if (entry.questionIds.length === 0) continue;
      const keptIds = entry.questionIds.filter((id) => questionIds.has(id));
      droppedQuestionIds += entry.questionIds.length - keptIds.length;
      entry.questionIds = keptIds;
    }
    // 没有知识点、也没有有效题目的条目 —— 挂不上去，直接丢弃
    for (const s of perSource) {
      const before = s.entries.length;
      s.entries = s.entries.filter((e) => e.knowledgeId || e.questionIds.length > 0);
      droppedEntries += before - s.entries.length;
    }
    const keptAll = allEntries.filter((e) => e.knowledgeId || e.questionIds.length > 0);
    allEntries.length = 0;
    allEntries.push(...keptAll);
    console.log(
      `│  ✓ 题目外键校验通过（丢弃 ${droppedQuestionIds} 个未知题目 id，${droppedEntries} 条无落点条目）`
    );
  }

  // ---- 待审清单 ----
  if (args.report) {
    console.log('│');
    console.log('│  待审（未匹配到知识点）清单：');
    for (const s of perSource) {
      console.log(`│    ${s.def.repo}：${s.unmatched.length} 条`);
      for (const u of s.unmatched.slice(0, 5)) {
        console.log(`│      ${u.sourceId}｜${u.wrong.slice(0, 40)}`);
      }
      if (s.unmatched.length > 5) console.log(`│      ...共 ${s.unmatched.length} 条`);
    }
  }

  // ---- 许可闸门 ----
  if (args.promote) {
    for (const s of perSource) {
      if (s.def.licenseConfirmed) continue;
      if (!args.confirmLicense) {
        console.error('│');
        console.error(`✗ 来源「${s.def.repo}」许可未确认（${s.def.license}），禁止 --promote。`);
        console.error(`  确认后请加 --confirm-license="<许可文本>"，或改为先产出 DRAFT。`);
        process.exit(1);
      }
    }
  }

  if (args.dryRun) {
    console.log('│');
    console.log('└─ --dry-run：未写入任何文件');
    return;
  }

  // ---- 写盘 ----
  const outDir = args.publish
    ? path.join(DATA_DIR, 'traps')
    : path.join(DATA_DIR, 'staging', 'traps');
  fs.mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  for (const s of perSource) {
    const version = `traps-${s.def.repo}-${args.versionSuffix}`;
    const set: TrapSet = {
      version,
      publishedAt: args.publishedAt,
      status,
      subject:
        s.def.repo === 'cn-math-taxonomy'
          ? '全学科'
          : s.def.repo === 'junior-math-atlas'
            ? '数学'
            : s.def.repo === 'workbuddy-english-map'
              ? '英语'
              : '全学科',
      source: {
        repo: s.def.repo,
        path: s.def.relPath,
        license: args.confirmLicense && !s.def.licenseConfirmed ? args.confirmLicense : s.def.license,
        ...(s.def.licenseUrl ? { licenseUrl: s.def.licenseUrl } : {}),
        ...(s.def.note ? { note: s.def.note } : {}),
      },
      entries: s.entries,
    };

    const outFile = path.join(outDir, `${version}.json`);

    // 防覆盖 ACTIVE
    if (fs.existsSync(outFile) && !args.force) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { status?: string };
      if (existing.status === 'ACTIVE') {
        console.error(`\n✗ 拒绝覆盖已是 ACTIVE 的错因资产：${outFile}`);
        console.error('  请先归档，或显式加 --force。');
        process.exit(1);
      }
    }

    fs.writeFileSync(outFile, JSON.stringify(set, null, 2) + '\n', 'utf8');
    written.push(outFile);
    console.log(`│  ✓ 已写入：${outFile}（${s.entries.length} 条，${status}）`);
  }

  // ---- 待审表（导出成教师可读的匹配清单） ----
  if (args.report) {
    // 待审清单永远写在 staging 下：不进正式目录，避免被当成错因资产加载
    const reviewDir = path.join(DATA_DIR, 'staging', 'traps');
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewFile = path.join(reviewDir, `unmatched-${args.versionSuffix}.json`);
    const unmatched = perSource.flatMap((s) =>
      s.unmatched.map((e) => ({
        id: e.id,
        sourceRepo: s.def.repo,
        sourceId: e.sourceId,
        subject: e.subject,
        stage: e.stage,
        wrong: e.wrong,
        why: e.why,
        right: e.right,
        sourceText: e.sourceText ?? '',
      }))
    );
    fs.writeFileSync(
      reviewFile,
      JSON.stringify(unmatched, null, 2) + '\n',
      'utf8'
    );
    console.log(`│  ✓ 待审清单：${reviewFile}（${unmatched.length} 条）`);

    // 覆盖率明细：哪些知识点拿到了错因、来自哪一篇、证据是什么；
    // 没拿到的也要列出来 —— 那是真实的资源空白，不是失败。
    if (evidenceDetail.size > 0) {
      const juniorMath = knowledge.knowledgePoints.filter(
        (k) => k.subject === '数学' && resolveIndexStage(k) === '初中'
      );
      const coverageFile = path.join(reviewDir, `coverage-${args.versionSuffix}.json`);
      const coverage = juniorMath.map((k) => {
        const detail = evidenceDetail.get(k.id);
        return {
          id: k.id,
          name: k.name,
          chapter: k.chapter ?? '',
          covered: Boolean(detail),
          confidence: detail?.confidence ?? 'unmatched',
          sourceRepo: detail?.sourceRepo ?? '',
          sourceTopicId: detail?.topicId ?? '',
          sourceTitle: detail?.title ?? '',
          evidenceScore: detail?.score ?? 0,
          evidenceReason: detail?.reason ?? '',
        };
      });
      fs.writeFileSync(
        coverageFile,
        JSON.stringify(
          {
            generatedBy: 'import-traps.ts',
            note: '初中数学知识点错因覆盖明细；covered=false 表示来源资源里确实没有对应易错素材（真实空白）。',
            summary: {
              total: coverage.length,
              covered: coverage.filter((c) => c.covered).length,
              uncovered: coverage.filter((c) => !c.covered).length,
            },
            coverage,
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      console.log(`│  ✓ 覆盖明细：${coverageFile}`);
    }
  }

  console.log('│');
  console.log(`│  状态：${status}`);
  if (status === 'DRAFT') {
    console.log('│         ↳ DRAFT 不会生效（加载器只加载 ACTIVE 错因资产）');
    console.log('│         ↳ 教师审核后用 --promote 发布');
  } else {
    console.log('│         ↳ 已生效：错因将出现在知识点的「避坑点」与出题提示词里');
  }
  console.log('└─ 完成');
}

main();
