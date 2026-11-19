/**
 * 易错（错因）资源 → TrapEntry 转换器（纯函数）。
 *
 * 源项目：
 *   - `resources/cn-math-taxonomy`          知识点 + 题库（已在库，可直接按 id 命中）
 *   - `resources/junior-math-atlas`          83 篇初中数学知识点，含 `sections.pitfalls`
 *   - `resources/china-skill-taxonomy`       144 个课例，含「最容易错的地方」提示
 *
 * 目标资产：`packages/server/data/traps/*.json`（TrapSet，见 @daydayup/contracts）
 *
 * ── 设计约束 ──────────────────────────────────────────────────────────
 *
 * 1. **纯函数**：本模块不做 IO、不读时钟。匹配与写盘在脚本层完成。
 *
 * 2. **不重写源文本**：`wrong` / `why` / `right` 直接取源项目原句，
 *    源数据没写错因就留空串 —— 绝不由模型补写（红线）。
 *
 * 3. **来源可回溯**：每条候选都带 `sourceId` / `sourceText`，
 *    便于事后核对「这条易错点原话是什么」。
 */

import type { TrapEntry } from '@daydayup/contracts';
import { resolveStage, resolveSubject, type Stage } from './taxonomy.ts';
import { buildTopicBody, type EvidenceTopic } from '../trap-evidence.ts';

// ---------------------------------------------------------------------------
// 候选（匹配之前）
// ---------------------------------------------------------------------------

/**
 * 尚未匹配到知识点的错因候选。
 *
 * 匹配（trap-matcher.ts）会把它变成 TrapEntry：补上 knowledgeId、
 * 匹配置信度与匹配方式。
 */
export interface TrapCandidate {
  /** 全局唯一 id：`来源:源id#序号` */
  id: string;
  /** 来源仓库名（写入 TrapSet.source.repo） */
  sourceRepo: string;
  /** 来源条目 id */
  sourceId: string;
  /** 源项目自带知识点 id（有则可按 id 直接命中） */
  sourceTopicId?: string;
  /** 源主题名（用于名称匹配） */
  topicName?: string;
  /** 主题名别名（次级匹配入口，如去掉「的」的写法） */
  topicAliases?: string[];
  /** 命中题目 id */
  questionIds?: string[];
  subject: string;
  stage: string;
  /** 错误表现 */
  wrong: string;
  /** 错因 */
  why: string;
  /** 正确做法 */
  right: string;
  /** 源文本原文 */
  sourceText?: string;
  /**
   * 匹配方式提示（转换器显式指定，优先于自动判定）。
   *
   * 用于「资源自带 id 落到别的命名空间」这类场景：
   * 英语知识地图的 code 对应的是叠加层知识点（`cne_wb_*`），
   * 而主资产点（`cne_j*`）只能靠名称挂 —— 这时用 `exact` 表达
   * 「名称完全一致，可信」，用 `prefix` / `suffix` 表达
   * 「名称有包含关系，已人工核对」。
   */
  matchConfidenceHint?: 'exact' | 'prefix' | 'suffix';
}

// ---------------------------------------------------------------------------
// junior-math-atlas（初中数学知识点，含 pitfalls 三段式）
// ---------------------------------------------------------------------------

export interface AtlasPoint {
  id: string;
  title: string;
  topic?: string;
  module?: string;
  domain?: string;
  summary?: string;
  keywords?: string[];
  textbook_ref?: { volume?: string; chapter?: string; note?: string; sections?: string[] };
  sections?: {
    explanation?: string[];
    pitfalls?: Array<{ wrong?: string; why?: string; right?: string }>;
    cautions?: string[];
  };
}

/**
 * atlas 教材册次（如「七上」）→ 学段。
 * atlas 只有初中数学内容，七/八/九均为初中。
 */
export function atlasVolumeToStage(volume?: string): string {
  if (!volume) return '初中';
  if (/七|八|九/.test(volume)) return '初中';
  if (/一|二|三|四|五|六/.test(volume)) return '小学';
  return '初中';
}

/**
 * atlas 知识点 → 错因候选。
 *
 * - `sections.pitfalls` 是三段式（错在哪 / 为什么 / 怎么做对），原样保留。
 * - `sections.cautions` 是单句提醒，没有三段结构，作为「正确做法」单独成条。
 */
export function convertAtlasPoints(points: AtlasPoint[]): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const point of points) {
    const stage = atlasVolumeToStage(point.textbook_ref?.volume);
    const pitfalls = point.sections?.pitfalls ?? [];

    pitfalls.forEach((p, i) => {
      const wrong = (p.wrong ?? '').trim();
      const why = (p.why ?? '').trim();
      const right = (p.right ?? '').trim();
      if (!wrong && !why && !right) return;
      out.push({
        id: `atlas:${point.id}#p${i + 1}`,
        sourceRepo: 'junior-math-atlas',
        sourceId: point.id,
        topicName: point.title,
        subject: '数学',
        stage,
        wrong,
        why,
        right,
        sourceText: `wrong: ${wrong}\nwhy: ${why}\nright: ${right}`,
      });
    });

    (point.sections?.cautions ?? []).forEach((c, i) => {
      const caution = (c ?? '').trim();
      if (!caution) return;
      out.push({
        id: `atlas:${point.id}#c${i + 1}`,
        sourceRepo: 'junior-math-atlas',
        sourceId: point.id,
        topicName: point.title,
        subject: '数学',
        stage,
        wrong: '',
        why: '',
        right: caution,
        sourceText: caution,
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 主题级（证据匹配用）
// ---------------------------------------------------------------------------

/**
 * atlas 知识点 → **来源主题**（证据匹配的输入单元）。
 *
 * 与 `convertAtlasPoints` 的区别：
 *   - `convertAtlasPoints` 把一篇拆成「一条条易错候选」，用于条目级匹配；
 *   - `buildAtlasTopics` 保留「一篇」这个整体，并带上正文与教材落点，
 *     让知识点可以整篇继承（证据匹配的输入单元）。
 *
 * 正文 = 摘要 + 讲解 + 全部易错点 + 全部提醒 —— 「资产名出现在正文里」
 * 本身就是一条硬证据（name-in-body，88 分）。
 */
export function buildAtlasTopics(points: AtlasPoint[]): EvidenceTopic[] {
  return points.map((point) => {
    const sections = point.sections ?? {};
    const pitfalls = sections.pitfalls ?? [];
    const cautions = sections.cautions ?? [];

    const items = convertAtlasPoints([point]);

    const body = buildTopicBody(
      point.summary,
      (sections.explanation ?? []).join(' '),
      pitfalls.map((p) => [p.wrong, p.why, p.right].join(' ')).join(' '),
      cautions.join(' ')
    );

    return {
      id: point.id,
      repo: 'junior-math-atlas',
      title: point.title,
      subject: '数学',
      stage: atlasVolumeToStage(point.textbook_ref?.volume),
      keywords: point.keywords ?? [],
      body,
      scope: {
        volume: point.textbook_ref?.volume,
        chapter: point.textbook_ref?.chapter,
        sections: point.textbook_ref?.sections ?? [],
      },
      items,
    };
  });
}

// ---------------------------------------------------------------------------
// china-skill-taxonomy（课例里的「易错」提示）
// ---------------------------------------------------------------------------
export interface CstCourse {
  topicId?: string;
  title?: string;
  subject?: string;
  grade?: number;
  steps?: Array<{ type?: string; title?: string; note?: string; warn?: boolean }>;
}

/** cst 课例年级（1–6 小学 / 7–9 初中）→ 学段 */
export function cstGradeToStage(grade?: number): string {
  if (grade == null) return '初中';
  if (grade >= 1 && grade <= 6) return '小学';
  if (grade >= 7 && grade <= 9) return '初中';
  return '高中';
}

/**
 * cst 课例 → 错因候选。
 *
 * cst 的易错内容写在 step 的 `note` 里（带「易错：」前缀，常伴随 `warn: true`），
 * 是**单句**结构，没有独立的三段式，所以只填 `wrong`，`why`/`right` 留空。
 */
export function convertCstCourses(courses: CstCourse[]): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const course of courses) {
    const stage = cstGradeToStage(course.grade);
    const subject = course.subject ?? '数学';

    (course.steps ?? []).forEach((step, i) => {
      const note = (step.note ?? '').trim();
      if (!note) return;
      if (!note.includes('易错')) return;

      const wrong = note.replace(/^易错[：:]\s*/, '').trim() || note;
      out.push({
        id: `cst:${course.topicId ?? course.title ?? 'unknown'}#s${i + 1}`,
        sourceRepo: 'china-skill-taxonomy',
        sourceId: course.topicId ?? course.title ?? 'unknown',
        topicName: course.title,
        subject,
        stage,
        wrong,
        why: '',
        right: '',
        sourceText: note,
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// china-skill-taxonomy（教学研究 + 题目反驳：最优质的两个错因来源）
// ---------------------------------------------------------------------------

/** cst 的主题（topics.json 精简形态） */
export interface CstTopicLike {
  id: string;
  name: string;
  subject?: string;
  gradeRangeStart?: number;
  gradeRangeEnd?: number;
  /** 主题描述（topics.json 原句） */
  description?: string;
  /** 表现性证据（topics.json 原句列表） */
  evidence?: string[];
  /** 测评提示语（topics.json 原句） */
  assessmentPrompt?: string;
  /** 教材落点（topics.json 原句，形如 `pep-math:7a:u2`） */
  textbooks?: string[];
}

/** cst 教学研究记录（teaching-research.json 精简形态） */
export interface CstResearchRecord {
  topicId: string;
  topicName: string;
  subject: string;
  gradeRangeStart?: number;
  gradeRangeEnd?: number;
  /** 教学难点长句 —— 只作为溯源文本，不进三段式 */
  pedagogy?: string;
  /** 教学设计摘要（learn.summary）—— 参与证据打分的正文 */
  learn?: {
    summary?: string;
    activities?: string[];
    constraints?: string[];
  };
  assess?: {
    task?: string;
    levels?: string[];
    /** 错误表现 */
    errors?: string[];
    /** 补救动作（与 errors 大致一一对应） */
    nextMoves?: string[];
  };
}

/** cst 题目（questions.json 精简形态） */
export interface CstQuestionLike {
  id: string;
  topicId: string;
  prompt?: string;
  answer?: string;
  explanation?: string;
  /** 错误选项 → 为什么错 */
  refute?: Record<string, string>;
}

/**
 * cst 年级区间 → 学段。
 *
 * 与项目学段取值一致（小学 / 初中 / 高中）。
 * 跨学段区间（如 1~3 年级）返回空串 —— 表示**不约束学段**，
 * 交给名称唯一性来决定是否命中（宁可漏挂，也不挂错学段）。
 */
export function cstGradeRangeToStage(start?: number, end?: number): string {
  if (start == null || end == null) return '';
  if (end <= 6) return '小学';
  if (start >= 10) return '高中';
  if (start >= 7) return '初中';
  return '';
}

/**
 * 主题名别名：去掉「的」后再匹配一次。
 *
 * cst 与项目知识点用同一套上游命名，但写法常有「的」差异：
 *   「同分母分数加减法」（cst） ↔ 「同分母分数的加减法」（项目）
 * 别名只作为**次级**匹配入口，且仍要求命中唯一 —— 不会放宽歧义保护。
 */
export function nameAliasVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed.includes('的')) return [];
  const noDe = trimmed.replace(/的/g, '').trim();
  return noDe && noDe !== trimmed ? [noDe] : [];
}

/**
 * cst 教学研究 → 错因候选。
 *
 * `assess.errors[i]` 是**错误表现**（学生具体会怎么错），
 * `assess.nextMoves[i]` 是对应的**补救动作**（怎么练回来），
 * 两者按序对应；nextMoves 不足时留空 —— 源数据没写的部分不补。
 *
 * `pedagogy`（教学难点）不塞进三段式：它是长句教学建议，
 * 只作为 `sourceText` 溯源，保留在资产里供人工参考。
 */
export function convertCstTeachingResearch(
  records: CstResearchRecord[]
): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const r of records) {
    const errors = (r.assess?.errors ?? []).map((e) => (e ?? '').trim());
    const nextMoves = r.assess?.nextMoves ?? [];
    const stage = cstGradeRangeToStage(r.gradeRangeStart, r.gradeRangeEnd);
    const aliases = nameAliasVariants(r.topicName ?? '');

    errors.forEach((error, i) => {
      if (!error) return;
      const right = (nextMoves[i] ?? '').trim();
      out.push({
        id: `cst:${r.topicId}#e${i + 1}`,
        sourceRepo: 'china-skill-taxonomy',
        sourceId: r.topicId,
        topicName: r.topicName,
        topicAliases: aliases,
        subject: r.subject,
        stage,
        wrong: error,
        why: '',
        right,
        sourceText: [error, right, r.pedagogy ?? ''].filter(Boolean).join('\n'),
      });
    });
  }

  return out;
}

/**
 * cst 教学研究 → **来源主题**（证据匹配的输入单元）。
 *
 * 正文 = 主题名 + 教学难点 + 教学设计摘要 + 错误表现清单。
 * 错误表现本身也是正文 —— 「学生会把 X 看成 Y」往往直接点出了知识点本身。
 *
 * `topicMeta`（topics.json 主题表）会**再往正文里并入**：
 * 主题名、主题描述、表现性证据、测评提示语。
 * 这四样都是**源文本原句**（topics.json 里就是这么写的），
 * 不是模型生成的 —— 它们的用途是让「教学研究讲的是这个点」这件事有据可查，
 * 而不是凭空补写易错点。
 *
 * @param records 教学研究记录
 * @param extraItems 同一主题下的额外条目（课例提示、题目反驳），按 topicId 归并
 * @param topicMeta topics.json 主题表（按 topicId 索引），用于正文富化
 */
export function buildCstResearchTopics(
  records: CstResearchRecord[],
  extraItems?: Map<string, TrapCandidate[]>,
  topicMeta?: Map<string, CstTopicLike>
): EvidenceTopic[] {
  return records.map((r) => {
    const items = convertCstTeachingResearch([r]);
    const extras = extraItems?.get(r.topicId) ?? [];
    for (const extra of extras) {
      // 课例/题目的条目 id 与教学研究的条目 id 不同源，避免撞 id
      items.push(extra);
    }

    const meta = topicMeta?.get(r.topicId);

    const body = buildTopicBody(
      meta?.name,
      meta?.description,
      (meta?.evidence ?? []).join(' '),
      meta?.assessmentPrompt,
      r.topicName,
      r.pedagogy,
      r.learn?.summary,
      (r.assess?.errors ?? []).join(' ')
    );

    return {
      id: r.topicId,
      repo: 'china-skill-taxonomy',
      title: r.topicName,
      subject: r.subject,
      stage: cstGradeRangeToStage(r.gradeRangeStart, r.gradeRangeEnd),
      keywords: [],
      body,
      scope: { volumes: cstTextbookVolumes(meta?.textbooks) },
      items,
    };
  });
}

/** 人教版册次代号 → 教材册次名（`7a` → 七上） */
const PEP_VOLUME_NAMES: Record<string, string> = {
  '7a': '七上',
  '7b': '七下',
  '8a': '八上',
  '8b': '八下',
  '9a': '九上',
  '9b': '九下',
};

/**
 * 从 topics.json 的 `textbooks` 推导主题覆盖的册次。
 *
 * 形如 `pep-math:7a:u2` → 七上。一个主题可能横跨多册
 * （如「一次函数」在八下与九上都有），因此返回数组。
 *
 * 只认人教版（`pep-math`）—— 知识资产的 `chapter` 字段也是人教版口径，
 * 混用北师大/苏教法的册次会把不相关的册次算进来。
 */
export function cstTextbookVolumes(textbooks?: string[]): string[] {
  const out = new Set<string>();
  for (const tb of textbooks ?? []) {
    const m = /pep-math:(\d[ab])/.exec(String(tb));
    if (m && PEP_VOLUME_NAMES[m[1]]) out.add(PEP_VOLUME_NAMES[m[1]]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// cst 题目里的 `refute` → 错因候选（**最高质量**的错因素材）。

/**
 * 源数据形如：
 *   refute: { "等于 11": "只有四个数都是 11 时平均数才是 11；有一个 4 就被拉低了。" }
 * 即「错误选项 → 为什么错」，加上 `explanation` 就是完整的
 * 「错在哪（选了错的）→ 为什么错 → 怎么做对」三段式。
 *
 * 源文本原样保留：`wrong` 就是那个错误选项本身，不加任何模型生成的修饰语。
 */
export function convertCstRefuteQuestions(
  questions: CstQuestionLike[],
  topicById: Map<string, CstTopicLike>
): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const q of questions) {
    const refute = q.refute ?? {};
    const entries = Object.entries(refute);
    if (entries.length === 0) continue;

    const topic = topicById.get(q.topicId);
    const topicName = topic?.name ?? '';
    const subject = topic?.subject ?? '';
    const stage = cstGradeRangeToStage(topic?.gradeRangeStart, topic?.gradeRangeEnd);
    const aliases = nameAliasVariants(topicName);

    entries.forEach(([choice, reason], i) => {
      const wrong = (choice ?? '').trim();
      const why = (reason ?? '').trim();
      const right = (q.explanation ?? '').trim();
      if (!wrong && !why) return;

      out.push({
        id: `cst:${q.id}#r${i + 1}`,
        sourceRepo: 'china-skill-taxonomy',
        sourceId: q.id,
        topicName,
        topicAliases: aliases,
        subject,
        stage,
        wrong,
        why,
        right,
        sourceText: [wrong, why, right].filter(Boolean).join('\n'),
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// cn-math-taxonomy（已在库的源项目：易错主题 + 显式标注易错的题解析）
// ---------------------------------------------------------------------------

export interface CnMtTopicLike {
  id: string;
  name: string;
  subject?: string;
  grade: number;
  description?: string;
}

export interface CnMtQuestionLike {
  id: string;
  topicId: string;
  difficulty?: string;
  explanation?: string;
  [k: string]: unknown;
}

/**
 * 从知识点名里取出「易错」那一段。
 *
 * 例：
 *   「语文园地一·易错字音（削、骨、血、处）」→「易错字音（削、骨、血、处）」
 *   「通假字与易错字」→「易错字」
 */
export function extractErrorFragment(name: string): string {
  const segments = name.split(/[·・]/).filter(Boolean);
  const hit = segments.find((s) => s.includes('易错')) ?? name;
  const idx = hit.indexOf('易错');
  if (idx > 0) return hit.slice(idx);
  return hit;
}

/**
 * 学科解析（宽松版）。
 *
 * 源项目一般用英文 subject（`chinese`/`math`/…），但个别条目可能直接写中文。
 * 英文走 `resolveSubject`；中文原样保留 —— 若是不在中考范围内的学科（如生物），
 * 保留原名会让后续匹配因学科不符而判否，而不是错误挂到别的学科上。
 */
function resolveSubjectLoose(topic: CnMtTopicLike): string | null {
  try {
    return resolveSubject(topic as never);
  } catch {
    const raw = (topic.subject ?? '').trim();
    return raw || null;
  }
}

/**
 * cn-mt 的「易错」知识点 → 错因候选。
 *
 * 这些知识点自带 id，匹配时走 `source-topic` 路径（置信度 high）。
 * `why` 留空：源数据没有写错因，只写了「要读准哪些字」这类要求。
 */
export function convertCnMtTrapTopics(topics: CnMtTopicLike[]): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const topic of topics) {
    if (!topic.name.includes('易错')) continue;

    let subject: string;
    let stage: Stage;
    try {
      stage = resolveStage(topic as never);
    } catch {
      continue; // 学段无法判定 → 跳过（由报告记录）
    }
    subject = resolveSubjectLoose(topic);
    if (!subject) continue;

    const wrong = extractErrorFragment(topic.name);
    const right = (topic.description ?? '').trim();
    if (!wrong && !right) continue;

    out.push({
      id: `cnmt:${topic.id}#trap`,
      sourceRepo: 'cn-math-taxonomy',
      sourceId: topic.id,
      sourceTopicId: topic.id,
      topicName: topic.name,
      subject,
      stage,
      wrong,
      why: '',
      right,
      sourceText: topic.description,
    });
  }

  return out;
}

/**
 * 题解析里**显式标注**了易错点的题目 → 题目级错因候选。
 *
 * 只取含警示词的句子（注意 / 易错 / 不要 / 切记 / 易混 / 常见错误 / 陷阱）。
 * 源数据没有写错因的题目一律不生成条目 —— 不从普通解题步骤里推断易错点。
 *
 * ⚠️ `不要` 必须带后视否定：`不要求`、`不要紧`、`不要命` 里的「不要」不是警示
 * （例：`并不要求必须等于 CD` 是题目条件的陈述，不是错因警示）。
 */
export const ERROR_HINT_PATTERN =
  /易错|常见错误|典型错误|陷阱|切记|易混|注意|不要(?!求|紧|命)/;

/** 警示关键词（正则形式，与 ERROR_HINT_PATTERN 同源，供分句裁剪使用） */
const CAUTION_KEYWORDS: RegExp[] = [
  /易错/,
  /常见错误/,
  /典型错误/,
  /陷阱/,
  /切记/,
  /易混/,
  /注意/,
  /不要(?!求|紧|命)/,
];

/**
 * 从解析句里裁出「警示片段」，去掉前面的解题步骤与后面的推导。
 *
 * 源解析常常是「先算……，注意括号前是负号」这种形式 —— 前半段是解题过程，
 * 直接当错因会把答案泄露给学生（也会污染出题提示词）。这里只保留**警示部分**，
 * 仍然不新增任何模型生成文字。
 *
 * 三条裁剪规则（按顺序）：
 *  1. 「X 是常见错误」这种句式 → 整句保留（信息在关键词**前面**）；
 *  2. 否则从第一个警示词开始截取（信息在关键词**后面**）；
 *  3. 截取后去掉尾部的解题推导（`=`、`所以`、`得`、`即` 之后的内容）。
 *
 * 例：
 *   `A-B=2x²-x-(x²+3x-1)=…，注意括号前是负号，-1 要变成 +1。`
 *     → `注意括号前是负号，-1 要变成 +1。`
 *   `两边同乘 6（注意右边的 1 也要乘 6）：3(x-1)-2(2x+1)=6，得 …，所以 x=-11。`
 *     → `注意右边的 1 也要乘 6`
 *   `把 1.5 h 当成 1 h 50 min 是常见错误。`
 *     → `把 1.5 h 当成 1 h 50 min 是常见错误。`
 */
export function extractHintFragment(sentence: string): string {
  const text = sentence.trim();

  // 规则 1：「… 是常见错误」句式
  const errorMatch = text.match(/(.{4,})是(常见错误|典型错误|易错)/);
  let hint: string;
  if (errorMatch) {
    hint = errorMatch[0];
  } else {
    // 规则 2：从第一个警示词开始；若警示词前有短中文主语（「踢毽子的人数不要…」），
    // 把它一起带上，避免出现没有主语的残句。
    let start = -1;
    for (const kw of CAUTION_KEYWORDS) {
      const m = kw.exec(text);
      if (m && (start === -1 || m.index < start)) start = m.index;
    }
    hint = start >= 0 ? text.slice(start) : text;

    if (start > 0) {
      const prefix = text.slice(0, start);
      const clauseStart = Math.max(
        prefix.lastIndexOf('，'),
        prefix.lastIndexOf('。'),
        prefix.lastIndexOf('；'),
        prefix.lastIndexOf('：'),
        prefix.lastIndexOf(',')
      ) + 1;
      const subject = prefix.slice(clauseStart);
      if (
        subject.length > 0 &&
        subject.length <= 14 &&
        /[一-龥]/.test(subject) &&
        !/[A-Za-z\d=]/.test(subject)
      ) {
        hint = subject + hint;
      }
    }
  }

  // 规则 3：去掉尾部推导
  const cutPoints: number[] = [];
  const eq = hint.indexOf('=');
  // 只在「等号左边含数字」时截断 —— 那是算式推导（`注意它不等于…(2 + 14)/2 = 8 m/s`）；
  // `注意 a=0 也满足` 这种条件说明不能截。
  if (eq >= 0 && /\d/.test(hint.slice(0, eq))) cutPoints.push(eq);
  for (const marker of ['所以', '从而', '故而']) {
    const idx = hint.indexOf(marker);
    if (idx >= 0) cutPoints.push(idx);
  }
  // 「注意…）：3(x-1)-2(x+1)=6」——冒号后面才是推导，冒号前面才是警示
  const colon = hint.indexOf('：');
  if (colon >= 0 && hint.slice(colon).includes('=')) cutPoints.push(colon);
  if (cutPoints.length > 0) {
    hint = hint.slice(0, Math.min(...cutPoints));
  }

  hint = hint.replace(/^[:：、，,。；;\s]+/, '').trim();
  // 去掉尾部标点与因截断而落单的右括号
  for (;;) {
    const before = hint;
    hint = hint.replace(/[：:，,、。；;！!？?\s]+$/, '');
    const opens = (hint.match(/（/g) ?? []).length;
    const closes = (hint.match(/）/g) ?? []).length;
    if (hint.endsWith('）') && closes > opens) {
      hint = hint.slice(0, -1).trim();
    }
    if (hint === before) break;
  }
  return hint;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；！？])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function convertCnMtTrapQuestions(questions: CnMtQuestionLike[]): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const q of questions) {
    const explanation = (q.explanation ?? '').trim();
    if (!explanation) continue;

    const hits = splitSentences(explanation).filter((s) => ERROR_HINT_PATTERN.test(s));
    if (hits.length === 0) continue;

    hits.forEach((sentence, i) => {
      const hint = extractHintFragment(sentence);
      out.push({
        id: `cnmt:${q.id}#e${i + 1}`,
        sourceRepo: 'cn-math-taxonomy',
        sourceId: q.id,
        sourceTopicId: q.topicId,
        topicName: undefined,
        questionIds: [q.id],
        subject: '',
        stage: '',
        wrong: hint,
        why: '',
        right: '',
        sourceText: sentence,
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 组装 TrapSet
// ---------------------------------------------------------------------------

export interface TrapSetSource {
  repo: string;
  path: string;
  license: string;
  licenseUrl?: string;
  note?: string;
}

/**
 * 把候选组装成 TrapSet（未匹配条目也在里面，`knowledgeId` 为 null）。
 */
export function buildTrapSet(params: {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subject: string;
  source: TrapSetSource;
  entries: TrapEntry[];
}): {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subject: string;
  source: TrapSetSource;
  entries: TrapEntry[];
} {
  return params;
}
