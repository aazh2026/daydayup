/**
 * 知识体系加载器（服务端唯一事实源）。
 *
 * 分离后前端不再硬编码知识本体，改为通过 /api/v1/knowledge-points 获取。
 * 本模块负责从 JSON 资产加载、构建索引、暴露版本号。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgePoint, Subject } from '@daydayup/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 数据目录：packages/server/data
 *
 * 本文件位于 src/infrastructure/knowledge/，故需上溯 4 层：
 *   knowledge → infrastructure → src → packages/server
 */
export const DATA_DIR = path.resolve(__dirname, '../../../data');
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
const QUESTION_DIR = path.join(DATA_DIR, 'questions');

export interface CurriculumAsset {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subjects: Subject[];
  knowledgePoints: KnowledgePoint[];
}

export interface QuestionBankAsset {
  version: string;
  questions: Array<{
    id: string;
    subject: Subject;
    region: string;
    grade: string;
    questionType: string;
    level: string;
    stem: string;
    standardAnswer: string;
    scoreValue: number;
    difficulty: number;
    solutionSteps: string[];
    commonErrors: string[];
    knowledgeIds: string[];
  }>;
}

let curriculumCache: CurriculumAsset | null = null;
let bankCache: QuestionBankAsset | null = null;
let knowledgeMapCache: Record<string, KnowledgePoint> | null = null;

function readActiveCurriculumFile(): string {
  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No curriculum asset found in ${KNOWLEDGE_DIR}`);
  }
  // 优先选 ACTIVE 版本
  for (const file of files) {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8')
    ) as CurriculumAsset;
    if (parsed.status === 'ACTIVE') return file;
  }
  return files[files.length - 1];
}

export function getCurriculum(): CurriculumAsset {
  if (curriculumCache) return curriculumCache;
  const file = readActiveCurriculumFile();
  curriculumCache = JSON.parse(
    fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8')
  ) as CurriculumAsset;
  return curriculumCache;
}

export function getKnowledgeMap(): Record<string, KnowledgePoint> {
  if (knowledgeMapCache) return knowledgeMapCache;
  const curriculum = getCurriculum();
  knowledgeMapCache = Object.fromEntries(
    curriculum.knowledgePoints.map((kp) => [kp.id, kp])
  );
  return knowledgeMapCache;
}

export function getCurriculumVersion(): string {
  return getCurriculum().version;
}

export function listKnowledgePoints(subject?: Subject): KnowledgePoint[] {
  const all = getCurriculum().knowledgePoints;
  return subject ? all.filter((kp) => kp.subject === subject) : all;
}

export function getQuestionBank(): QuestionBankAsset {
  if (bankCache) return bankCache;
  const files = fs
    .readdirSync(QUESTION_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No question bank asset found in ${QUESTION_DIR}`);
  }
  bankCache = JSON.parse(
    fs.readFileSync(path.join(QUESTION_DIR, files[files.length - 1]), 'utf8')
  ) as QuestionBankAsset;
  return bankCache;
}

/** 按知识点 + 难度查题（题库优先策略） */
export function findBankQuestions(
  knowledgeId: string,
  level: string,
  excludeStems: string[] = []
): QuestionBankAsset['questions'] {
  const bank = getQuestionBank();
  const excluded = new Set(excludeStems);
  const candidates = bank.questions.filter(
    (q) =>
      q.knowledgeIds.includes(knowledgeId) &&
      q.level === level &&
      !excluded.has(q.stem)
  );
  // 同知识点多等级兜底
  if (candidates.length === 0) {
    return bank.questions.filter(
      (q) => q.knowledgeIds.includes(knowledgeId) && !excluded.has(q.stem)
    );
  }
  return candidates;
}
