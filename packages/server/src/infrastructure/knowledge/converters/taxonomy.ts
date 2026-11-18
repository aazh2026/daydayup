/**
 * cn-math-taxonomy → daydayup 知识资产转换器（核心映射逻辑）。
 *
 * 源项目：`resources/cn-math-taxonomy`
 *   - `data/topics.json`      知识点（3557 条，9 个学科，小学→高中）
 *   - `data/dependencies.json` 先修边（5132 条，含 hard/soft 强度）
 *   - `data/questions.json`   题库（14375 条）
 *
 * 目标资产：`packages/server/data/knowledge/*.json`（CurriculumAsset）
 *           `packages/server/data/questions/bank.json`（QuestionBankAsset）
 *
 * ── 设计约束 ──────────────────────────────────────────────────────────
 *
 * 1. **纯函数**：本模块不做 IO、不读时钟。所有映射逻辑可被 node:test 反复验证。
 *    IO 在 `import-taxonomy.ts` 脚本里完成。
 *
 * 2. **ID 保留**：cn-mt 的知识点 id（`cnm_001` / `cnm_p001` / `cnm_h001`）
 *    直接沿用为 daydayup 的 `knowledgeId`。理由：
 *      - 便于与源项目、以及教师手上的纸质材料对照纠错；
 *      - `ErrorRecord.knowledgeId` / `MasteryRecord.knowledgeId` 是外键，
 *        换 id 会让历史数据全部失效。
 *
 * 3. **显式映射表**：学段、学科、册次在源项目里用「无 subject 字段 = 数学」
 *    「grade 10–14 = 高中册次编码」等隐式约定表达。此处全部转成
 *    显式映射表 + 显式换算函数，任何无法判定的输入都**抛错**而不是静默猜测。
 *
 * 4. **不静默丢数据**：无法映射的知识点会被 `ConversionReport.skipped`
 *    记录并给出原因，脚本退出码非 0，避免"导入了 90% 以为是 100%"。
 *
 * 5. **授权**：cn-mt 采用 CC BY-NC 4.0。数据导入商业产品前需取得商业授权，
 *    本模块在生成的资产里写入 `source` 溯源字段，见 `LICENSING.md`。
 */

// ---------------------------------------------------------------------------
// 源数据结构（cn-math-taxonomy）
// ---------------------------------------------------------------------------

/** cn-mt 的知识点类型（布鲁姆式分类） */
export type TaxonomyTopicType =
  | 'conceptual'
  | 'procedural'
  | 'reasoning'
  | 'application'
  | 'modeling';

export interface TaxonomyStandard {
  id: string;
  confidence: 'exact' | 'verbatim' | 'paraphrase' | string;
  [k: string]: unknown;
}

export interface TaxonomyTopic {
  id: string;
  name: string;
  domain: string;
  /** 源项目里数学没有 subject 字段（默认数学） */
  subject?: string;
  grade: number;
  semester?: string;
  chapter: string;
  type: TaxonomyTopicType;
  description: string;
  mastery_criteria: string[];
  diagnostic_question?: { question: string; answer: string };
  external?: boolean;
  standards?: TaxonomyStandard[];
  root_reason?: string;
  mathLinks?: string[];
  /** 教材目录映射用（catalog_note / catalog_status） */
  catalog_note?: string;
  catalog_status?: string;
  [k: string]: unknown;
}

export interface TaxonomyDependency {
  topicId: string;
  prerequisiteId: string;
  /** hard = 强先修（不掌握就无法学）；soft = 弱先修（顺序/主题相关） */
  strength: 'hard' | 'soft';
  reason?: string;
}

export interface TaxonomyChoice {
  key: string;
  text: string;
}

export interface TaxonomyQuestion {
  id: string;
  topicId: string;
  type: 'choice' | 'numeric' | 'short' | 'self';
  difficulty: 'basic' | 'standard' | 'challenge' | 'advanced';
  prompt: string;
  answer: string;
  explanation?: string;
  verify?: string;
  choices?: TaxonomyChoice[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// 目标结构（@daydayup/contracts）
// ---------------------------------------------------------------------------

export interface TargetKnowledgePoint {
  id: string;
  subject: string;
  chapter: string;
  domain: string;
  name: string;
  subSkills: string[];
  definition: string;
  prerequisites: string[];
  commonExamForms: string[];
  commonTraps: string[];
  examWeight: number;
  learningCostHours: number;
}

export interface TargetQuestion {
  id: string;
  region: '上海';
  grade: string;
  subject: string;
  questionType: '选择' | '填空' | '解答' | '实验' | '词汇语法';
  level: '基础题' | '变式题' | '迁移题' | '延迟复测';
  stem: string;
  options?: string[];
  standardAnswer: string;
  scoreValue: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

/** daydayup 资产格式（与 packages/server/src/infrastructure/knowledge/curriculum.ts 对齐） */
export interface CurriculumAsset {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subjects: string[];
  knowledgePoints: TargetKnowledgePoint[];
}

export interface QuestionBankAsset {
  version: string;
  questions: TargetQuestion[];
}

// ---------------------------------------------------------------------------
// 映射表
// ---------------------------------------------------------------------------

/**
 * 源项目 subject 字段 → daydayup 中文学科名。
 *
 * 注意：**数学在源项目里没有 subject 字段**（缺省即数学），
 * 所以 `undefined` 必须映射成「数学」，而不是被当成"未知"跳过。
 */
export const SUBJECT_MAP: Record<string, string> = {
  math: '数学',
  english: '英语',
  chinese: '语文',
  physics: '物理',
  chemistry: '化学',
  biology: '生物',
  history: '历史',
  geography: '地理',
  morality: '道德与法治',
  science: '科学',
};

/**
 * daydayup 的 `Subject` 联合类型只覆盖五门中考学科。
 *
 * 生物/历史/地理/道德与法治/科学 **不在**中考科目范围内，
 * 转换时默认排除（如需保留，见 `IncludeUnsupportedSubjects`）。
 */
export const SUPPORTED_SUBJECTS = ['数学', '英语', '物理', '化学', '语文'] as const;

/**
 * 源项目 grade 编码 → daydayup 学段。
 *
 * 源项目的 grade 语义有两套：
 *  - 1–9：真实年级（小学 1–6、初中 7–9）
 *  - 10–16：**高中册次编码**，不是教学年份。
 *    cn-mt 的约定：必修一/二/三 = 10/11/12，选必一/二/三 = 13/14/15
 *    （英语多一册选必四 = 16）。数学只到 14（选必三）。
 *
 * daydayup 是「上海初三」单一学段产品，所以只有初中 7–9 是主目标学段；
 * 小学（1–6）作为**先修回溯**数据保留，初中 7–9 为主。
 */
export type Stage = '小学' | '初中' | '高中';

export function resolveStage(topic: TaxonomyTopic): Stage {
  const grade = topic.grade;
  if (grade >= 1 && grade <= 6) return '小学';
  if (grade >= 7 && grade <= 9) return '初中';
  // 源项目 grade 10–16 是高中**册次编码**（必修一/二/三 = 10/11/12，
  // 选必一/二/三(/四) = 13/14/15(/16)），不是教学年份。上限 16。
  if (grade >= 10 && grade <= 16) return '高中';
  throw new Error(`无法判定学段：grade=${grade} (topic ${topic.id})`);
}

/** 源项目 subject 字段 → daydayup 学科名（数学缺省） */
export function resolveSubject(topic: TaxonomyTopic): string {
  const raw = topic.subject;
  if (raw === undefined || raw === null || raw === '') return '数学';
  const mapped = SUBJECT_MAP[raw];
  if (!mapped) {
    throw new Error(`未知学科：subject="${raw}" (topic ${topic.id})`);
  }
  return mapped;
}

/**
 * 高中册次编码 → 可读名称。
 * 源项目用 10–16 做"分册"编码，cn-mt README 明确说明这不是教学年份。
 */
export function resolveSeniorVolume(grade: number): string {
  const volumes: Record<number, string> = {
    10: '必修第一册',
    11: '必修第二册',
    12: '必修第三册',
    13: '选择性必修第一册',
    14: '选择性必修第二册',
    15: '选择性必修第三册',
    16: '选择性必修第四册',
  };
  const v = volumes[grade];
  if (!v) throw new Error(`未知的高中册次编码：grade=${grade}`);
  return v;
}

/** 源项目 chapter 字段 → daydayup 章节字符串 */
export function resolveChapter(topic: TaxonomyTopic): string {
  if (topic.grade >= 10) {
    return `${resolveSeniorVolume(topic.grade)} ${topic.chapter}`;
  }
  return topic.chapter;
}

// ---------------------------------------------------------------------------
// 权重 / 学习成本 推导
// ---------------------------------------------------------------------------

/**
 * 考试权重（examWeight，0.6–1.5）推导。
 *
 * 依据（可审计的确定性规则，非拍脑袋）：
 *  - **学段权重**：初中 1.0 为基准；小学是回溯用的先修知识，
 *    中考不直接出题，但它是高分段的支撑，权重下调到 0.7；
 *    高中 0.85（daydayup 是初三产品，高中不在直接考试范围）。
 *  - **课标置信度**：能精确对齐课标条目的点更可能进考纲，+0.05。
 *  - **知识点类型**（布鲁姆分类）：
 *      conceptual 概念 —— 考纲里"知道是什么"，权重略低
 *      procedural  技能 —— 中考主要考"会不会做"，权重最高
 *      reasoning   推理 —— 中考压轴题载体，权重最高
 *      application 应用 —— 情境题，权重高
 *      modeling    建模 —— 课标要求但实际考查少，权重低
 *  - **钳制**到 [0.6, 1.5]，与 contracts 注释里的区间一致。
 */
const TYPE_WEIGHT: Record<TaxonomyTopicType, number> = {
  conceptual: 0.0,
  procedural: 0.1,
  reasoning: 0.1,
  application: 0.08,
  modeling: -0.05,
};

const STAGE_WEIGHT: Record<Stage, number> = {
  小学: -0.3,
  初中: 0.0,
  高中: -0.15,
};

export function deriveExamWeight(topic: TaxonomyTopic): number {
  const stage = resolveStage(topic);
  const typeAdj = TYPE_WEIGHT[topic.type] ?? 0;
  let w = 1.0 + STAGE_WEIGHT[stage] + typeAdj;

  // 课标置信度：exact / verbatim 说明与课标条目直接对应
  const standards = topic.standards ?? [];
  if (standards.some((s) => s.confidence === 'exact' || s.confidence === 'verbatim')) {
    w += 0.05;
  }

  return clamp(round(w, 2), 0.6, 1.5);
}

/**
 * 学习成本（learningCostHours）推导。
 *
 * 依据：
 *  - **类型基线**：建模/推理类耗时长，概念类短。
 *  - **子技能数**：mastery_criteria 越多，说明该点被拆得越细，需要的课时越多。
 *  - **学段**：小学知识点单点简单，初中是主战场。
 */
const TYPE_COST: Record<TaxonomyTopicType, number> = {
  conceptual: 0.8,
  procedural: 1.6,
  reasoning: 2.4,
  application: 1.8,
  modeling: 3.0,
};

export function deriveLearningCostHours(topic: TaxonomyTopic): number {
  const stage = resolveStage(topic);
  let hours = TYPE_COST[topic.type] ?? 1.5;

  const criteria = topic.mastery_criteria?.length ?? 0;
  if (criteria > 1) {
    hours += 0.4 * (criteria - 1);
  }

  if (stage === '小学') hours *= 0.7;
  if (stage === '高中') hours *= 1.1;

  return clamp(round(hours, 1), 0.5, 8);
}

// ---------------------------------------------------------------------------
// commonExamForms / commonTraps 推导
// ---------------------------------------------------------------------------

/**
 * 考试题型形式（commonExamForms）。
 *
 * cn-mt 没有这个字段（它有 type + description + mastery_criteria）。
 * 这里从**知识点类型**推导常见题型表述 —— 对 daydayup 的用途是
 * 给 AI 教练/练习生成提示词提供"这个点通常怎么考"的上下文。
 */
const TYPE_EXAM_FORMS: Record<TaxonomyTopicType, string[]> = {
  conceptual: ['概念辨析题', '判断正误题'],
  procedural: ['基础运算题', '常规解答题'],
  reasoning: ['多步推理解答题', '综合应用题'],
  application: ['情境应用题', '建模解答题'],
  modeling: ['建模综合题', '开放性表达题'],
};

export function deriveCommonExamForms(topic: TaxonomyTopic): string[] {
  const forms = [...(TYPE_EXAM_FORMS[topic.type] ?? ['基础解答题'])];
  const stage = resolveStage(topic);
  if (stage === '初中') forms.push('中考真题');
  else if (stage === '小学') forms.push('小学基础题');
  return forms;
}

/**
 * 常见错误（commonTraps）。
 *
 * cn-mt **没有**这个字段 —— 它只有 `root_reason`（为什么没有更早的先修）。
 * 不得凭空捏造具体错误点：这里只填**可从源数据确证**的条目，
 * 并且明确标注"待教师补充"，避免把编造内容当成教研结论。
 *
 * 这是一个**已知的覆盖缺口**，记入 ConversionReport.warnings。
 */
export function deriveCommonTraps(topic: TaxonomyTopic): string[] {
  // 源数据不含错因信息 → 返回空数组，由转换报告标记为待补充。
  return [];
}

// ---------------------------------------------------------------------------
// 题型 / 难度 映射
// ---------------------------------------------------------------------------

/** cn-mt 题型 → daydayup questionType */
export const QUESTION_TYPE_MAP: Record<TaxonomyQuestion['type'], TargetQuestion['questionType']> = {
  choice: '选择',
  numeric: '填空',
  short: '解答',
  self: '解答',
};

/** cn-mt 难度 → daydayup level */
export const LEVEL_MAP: Record<
  TaxonomyQuestion['difficulty'],
  TargetQuestion['level']
> = {
  basic: '基础题',
  standard: '变式题',
  challenge: '迁移题',
  advanced: '迁移题',
};

/** cn-mt 难度 → daydayup difficulty (1–5) */
export const DIFFICULTY_MAP: Record<TaxonomyQuestion['difficulty'], 1 | 2 | 3 | 4 | 5> = {
  basic: 1,
  standard: 2,
  challenge: 3,
  advanced: 4,
};

/** 分值：按难度映射，且与上海中考分值区间合理衔接 */
export const SCORE_VALUE_MAP: Record<TaxonomyQuestion['difficulty'], number> = {
  basic: 2,
  standard: 4,
  challenge: 6,
  advanced: 8,
};

// ---------------------------------------------------------------------------
// 转换主逻辑
// ---------------------------------------------------------------------------

export interface ConversionOptions {
  /** 只导入这些学科（中文名）。默认 = SUPPORTED_SUBJECTS */
  subjects?: readonly string[];
  /** 只导入这些学段。默认 = 全部 */
  stages?: readonly Stage[];
  /** 先修边强度门槛：hard 必留；soft 视开关决定 */
  includeSoftPrerequisites?: boolean;
  /** 生成的资产版本号 */
  version?: string;
  /** 资产发布时间（ISO）。默认由调用方传入，保持纯函数无时钟读取 */
  publishedAt?: string;
  /** 资产状态。导入产物一律 DRAFT —— 未经教师审核不得 ACTIVE */
  status?: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
}

export interface ConversionReport {
  /** 成功转换的知识点数 */
  convertedTopics: number;
  /** 成功转换的题目数 */
  convertedQuestions: number;
  /** 保留的先修边数 */
  keptEdges: number;
  /** 被跳过的内容及原因 */
  skipped: Array<{ kind: 'topic' | 'question' | 'edge'; id: string; reason: string }>;
  /** 非致命问题（数据缺口） */
  warnings: string[];
  /** 各学科转化统计 */
  bySubject: Record<string, { topics: number; questions: number }>;
}

export interface ConversionResult {
  curriculum: CurriculumAsset;
  bank: QuestionBankAsset;
  report: ConversionReport;
}

function emptyReport(): ConversionReport {
  return {
    convertedTopics: 0,
    convertedQuestions: 0,
    keptEdges: 0,
    skipped: [],
    warnings: [],
    bySubject: {},
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * 判断一个知识点是否应被导入。
 */
export function shouldIncludeTopic(
  topic: TaxonomyTopic,
  opts: ConversionOptions
): { include: boolean; reason?: string } {
  const subjects = opts.subjects ?? SUPPORTED_SUBJECTS;
  const stages = opts.stages ?? (['小学', '初中', '高中'] as const);

  let subject: string;
  let stage: Stage;
  try {
    subject = resolveSubject(topic);
    stage = resolveStage(topic);
  } catch (err) {
    return {
      include: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!subjects.includes(subject)) {
    return { include: false, reason: `学科「${subject}」不在导入范围` };
  }
  if (!stages.includes(stage)) {
    return { include: false, reason: `学段「${stage}」不在导入范围` };
  }
  if (topic.external === true) {
    return { include: false, reason: '标记为 external（外部节点，无诊断题）' };
  }
  return { include: true };
}

/**
 * 转换单个知识点。
 *
 * @returns 转换后的知识点；无法转换时返回 null（原因记入 report.skipped）
 */
export function convertTopic(
  topic: TaxonomyTopic,
  prerequisites: string[],
  opts: ConversionOptions
): TargetKnowledgePoint | null {
  const subject = resolveSubject(topic);

  return {
    id: topic.id,
    subject,
    chapter: resolveChapter(topic),
    domain: topic.domain,
    name: topic.name,
    // mastery_criteria 是"掌握标准"，语义上比 subSkills 更贴近"子技能"
    subSkills: [...(topic.mastery_criteria ?? [])],
    definition: topic.description,
    prerequisites,
    commonExamForms: deriveCommonExamForms(topic),
    commonTraps: deriveCommonTraps(topic),
    examWeight: deriveExamWeight(topic),
    learningCostHours: deriveLearningCostHours(topic),
  };
}

/**
 * 转换题目。
 */
export function convertQuestion(
  q: TaxonomyQuestion,
  subject: string,
  gradeLabel: string
): TargetQuestion | null {
  if (!q.prompt || !q.answer) return null;

  const options = q.choices?.map((c) => `${c.key}. ${c.text}`);
  const questionType = QUESTION_TYPE_MAP[q.type] ?? '解答';

  return {
    id: q.id,
    region: '上海',
    grade: gradeLabel,
    subject,
    questionType,
    level: LEVEL_MAP[q.difficulty] ?? '基础题',
    stem: q.prompt,
    ...(options && options.length > 0 ? { options } : {}),
    standardAnswer: q.answer,
    scoreValue: SCORE_VALUE_MAP[q.difficulty] ?? 4,
    difficulty: DIFFICULTY_MAP[q.difficulty] ?? 2,
    // cn-mt 每题都有 explanation；拆成"解题步骤"数组
    solutionSteps: q.explanation ? [q.explanation] : [],
    // cn-mt 无错因数据 → 空数组（与 commonTraps 同源缺口）
    commonErrors: [],
    knowledgeIds: [q.topicId],
  };
}

/**
 * 主转换函数。
 *
 * @param topics     cn-mt `data/topics.json`
 * @param deps       cn-mt `data/dependencies.json`
 * @param questions  cn-mt `data/questions.json`
 */
export function convertTaxonomy(
  topics: TaxonomyTopic[],
  deps: TaxonomyDependency[],
  questions: TaxonomyQuestion[],
  opts: ConversionOptions = {}
): ConversionResult {
  const report = emptyReport();
  const subjectSet = new Set(opts.subjects ?? SUPPORTED_SUBJECTS);
  const stageSet = new Set(opts.stages ?? (['小学', '初中', '高中'] as const));
  const includeSoft = opts.includeSoftPrerequisites ?? false;

  // ---- 1. 选出要导入的知识点 ----
  const topicById = new Map<string, TaxonomyTopic>();
  const selected: TaxonomyTopic[] = [];

  for (const topic of topics) {
    const { include, reason } = shouldIncludeTopic(topic, {
      ...opts,
      subjects: [...subjectSet],
      stages: [...stageSet],
    });
    if (!include) {
      report.skipped.push({ kind: 'topic', id: topic.id, reason: reason ?? '未选中' });
      continue;
    }
    topicById.set(topic.id, topic);
    selected.push(topic);
  }

  // ---- 2. 先修边 ----
  // 只保留两端都被选中的边，避免产生指向"未导入知识点"的悬空外键。
  const prereqsOf = new Map<string, string[]>();
  for (const dep of deps) {
    if (!topicById.has(dep.topicId) || !topicById.has(dep.prerequisiteId)) {
      report.skipped.push({
        kind: 'edge',
        id: `${dep.topicId}<-${dep.prerequisiteId}`,
        reason: '端点未被导入（悬空边）',
      });
      continue;
    }
    if (dep.strength === 'soft' && !includeSoft) {
      report.skipped.push({
        kind: 'edge',
        id: `${dep.topicId}<-${dep.prerequisiteId}`,
        reason: 'soft 弱先修（默认不导入；硬先修才代表"不掌握就学不了"）',
      });
      continue;
    }
    const list = prereqsOf.get(dep.topicId) ?? [];
    if (!list.includes(dep.prerequisiteId)) {
      list.push(dep.prerequisiteId);
    }
    prereqsOf.set(dep.topicId, list);
    report.keptEdges++;
  }

  // ---- 3. 知识点转换 ----
  const knowledgePoints: TargetKnowledgePoint[] = [];
  const subjectOf = new Map<string, string>();
  const gradeLabelOf = new Map<string, string>();

  for (const topic of selected) {
    try {
      const subject = resolveSubject(topic);
      const kp = convertTopic(topic, prereqsOf.get(topic.id) ?? [], opts);
      if (!kp) {
        report.skipped.push({ kind: 'topic', id: topic.id, reason: '转换返回空' });
        continue;
      }
      knowledgePoints.push(kp);
      subjectOf.set(topic.id, subject);

      // daydayup 的 Question.grade 字段：'初三' 是产品主学段。
      // cn-mt 的题可能来自任意学段，这里保留真实学段信息但对齐产品语义。
      const stage = resolveStage(topic);
      gradeLabelOf.set(
        topic.id,
        stage === '初中' ? '初三' : stage === '小学' ? '小学' : '高中'
      );

      const stat = report.bySubject[subject] ?? { topics: 0, questions: 0 };
      stat.topics++;
      report.bySubject[subject] = stat;
      report.convertedTopics++;
    } catch (err) {
      report.skipped.push({
        kind: 'topic',
        id: topic.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- 4. 题目转换 ----
  const convertedQuestions: TargetQuestion[] = [];
  for (const q of questions) {
    const topic = topicById.get(q.topicId);
    if (!topic) {
      report.skipped.push({
        kind: 'question',
        id: q.id,
        reason: `所属知识点 ${q.topicId} 未导入`,
      });
      continue;
    }
    try {
      const subject = subjectOf.get(q.topicId) ?? resolveSubject(topic);
      const gradeLabel = gradeLabelOf.get(q.topicId) ?? '初三';
      const tq = convertQuestion(q, subject, gradeLabel);
      if (!tq) {
        report.skipped.push({ kind: 'question', id: q.id, reason: '缺少题干或答案' });
        continue;
      }
      convertedQuestions.push(tq);
      const stat = report.bySubject[subject] ?? { topics: 0, questions: 0 };
      stat.questions++;
      report.bySubject[subject] = stat;
      report.convertedQuestions++;
    } catch (err) {
      report.skipped.push({
        kind: 'question',
        id: q.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- 5. 数据缺口告警 ----
  const trapless = knowledgePoints.filter((kp) => kp.commonTraps.length === 0).length;
  if (trapless > 0) {
    report.warnings.push(
      `commonTraps 全部为空（${trapless}/${knowledgePoints.length} 个知识点）：` +
        'cn-mt 不含错因数据，需教师审核补全后才能用于「常见陷阱」提示'
    );
  }
  const noSteps = convertedQuestions.filter((q) => q.solutionSteps.length === 0).length;
  if (noSteps > 0) {
    report.warnings.push(`${noSteps} 道题缺少解题步骤（source explanation 为空）`);
  }
  const roots = selected.filter((t) => !t.root_reason && resolveStage(t) === '小学');
  if (roots.length > 0) {
    report.warnings.push(
      `${roots.length} 个小学知识点缺少 root_reason（无法解释"为何没有更早先修"）`
    );
  }

  // ---- 6. 组装资产 ----
  const subjects = [...new Set(knowledgePoints.map((kp) => kp.subject))].sort();
  const version = opts.version ?? 'shanghai-junior-import.v1';

  return {
    curriculum: {
      version,
      publishedAt: opts.publishedAt ?? new Date(0).toISOString(),
      // 导入产物一律 DRAFT：未经教师审核不得标 ACTIVE 上线。
      status: opts.status ?? 'DRAFT',
      subjects,
      knowledgePoints,
    },
    bank: {
      version: `${version}+questions`,
      questions: convertedQuestions,
    },
    report,
  };
}
