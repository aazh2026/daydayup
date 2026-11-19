export type Subject = '数学' | '英语' | '物理' | '化学' | '语文';

export const ALL_SUBJECTS: Subject[] = ['数学', '英语', '物理', '化学', '语文'];

export type HomeworkLoad = '轻松' | '适中' | '较重';
export type FatigueLevel = '低' | '中' | '高';

export type ErrorType =
  | '知识问题'
  | '方法问题'
  | '计算问题'
  | '熟练度问题'
  | '审题问题';

export type ConfidenceLevel = '确定' | '较可能' | '待验证';

export type MasteryState =
  | '未诊断'
  | '待学习'
  | '学习中'
  | '初步掌握'
  | '掌握'
  | '稳定掌握';

export type TeachingBehavior = '诊断' | '讲解' | '示范' | '引导' | '评测';

export type PracticeMode =
  | '诊断微测'
  | '基础练习'
  | '变式训练'
  | '迁移应用'
  | '延迟复测';

export type QuestionLevel = '基础题' | '变式题' | '迁移题' | '延迟复测';

export interface Student {
  id: string;
  name: string;
  grade: '初三';
  region: '上海';
  targetExamDate: string; // YYYY-MM-DD
  targetSchool: string;
  dailyBudgetMinutes: number;
  homeworkLoad: HomeworkLoad;
  fatigueLevel: FatigueLevel;
}

export interface Exam {
  id: string;
  title: string;
  type: '期中考试' | '月考' | '一模' | '二模' | '随堂诊断';
  date: string;
}

export interface ExamResult {
  id: string;
  examId: string;
  examTitle: string;
  subject: Subject;
  score: number;
  fullScore: number;
  targetScore: number;
  date: string;
}

export interface ExamPaper {
  id: string;
  examId: string;
  /**
   * 归属学生 ID。
   *
   * 分离后必须持久化：试卷是学生的数据，
   * 修改元信息等操作要校验「这张卷属于谁」，
   * 不能只信请求体里调用方自述的 studentId。
   */
  studentId?: string;
  examTitle?: string;
  examType?: Exam['type'];
  subject: Subject;
  title: string;
  date: string;
  score?: number;
  fullScore?: number;
  imageUrl?: string;
  rawText?: string;
  sourceFormat?: '试卷拍照' | '文本试卷' | '单题录入';
  status: '已识别' | '待校验';
  totalLostScore: number;
  questionsCount: number;
  summary: string;
  knowledgeIds?: string[];
  createdAt?: string;
  /** AI 提取的原始元信息（未经人工确认，置信度可能为「待验证」） */
  detectedMetadata?: DetectedMetadata;
  /** 人工确认后的元信息 —— 与 AI 提取值分离，保证可追溯 */
  confirmedMetadata?: DetectedMetadata;
}

/**
 * AI 从试卷中提取的元信息。
 *
 * 与 ExamPaper 分离定义，但同属领域模型，故在此声明并由 api/diagnosis.ts 重导出。
 */
export interface DetectedMetadata {
  subject: string;
  examTitle: string;
  examType: string;
  examDate: string;
  score: number;
  fullScore: number;
  metadataConfidence: string;
}

/**
 * 上海本地课本落点。
 *
 * 为什么需要：知识资产里的 `chapter` 来自人教版章节体系，
 * 而上海中考用的是沪教版（数学）与译林版（英语）。
 * 排课、诊断、报告如果报「人教版章节」，学生会翻不到对应的课本页。
 * 教材对齐作为**独立资产层**挂在知识点上，不改写知识资产本体。
 */
export interface TextbookRef {
  /** 教材版本 key（如 `hujiao_math`） */
  editionKey: string;
  /** 教材版本显示名（如「沪教版（上海教育出版社）数学」） */
  edition: string;
  /** 年级（如「七年级」） */
  grade: string;
  /** 学期（如「上册」） */
  term: string;
  /** 单元（如「第3单元 10以内的数」） */
  unit: string;
  /** 章节标题（如「1~5的认识」） */
  chapter: string;
  /** 源数据备注（如「旧版目录落点，待补判」） */
  note?: string;
}

export interface KnowledgePoint {
  id: string;
  subject: Subject;
  chapter: string;
  domain: string;
  name: string;
  subSkills: string[];
  definition: string;
  prerequisites: string[]; // knowledgeId[]
  commonExamForms: string[];
  commonTraps: string[];
  examWeight: number; // 0.6 - 1.5 exam frequency & weight
  learningCostHours: number; // estimated hours to close gap
  /** 上海本地课本落点（由教材对齐资产层填充，缺省表示尚未对齐） */
  textbook?: TextbookRef;
}

/**
 * 教材对齐资产（与知识资产、错因资产并列，可单独下架）。
 *
 * 只存「知识点 → 课本落点」的映射，不复制知识点本体。
 */
export interface TextbookAlignmentSet {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  source: {
    repo: string;
    path: string;
    license: string;
    licenseUrl?: string;
    note?: string;
  };
  entries: Array<{
    knowledgeId: string;
    textbook: TextbookRef;
  }>;
}

/**
 * 知识叠加层（overlay）。
 *
 * 用途：把**缺口领域**的知识点补进现有体系，而不重导整个知识资产。
 * 例：workbuddy 的 338 个英语应试点（音标/听力/写作/阅读策略/应试语法）
 * 与项目现有的 791 个教材单元制英语点几乎零重叠，
 * 但它们不属于任何教材单元，无法用 `chapter` 表达 ——
 * 于是走 overlay 层，用独立 id 命名空间（`cne_wb_*`）承载。
 */
export interface KnowledgeOverlayEntry {
  /** 项目原生 id（命名空间与主资产隔离，避免外键冲突） */
  id: string;
  subject: Subject;
  chapter: string;
  domain: string;
  name: string;
  subSkills: string[];
  definition: string;
  prerequisites: string[]; // knowledgeId[]
  commonExamForms: string[];
  commonTraps: string[];
  examWeight: number;
  learningCostHours: number;
  /** 关联的项目原生知识点（overlay 点挂到已有教材点上的桥梁） */
  relatedKnowledgeIds: string[];
  /** 源条目 id（便于回溯） */
  sourceId: string;
}

export interface KnowledgeOverlaySet {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  source: {
    repo: string;
    path: string;
    license: string;
    licenseUrl?: string;
    note?: string;
  };
  entries: KnowledgeOverlayEntry[];
}

export interface Question {
  id: string;
  region: '上海';
  grade: '初三';
  subject: Subject;
  questionType: '选择' | '填空' | '解答' | '实验' | '词汇语法';
  level: QuestionLevel;
  stem: string;
  options?: string[];
  standardAnswer: string;
  scoreValue: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

export interface QuestionKnowledge {
  questionId: string;
  knowledgeId: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// 错因资产（TrapSet）
// ---------------------------------------------------------------------------

/**
 * 错因条目的匹配置信度。
 *
 * - `high`   源数据自带知识点 id，或主题名精确命中 → 可直接发布
 * - `medium` 名称包含匹配 → **必须人工确认**后才能进 ACTIVE
 * - `low`    弱线索，仅作待审池保留
 * - `unmatched` 尚未挂到任何知识点
 */
export type TrapConfidence = 'high' | 'medium' | 'low' | 'unmatched';

/** 错因条目与知识点的匹配方式（用于审计：这条是怎么挂上去的）。 */
export type TrapMatchMethod =
  | 'source-topic' // 源项目自带知识点 id，直接命中
  | 'manual-map' // 人工维护的 id 映射表命中
  | 'exact-name' // 主题名精确命中
  | 'exact-name-alias' // 主题名别名命中（如去掉「的」后精确命中）
  | 'name-contains' // 主题名包含匹配（置信度 medium）
  | 'evidence' // 证据匹配：知识点在同一册同章的来源主题里找到最强证据，整篇继承
  | 'none';

/**
 * 一条错因。
 *
 * 三段式（错在哪 / 为什么错 / 怎么做对）沿用 junior-math-atlas 的 `pitfalls` 结构；
 * 源数据未标注的字段留空串，**不允许模型补写**（红线：不得凭空生成易错点）。
 */
export interface TrapEntry {
  id: string;
  /** 命中的 daydayup 知识点 id；未匹配为 null */
  knowledgeId: string | null;
  /** 命中的题目 id（题目级错因） */
  questionIds: string[];
  subject: string;
  stage: string;
  matchConfidence: TrapConfidence;
  matchMethod: TrapMatchMethod;
  /** 错误表现 */
  wrong: string;
  /** 错因 */
  why: string;
  /** 正确做法 */
  right: string;
  /** 源条目 id（便于回溯源项目） */
  sourceId: string;
  /** 源文本原文 */
  sourceText?: string;
}

/**
 * 错因资产文件（与知识资产、题库并列，独立可下架）。
 *
 * 为什么不并进知识资产：各来源授权不同、粒度不同、匹配置信度不同，
 * 混在一个 JSON 里无法单独回滚某个来源。
 */
export interface TrapSet {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subject: string;
  source: {
    repo: string;
    path: string;
    license: string;
    licenseUrl?: string;
    note?: string;
  };
  entries: TrapEntry[];
}

export interface ErrorRecord {
  id: string;
  examId?: string;
  examPaperId?: string;
  examTitle: string;
  questionNumber: string;
  subject: Subject;
  stem: string;
  studentAnswer: string;
  correctAnswer: string;
  scoreLost: number;
  errorType: ErrorType;
  knowledgeId: string;
  knowledgeName: string;
  aiAnalysis: string;
  evidence: string;
  confidence: ConfidenceLevel;
  verificationMethod: string;
  status: '未订正' | '已订正' | '待复测' | '已闭环';
  correctionNote?: string;
  createdAt: string;
}

export interface MasteryRecord {
  knowledgeId: string;
  state: MasteryState;
  confidence: ConfidenceLevel;
  lostScoreEvidence: number;
  recoveryProbability: number; // 0.1 - 0.95
  evidenceLogs: string[];
  consecutiveErrors: number;
  practiceCorrect: number;
  practiceTotal: number;
  variantPassed: boolean;
  delayedRetestPassed: boolean;
  preliminaryMasteredAt?: string;
  nextRetestAvailableAt?: string;
  updatedAt: string;
}

export interface PriorityOpportunity {
  knowledgeId: string;
  subject: Subject;
  knowledgeName: string;
  domain: string;
  lostScore: number;
  recoveryProbability: number;
  expectedGain: number;
  learningCostHours: number;
  confidenceScore: number;
  confidenceLabel: ConfidenceLevel;
  examWeight: number;
  priorityScore: number;
  priorityTier: '高' | '中' | '低';
  blockedByPrerequisite?: string;
  rationale: string;
}

export interface TaskStep {
  label: string;
  minutes: number;
  done: boolean;
}

export type LearningTaskStatus = '待开始' | '进行中' | '已完成' | '已重排';

export interface LearningTask {
  id: string;
  dayIndex: number; // 0 = Today, 1..6 = Next 6 days
  dayLabel: string;
  subject: Subject;
  knowledgeId: string;
  knowledgeName: string;
  title: string;
  objective: string;
  verifiableOutcome: string;
  estimatedMinutes: number;
  steps: TaskStep[];
  status: '待开始' | '进行中' | '已完成' | '已重排';
  priorityRank: number;
  difficultyAdjusted?: boolean;
  carriedOverFromToday?: boolean;
  /** 上海本地课本落点（沪教版数学 / 译林版英语），供前端显示「课本定位」 */
  textbook?: TextbookRef;
}

export interface DailySchedule {
  dayIndex: number;
  dayLabel: string;
  totalMinutes: number;
  tasks: LearningTask[];
}

export interface LearningPlan {
  id: string;
  weekLabel: string;
  effectiveDailyBudget: number;
  generatedAt: string;
  priorities: PriorityOpportunity[];
  days: DailySchedule[];
  /** 算法版本，用于结果可追溯（哪个引擎版本生成的这份计划） */
  engineVersion?: string;
}

export interface LearningAttempt {
  id: string;
  taskId?: string;
  knowledgeId: string;
  subject: Subject;
  mode: PracticeMode;
  questionStem: string;
  userAnswer: string;
  isCorrect: boolean;
  hintsUsed: number;
  timeSpentSeconds: number;
  independent: boolean;
  aiFeedback: string;
  timestamp: string;
}

export interface VariantQuestion {
  id: string;
  sourceErrorId?: string;
  knowledgeId: string;
  subject: Subject;
  level: QuestionLevel;
  stem: string;
  options?: string[];
  standardAnswer: string;
  solutionSteps: string[];
  commonTrap: string;
  source?: '教研题库' | 'AI变式';
  dualVerified?: boolean;
  verificationCheck?: string;
  completed?: boolean;
  passed?: boolean;
}

export interface CoachMessage {
  id: string;
  role: 'coach' | 'user';
  text: string;
  behavior?: TeachingBehavior;
}

export interface MasteryTransitionEvent {
  id: string;
  knowledgeId: string;
  subject: Subject;
  fromState: MasteryState;
  toState: MasteryState;
  trigger: string;
  timestamp: string;
}

export type AppPage =
  | 'today'
  | 'diagnosis'
  | 'errors'
  | 'knowledge'
  | 'planning'
  | 'sprint'
  | 'coach'
  | 'report'
  | 'teacher'
  | 'settings';
/**
 * 掌握度状态的显示顺序（常量，非业务逻辑）。
 *
 * 允许放在契约包供前端 UI 排序使用；
 * 但**状态迁移规则**属服务端 MasteryEngine，前端不得本地推导。
 */
export const MASTERY_ORDER: MasteryState[] = [
  '未诊断',
  '待学习',
  '学习中',
  '初步掌握',
  '掌握',
  '稳定掌握',
];

/**
 * 延迟复测间隔天数（常量）。
 * 具体的解锁判定在服务端，因其依赖服务端时钟。
 */
export const RETEST_INTERVAL_DAYS = 3;

/**
 * 置信度权重（供 UI 展示与优先级说明）。
 * 服务端 ScoreEngine 使用同一套权重。
 */
export const CONFIDENCE_WEIGHT: Record<ConfidenceLevel, number> = {
  确定: 1.0,
  较可能: 0.8,
  待验证: 0.55,
};

export interface AppState {
  student: Student;
  exams: Exam[];
  examResults: ExamResult[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  masteryHistory: MasteryTransitionEvent[];
  learningAttempts: LearningAttempt[];
  variantQuestions: VariantQuestion[];
  completedTaskIds: string[];
  deferredKnowledgeIds: string[];
  coachHistoryByKnowledge: Record<string, CoachMessage[]>;
  taskProgressByKnowledge: Record<string, {
    reviewedConcept?: boolean;
    viewedExample?: boolean;
    practiceSolvedCount: number;
    reviewedFeedback?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// 自适应诊断（三态判定）
// ---------------------------------------------------------------------------

/**
 * 单个知识点的诊断结论。
 *
 * - `掌握` 连续答对确认题（默认 3 题）判定
 * - `不稳` 中途答错、确认题答对 —— 不回溯先修，但进入学习路径
 * - `薄弱` 答错且确认题也错 —— 回溯先修，是真正的薄弱点
 * - `未测` 题量用尽未测到
 */
export type DiagnosticVerdict = '掌握' | '不稳' | '薄弱' | '未测';

/** 单题判定结果（`manual` 表示需要人工/学生自评） */
export type AnswerVerdict = 'correct' | 'wrong' | 'manual' | 'skip';

export interface AdaptiveAnswer {
  order: number;
  knowledgeId: string;
  questionId: string;
  difficulty: string;
  type: string;
  prompt: string;
  userAnswer: string;
  verdict: AnswerVerdict;
  referenceAnswer: string;
  explanation: string;
  answeredAt: string;
}

export interface AdaptiveWeakRoot {
  knowledgeId: string;
  name: string;
  /** 直接先修（未判定为薄弱的那些） */
  prerequisites: string[];
  /** 因题量用尽而未测的先修 —— 真正的根因可能更靠前 */
  untestedPrerequisites: string[];
  /** 范围外先修（筛查模式下提示「未检查」） */
  outOfScopePrerequisites: string[];
}

export interface AdaptivePathStep {
  order: number;
  knowledgeId: string;
  name: string;
  status: DiagnosticVerdict;
}

export interface AdaptiveChapterSummary {
  label: string;
  mastered: number;
  shaky: number;
  weak: number;
  untested: number;
}

export interface AdaptiveDiagnosticSummary {
  /** 知识点 id → 判定结论 */
  verdicts: Record<string, DiagnosticVerdict>;
  mastered: string[];
  shaky: string[];
  weak: string[];
  untested: string[];
  /** 薄弱根因（自身薄弱、且直接先修都不薄弱） */
  weakRoots: AdaptiveWeakRoot[];
  /** 按先修顺序排列的学习路径 */
  path: AdaptivePathStep[];
  chapters: AdaptiveChapterSummary[];
  answered: number;
  limitReached: boolean;
  finished: boolean;
}

/**
 * 自适应诊断会话。
 *
 * 会话对象可 JSON 序列化 —— 由服务端持久化，
 * 前端只负责提交答案与展示结论。
 */
export interface AdaptiveDiagnosticSession {
  id: string;
  studentId: string;
  subject: Subject;
  /** `target` 单点/整章目标；`screen` 整年级/整册筛查 */
  mode: 'target' | 'screen';
  label: string;
  targets: string[];
  /** 每个知识点需连续答对几题才判掌握（2/3/5） */
  confirm: number;
  /** 题量上限（按题计） */
  limit: number;
  /** 选题随机种子 —— 同一 seed + 同一作答记录 → 同一套题 */
  seed: string;
  status: '进行中' | '已完成';
  createdAt: string;
  updatedAt: string;
  answers: AdaptiveAnswer[];
  summary?: AdaptiveDiagnosticSummary;
}

// ---------------------------------------------------------------------------
// 冲刺计划（30 天冲刺类资产）
// ---------------------------------------------------------------------------

/**
 * 冲刺资产里的「一天」。
 *
 * 与 LearningPlan 的 7 天排课不同：冲刺计划由**外部教研资产**定义
 * （例：「上海中考英语提分实战手册」的「30天冲刺」表），
 * 服务端只负责把它落到真实知识点、受学生时间预算约束后转成任务。
 */
export interface SprintDay {
  /** 冲刺第几天（1 起） */
  dayIndex: number;
  /** 阶段名（例：「第一阶段 · 止血（基础分零失分）」） */
  stage: string;
  /** 当日任务原文 */
  task: string;
  /** 限时描述原文（例：「每日 35–45 分钟；整套卷日 90 分钟」） */
  timeLimit: string;
  /** 当日验收标准原文 */
  acceptanceCriteria: string;
  subject: Subject;
  /** 建议关联的知识点 id（可为空 → 引擎走兜底知识点） */
  knowledgeIds: string[];
}

/** 冲刺的一个阶段（用于描述阶段级验收标准） */
export interface SprintStage {
  name: string;
  acceptanceCriteria: string;
  /** 阶段起始天（1 起，含） */
  fromDay: number;
  /** 阶段结束天（含） */
  toDay: number;
}

/**
 * 冲刺资产（文件形态）。
 *
 * 与知识资产、错因资产、教材对齐资产并列，可单独下架；
 * **只有 ACTIVE 生效**，DRAFT 只告警（见 infrastructure/knowledge/sprint.ts）。
 */
export interface SprintSet {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE';
  source: {
    repo: string;
    path: string;
    license: string;
    licenseUrl?: string;
    note?: string;
  };
  /** 阶段级验收标准 */
  stages: SprintStage[];
  days: SprintDay[];
}

/** 冲刺引擎产出的一天 */
export interface SprintDayPlan {
  dayIndex: number;
  dayLabel: string; // 例：「第1天」
  stage: string;
  task: string;
  timeLimit: string;
  acceptanceCriteria: string;
  totalMinutes: number;
  /** 任务的 dayIndex 与冲刺天序号一致（1..30） */
  tasks: LearningTask[];
}

/** 冲刺引擎产出（30 天） */
export interface SprintPlan {
  id: string;
  subject: Subject;
  /** 引擎版本（例：sprint.v1），用于结果可追溯 */
  engineVersion: string;
  generatedAt: string;
  /** 学生每日有效学习预算（分钟），冲刺日总时长不得超过它 */
  effectiveDailyBudget: number;
  totalDays: number;
  days: SprintDayPlan[];
}
