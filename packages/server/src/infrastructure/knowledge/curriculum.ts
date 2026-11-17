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
import { logger } from '../logging/logger.ts';

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

/**
 * 从候选资产中选出应生效的那一个。
 *
 * 纯函数，便于单测（资产选择逻辑关系到「加载的是不是对的版本」）。
 *
 * @param candidates 文件名 → 解析结果（解析失败的不会出现在其中）
 * @returns 生效的文件名
 */
export function selectCurriculumFile(
  candidates: Array<{ file: string; parsed: CurriculumAsset }>
): string {
  if (candidates.length === 0) {
    throw new Error('No readable curriculum asset');
  }
  // 优先选 ACTIVE 版本
  const active = candidates.find((c) => c.parsed.status === 'ACTIVE');
  if (active) return active.file;
  // 没有 ACTIVE：取排序最后的（版本号字典序即版本序）
  return candidates[candidates.length - 1].file;
}

/**
 * 找出应当生效的知识体系资产文件。
 *
 * 优先选 status=ACTIVE 的版本；没有 ACTIVE 时取文件名排序最后的一个
 * （版本号形如 `shanghai-junior-2026.1`，字典序即版本序）。
 *
 * 容错：某个资产文件损坏（JSON 非法）时**跳过**它，而不是让整个
 * 知识体系接口 500 —— 知识体系是服务端唯一事实源，
 * 一个坏文件不该让所有功能一起挂掉。但如果**所有**文件都不可用，
 * 必须明确报错（静默返回空会让前端展示空白却毫无线索）。
 */
function readActiveCurriculumFile(): string {
  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No curriculum asset found in ${KNOWLEDGE_DIR}`);
  }

  const readable: Array<{ file: string; parsed: CurriculumAsset }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8')
      ) as CurriculumAsset;
      readable.push({ file, parsed });
    } catch (err) {
      logger.error('curriculum.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (readable.length === 0) {
    throw new Error(
      `No readable curriculum asset in ${KNOWLEDGE_DIR} (${files.length} file(s) found)`
    );
  }

  return selectCurriculumFile(readable);
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
