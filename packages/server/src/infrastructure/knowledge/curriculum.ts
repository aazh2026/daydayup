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
 * 打包的默认资产目录：packages/server/data
 *
 * 本文件位于 src/infrastructure/knowledge/，故需上溯 4 层：
 *   knowledge → infrastructure → src → packages/server
 */
const PACKAGED_DATA_DIR = path.resolve(__dirname, '../../../data');

/**
 * 运行期数据目录。
 *
 * 支持 `DATA_DIR` 环境变量覆盖（与 seed.ts / backup.ts 等脚本保持一致）：
 * 测试、多实例部署、以及知识资产导入验证都需要指向自定义目录，
 * 否则无法在不污染生产数据的前提下试跑新资产。
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : PACKAGED_DATA_DIR;

/**
 * 解析知识资产目录。
 *
 * 优先用 `DATA_DIR/knowledge`（部署时随数据卷一起分发的资产），
 * **回落到打包目录** `packages/server/data/knowledge`。
 *
 * 为什么需要回落：
 * `DATA_DIR` 常被指向一个只包含 `db/` 的空目录
 * （测试用临时目录、首次部署时新建的数据卷），
 * 此时若只读 `DATA_DIR/knowledge` 就会 `ENOENT` ——
 * 连 seed 脚本都跑不起来（它要读知识体系来打印版本号）。
 *
 * 回落让「数据与资产分离」成为可能：业务数据放数据卷，
 * 知识资产用随包发布的版本，缺省即可用。
 */
function resolveAssetDir(dirName: 'knowledge' | 'questions'): string {
  const override = path.join(DATA_DIR, dirName);
  if (
    fs.existsSync(override) &&
    fs.readdirSync(override).some((f) => f.endsWith('.json'))
  ) {
    return override;
  }
  const packaged = path.join(PACKAGED_DATA_DIR, dirName);
  if (fs.existsSync(packaged)) return packaged;
  return override;
}

const KNOWLEDGE_DIR = resolveAssetDir('knowledge');
const QUESTION_DIR = resolveAssetDir('questions');

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

  // 没有 ACTIVE：取排序最后的**非草稿**版本（DEPRECATED 表示曾生效）
  const nonDraft = candidates.filter((c) => c.parsed.status !== 'DRAFT');
  if (nonDraft.length > 0) {
    return nonDraft[nonDraft.length - 1].file;
  }

  // 全部是 DRAFT：加载最后一个草稿，并明确告警
  // （草稿仍可用于开发/预览，但必须让运维知道当前跑的不是审核过的版本）
  logger.warn('curriculum.only_draft_assets', {
    files: candidates.map((c) => c.file),
  });
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

export type CurriculumStage = '小学' | '初中' | '高中';

/**
 * 判断知识点所属学段。
 *
 * 依据：
 * - cn-math-taxonomy id 规则：小学带 _p，高中带 _h
 * - chapter 章节名包含年级特征
 */
export function resolveKnowledgeStage(kp: { id: string; chapter?: string }): CurriculumStage {
  if (kp.id.includes('_p') || /cn._p/.test(kp.id)) return '小学';
  if (kp.id.includes('_h') || /cn._h/.test(kp.id)) return '高中';
  const ch = kp.chapter || '';
  if (
    /六年级|六上|六下|五年级|五上|五下|四年级|四上|四下|三年级|三上|三下|二年级|二上|二下|一年级|一上|一下/.test(
      ch
    )
  ) {
    return '小学';
  }
  if (/高一|高二|高三|必修|选择性必修|选必/.test(ch)) {
    return '高中';
  }
  return '初中';
}

export function listKnowledgePoints(
  subject?: Subject,
  stage?: CurriculumStage | 'all'
): KnowledgePoint[] {
  const all = getCurriculum().knowledgePoints;
  let result = subject ? all.filter((kp) => kp.subject === subject) : all;
  if (stage && stage !== 'all') {
    result = result.filter((kp) => resolveKnowledgeStage(kp) === stage);
  }
  return result;
}

/**
 * 找出应当生效的题库资产文件。
 *
 * 规则（优先级从高到低）：
 *  1. **与当前生效知识体系版本配套**的题库
 *     （题库的 version 等于知识体系的 version 或 version+questions）
 *  2. **文件名排序最后**的题库 —— 版本号字典序即版本序
 *
 * 为什么要有第 1 条：题库与知识体系是靠 `knowledgeIds` 关联的。
 * 若两者版本不配套，新知识点会一条题都取不到（取题永远落空），
 * 而这不会抛异常，只会让功能静默失效。
 *
 * 容错：某个文件损坏（JSON 非法）时跳过它；全部不可用才报错。
 */
function readActiveBankFile(): string {
  const files = fs
    .readdirSync(QUESTION_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No question bank asset found in ${QUESTION_DIR}`);
  }

  const readable: Array<{ file: string; version: string }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(QUESTION_DIR, file), 'utf8')
      ) as { version?: string };
      readable.push({ file, version: parsed.version ?? '' });
    } catch (err) {
      logger.error('questionbank.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (readable.length === 0) {
    throw new Error(
      `No readable question bank asset in ${QUESTION_DIR} (${files.length} file(s) found)`
    );
  }

  // 1. 优先选与当前知识体系版本配套的题库
  const curriculumVersion = getCurriculumVersion();
  const matched = readable.find(
    (b) =>
      b.version === curriculumVersion ||
      b.version === `${curriculumVersion}+questions`
  );
  if (matched) return matched.file;

  // 2. 回落：文件名排序最后
  return readable[readable.length - 1].file;
}

export function getQuestionBank(): QuestionBankAsset {
  if (bankCache) return bankCache;
  const file = readActiveBankFile();
  bankCache = JSON.parse(
    fs.readFileSync(path.join(QUESTION_DIR, file), 'utf8')
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
