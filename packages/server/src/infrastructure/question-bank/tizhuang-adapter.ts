/**
 * 题庄题目 → 项目 contracts `Question` 的适配层。
 *
 * 题庄是「试卷口径」，项目契约是「知识点口径」，两者字段一一对应但需要翻译：
 *
 * | 题庄 | contracts | 翻译规则 |
 * |---|---|---|
 * | `id` (数字) | `id` | `cne_tz_<数字>`（原生 id 命名空间，正则 `cne(_[a-z0-9]+)+` 合法） |
 * | `question_type` | `questionType` | 题型名 → `选择/填空/解答/实验/词汇语法` |
 * | `difficulty` (0-5 浮点) | `difficulty` (1-5 整数) | 夹取到 1..5 后取整 |
 * | `difficulty` | `level` | ≤2 → 基础题；3 → 变式题；≥4 → 迁移题 |
 * | `title` | `stem` | 已去 HTML 标签 / 已解实体（见 `tizhuang.ts`） |
 * | `options` | `options` | 带标签的字符串数组 `['A. …']` |
 * | `answer` | `standardAnswer` | 原样 |
 * | `analysis` | `solutionSteps` | 按换行/分号拆成步骤 |
 * | `knowledges` | `knowledgeIds` | 知识点名 → 项目原生 id（见 `knowledge-mapping.ts`） |
 */
import type { Question } from '@daydayup/contracts';
import type { TizhuangQuestion } from './tizhuang.ts';
import {
  mapTizhuangKnowledgeNames,
  type KnowledgePointLite,
} from './knowledge-mapping.ts';

/** 题庄题型名 → contracts 题型 */
const QUESTION_TYPE_MAP: Record<string, Question['questionType']> = {
  选择题: '选择',
  判断题: '选择',
  匹配题: '选择',
  填空题: '填空',
  阅读填空: '填空',
  首字母填空: '填空',
  '单词拼写（词汇运用）': '填空',
  '选词填空（词汇运用）': '填空',
  解答题: '解答',
  实验题: '实验',
  连词成句: '词汇语法',
  句型转换: '词汇语法',
  改错: '词汇语法',
  补全对话: '词汇语法',
  情景交际: '词汇语法',
  翻译: '词汇语法',
  完形填空: '词汇语法',
  阅读理解: '词汇语法',
  书面表达: '词汇语法',
  排序题: '词汇语法',
  音标题: '词汇语法',
};

/** 未识别题型时的兜底（按题庄习惯，多为语法填空类） */
const DEFAULT_QUESTION_TYPE: Question['questionType'] = '词汇语法';

/** 各题型的默认分值 */
const SCORE_BY_TYPE: Record<Question['questionType'], number> = {
  选择: 2,
  填空: 2,
  解答: 4,
  实验: 4,
  词汇语法: 2,
};

/** 学科 → contracts Subject（题庄只覆盖本项目五科） */
export function toContractSubject(subject: string): Question['subject'] {
  switch (subject) {
    case '数学':
    case '英语':
    case '物理':
    case '化学':
    case '语文':
      return subject;
    default:
      return '英语';
  }
}

/** 题庄难度 → contracts level */
export function toContractLevel(difficulty: number): Question['level'] {
  if (!Number.isFinite(difficulty) || difficulty <= 2) return '基础题';
  if (difficulty < 4) return '变式题';
  return '迁移题';
}

/** 题庄难度 → contracts difficulty（1-5 整数） */
export function toContractDifficulty(difficulty: number): Question['difficulty'] {
  if (!Number.isFinite(difficulty)) return 3;
  const value = Math.min(5, Math.max(1, Math.round(difficulty)));
  return value as Question['difficulty'];
}

/** 题庄题型名 → contracts 题型 */
export function toContractQuestionType(
  questionType: string
): Question['questionType'] {
  const key = questionType.trim();
  return QUESTION_TYPE_MAP[key] ?? DEFAULT_QUESTION_TYPE;
}

/** 题庄解析 → 解题步骤 */
export function toSolutionSteps(analysis: string | undefined): string[] {
  if (!analysis) return [];
  return analysis
    .split(/[\n；;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * 把一道题庄题目转成 contracts `Question`。
 *
 * @param question        题庄题目
 * @param knowledgePoints 运行时知识点集合（用于知识点名 → 原生 id）
 * @param fallbackKnowledgeIds 请求方指定的知识点 id（题庄知识点名无法映射时兜底）
 */
export function toContractQuestion(
  question: TizhuangQuestion,
  knowledgePoints: KnowledgePointLite[],
  fallbackKnowledgeIds: string[] = []
): Question {
  const matches = mapTizhuangKnowledgeNames(
    question.knowledgeNames,
    knowledgePoints
  );
  const knowledgeIds: string[] = [];
  for (const match of matches) {
    if (match.id && !knowledgeIds.includes(match.id)) knowledgeIds.push(match.id);
  }
  // 请求方指定的知识点（按它检索出来的）永远保留在 knowledgeIds 里：
  // 题庄返回的知识点名可能更粗（如 '并列连词'），不能因此丢掉精确考点。
  for (const id of fallbackKnowledgeIds) {
    if (!knowledgeIds.includes(id)) knowledgeIds.push(id);
  }

  const questionType = toContractQuestionType(question.questionType);
  const difficulty = toContractDifficulty(question.difficulty);

  return {
    id: `cne_tz_${question.externalId}`,
    region: '上海',
    grade: '初三',
    subject: toContractSubject('英语'),
    questionType,
    level: toContractLevel(question.difficulty),
    stem: question.stem,
    options: question.options,
    standardAnswer: question.answer,
    scoreValue: SCORE_BY_TYPE[questionType],
    difficulty,
    solutionSteps: toSolutionSteps(question.analysis),
    commonErrors: [],
    knowledgeIds,
  };
}
