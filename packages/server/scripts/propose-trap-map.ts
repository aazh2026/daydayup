/**
 * 错因映射提案生成器：把「未匹配到知识点」的来源条目配上候选知识点，供人工确认。
 *
 * 运行：
 *   npm run propose:trap-map --workspace=@daydayup/server -- --source=atlas
 *   npm run propose:trap-map --workspace=@daydayup/server -- --source=all --out=data/traps/id-map.proposed.json
 *
 * ── 为什么要有这个脚本 ──────────────────────────────────────────────────
 *
 * 名称体系不同是接入易错资源的主要障碍：
 *   - atlas 的标题是「有理数的概念与分类」，资产知识点是「有理数的分类」；
 *   - 英语知识地图的条目是「十大词类」「it 作形式主语」，资产是教学单元化命名。
 *
 * 自动模糊匹配**不能**直接发布（红线：不得错挂）——例如「二元一次方程组」
 * 会被「三元一次方程组」抢走，「二次函数的图象与性质」会被「正弦函数的图象与性质」
 * 抢走。所以这里的输出只是**提案**：脚本给出按相似度排序的候选，
 * 由教师/教研员确认后写进 `data/traps/id-map.json`（人工映射表），
 * CLI 下次导入时按 `manual-map`（置信度 high）采用。
 *
 * 提案文件里的 `confidence` 只是**相似度提示**，不是匹配置信度；
 * 未经人工确认的 id-map.json 不会被 CLI 当作 high 使用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertAtlasPoints,
  convertCnMtTrapTopics,
  convertCstCourses,
  convertCstRefuteQuestions,
  convertCstTeachingResearch,
  type AtlasPoint,
  type CnMtTopicLike,
  type CstCourse,
  type CstQuestionLike,
  type CstResearchRecord,
  type CstTopicLike,
  type TrapCandidate,
} from '../src/infrastructure/knowledge/converters/traps.ts';
import {
  buildKnowledgeIndex,
  normalizeName,
  type KnowledgeIndex,
  type KnowledgeIndexItem,
} from '../src/infrastructure/knowledge/trap-matcher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Args {
  sources: string[];
  outFile: string;
  topN: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sources: [],
    outFile: path.join(DATA_DIR, 'traps', 'id-map.proposed.json'),
    topN: 3,
  };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (key === 'source') {
      args.sources = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (key === 'out') {
      args.outFile = path.resolve(value);
    } else if (key === 'top') {
      args.topN = Math.max(1, Number(value) || 3);
    } else {
      console.error(`未知参数：--${key}`);
      process.exit(1);
    }
  }
  if (args.sources.length === 0) args.sources = ['atlas'];
  return args;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** 最长公共子串长度（字符级） */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 中文按字切、英文数字按词切 */
function tokenize(name: string): string[] {
  const clean = normalizeName(name);
  const tokens = new Set<string>();
  for (const m of clean.match(/[a-z0-9]+/g) ?? []) tokens.add(m);
  const cjk = clean.replace(/[a-z0-9]+/g, '');
  for (const ch of cjk) tokens.add(ch);
  return [...tokens];
}

/**
 * 相似度（0–1）。
 *
 * 综合三个信号：
 *  1. 字符二元组重叠率（Jaccard）
 *  2. 最长公共子串占较长串的比例
 *  3. token 包含关系（一方 token 全被另一方包含）
 */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;

  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (s.length === 1) out.add(s);
    return out;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const jaccard = inter / (ga.size + gb.size - inter || 1);

  const lcs = longestCommonSubstring(na, nb) / Math.max(na.length, nb.length);

  const ta = tokenize(na);
  const tb = tokenize(nb);
  const sa = new Set(ta);
  const sb = new Set(tb);
  let contained = 0;
  for (const t of sa) if (sb.has(t)) contained++;
  const cover = contained / Math.max(1, Math.min(sa.size, sb.size));

  return 0.45 * jaccard + 0.35 * lcs + 0.2 * cover;
}

/** 打分并排序候选知识点 */
export function rankCandidates(
  topicName: string,
  index: KnowledgeIndex,
  scope: { subject?: string; stage?: string },
  topN: number
): Array<{ id: string; name: string; score: number }> {
  const out: Array<{ id: string; name: string; score: number }> = [];
  for (const item of index.byId.values()) {
    if (scope.subject && item.subject !== scope.subject) continue;
    if (scope.stage && item.stage !== scope.stage) continue;
    const score = similarity(topicName, item.name);
    if (score <= 0) continue;
    out.push({ id: item.id, name: item.name, score: Number(score.toFixed(4)) });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, topN);
}

// ---------------------------------------------------------------------------
// 候选构造（与 import-traps 保持一致）
// ---------------------------------------------------------------------------

function candidatesForAtlas(sourceDir: string): TrapCandidate[] {
  const pointsDir = path.join(sourceDir, 'content', 'points');
  const files = fs
    .readdirSync(pointsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return convertAtlasPoints(
    files.map((f) => readJson<AtlasPoint>(path.join(pointsDir, f)))
  );
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

  // 教学研究（errors / nextMoves）
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

function candidatesForCnMt(sourceDir: string): TrapCandidate[] {
  const topics = readJson<CnMtTopicLike[]>(
    path.join(sourceDir, 'data', 'topics.json')
  );
  return convertCnMtTrapTopics(topics);
}

const SOURCE_DIRS: Record<string, string> = {
  atlas: path.join(REPO_ROOT, 'resources', 'junior-math-atlas'),
  cst: path.join(REPO_ROOT, 'resources', 'china-skill-taxonomy'),
  'cn-mt': path.join(REPO_ROOT, 'resources', 'cn-math-taxonomy'),
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function loadIndex(): KnowledgeIndex {
  const dir = path.join(DATA_DIR, 'knowledge');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  let active: unknown = null;
  for (const file of files) {
    try {
      const parsed = readJson<{ status?: string } & Record<string, unknown>>(path.join(dir, file));
      if (parsed.status === 'ACTIVE') {
        active = parsed;
        break;
      }
    } catch {
      // 跳过损坏文件
    }
  }
  if (!active) active = readJson(path.join(dir, files[files.length - 1]));
  const parsed = active as {
    knowledgePoints: Array<{
      id: string;
      name: string;
      subject: string;
      chapter?: string;
    }>;
  };
  return buildKnowledgeIndex(parsed.knowledgePoints);
}

interface Proposal {
  /** 映射表键：`repo:sourceId` 或 `repo:sourceId#pN` */
  key: string;
  sourceRepo: string;
  sourceId: string;
  /** 来源条目名（atlas 标题 / cst 课例标题） */
  topicName: string;
  subject: string;
  stage: string;
  /** 该来源条目下的易错点条数 */
  trapCount: number;
  /** 候选知识点，按相似度降序 */
  candidates: Array<{ id: string; name: string; score: number }>;
  /** 教师确认后填入知识点 id；null 表示未确认 */
  confirmedKnowledgeId: string | null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const index = loadIndex();

  // 按来源条目聚合（一个来源条目只出一个提案，带上它的易错点数量）
  const grouped = new Map<
    string,
    { repo: string; sourceId: string; topicName: string; subject: string; stage: string; count: number }
  >();

  for (const key of args.sources) {
    const dir = SOURCE_DIRS[key];
    if (!dir || !fs.existsSync(dir)) {
      console.error(`未知或缺失的来源：${key}`);
      process.exit(1);
    }
    const candidates =
      key === 'atlas'
        ? candidatesForAtlas(dir)
        : key === 'cst'
          ? candidatesForCst(dir)
          : candidatesForCnMt(dir);

    for (const c of candidates) {
      const mapKey = `${c.sourceRepo}:${c.sourceId}`;
      const prev = grouped.get(mapKey);
      if (prev) {
        prev.count++;
        continue;
      }
      grouped.set(mapKey, {
        repo: c.sourceRepo,
        sourceId: c.sourceId,
        topicName: c.topicName ?? '',
        subject: c.subject,
        stage: c.stage,
        count: 1,
      });
    }
  }

  const proposals: Proposal[] = [];
  for (const g of grouped.values()) {
    const candidates = rankCandidates(
      g.topicName,
      index,
      { subject: g.subject || undefined, stage: g.stage || undefined },
      args.topN
    );
    proposals.push({
      key: `${g.repo}:${g.sourceId}`,
      sourceRepo: g.repo,
      sourceId: g.sourceId,
      topicName: g.topicName,
      subject: g.subject,
      stage: g.stage,
      trapCount: g.count,
      candidates,
      confirmedKnowledgeId: null,
    });
  }

  proposals.sort((a, b) => {
    const sa = a.candidates[0]?.score ?? 0;
    const sb = b.candidates[0]?.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.key.localeCompare(b.key);
  });

  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(
    args.outFile,
    JSON.stringify(
      {
        generatedBy: 'propose-trap-map.ts',
        note:
          '候选知识点仅供人工参考；确认后把 id 填进 packages/server/data/traps/id-map.json（键即 key），CLI 会以 manual-map（high）采用。未确认的条目不会被发布。',
        proposals,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  console.log(`✓ 提案已写入：${args.outFile}（${proposals.length} 条来源条目）`);
  console.log('  → 人工确认后写入 packages/server/data/traps/id-map.json（键 = key）');
}

main();
