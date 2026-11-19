/**
 * 知识体系加载器（服务端唯一事实源）。
 *
 * 分离后前端不再硬编码知识本体，改为通过 /api/v1/knowledge-points 获取。
 * 本模块负责从 JSON 资产加载、构建索引、暴露版本号。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgePoint, Subject, TrapSet } from '@daydayup/contracts';
import { logger } from '../logging/logger.ts';
import { applyTrapSets } from './converters/trap-overlay.ts';
import { PACKAGED_ASSET_DIRS, resolveDataDir } from './asset-dirs.ts';
import { applyTextbookAlignment, getTextbookMap } from './textbook-alignment.ts';
import { applyKnowledgeOverlays } from './overlay.ts';

export { resolveDataDir };

const KNOWLEDGE_DIR = PACKAGED_ASSET_DIRS.knowledge();
const QUESTION_DIR = PACKAGED_ASSET_DIRS.questions();
/**
 * 错因资产目录（TrapSet）。
 *
 * 与知识资产分目录存放：来源授权不同、粒度不同、匹配置信度不同，
 * 必须能单独下架某个来源（见 docs/trap-assets-integration-plan.md）。
 */
const TRAP_DIR = PACKAGED_ASSET_DIRS.traps();

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
    options?: string[];
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
let trapSetsCache: TrapSet[] | null = null;

/**
 * 读取生效中的错因资产（TrapSet）。
 *
 * 规则与知识资产一致：**只有 ACTIVE 才生效**。
 * 只有 DRAFT 时不生效（错因未经教师审核不得进入线上提示词），
 * 但会打告警，便于运维知道「错因资产还没审核」。
 *
 * 目录不存在（首次部署、尚未导入）时返回空数组 —— 缺错因资产不应让服务起不来。
 */
function readTrapSets(): TrapSet[] {
  if (!fs.existsSync(TRAP_DIR)) return [];
  const files = fs
    .readdirSync(TRAP_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const readable: Array<{ file: string; parsed: TrapSet }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(TRAP_DIR, file), 'utf8')
      ) as TrapSet;
      // 形状校验：目录里可能还有 id-map.json、待审清单等非资产文件
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) continue;
      readable.push({ file, parsed });
    } catch (err) {
      logger.error('trap.asset_unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const active = readable.filter((r) => r.parsed.status === 'ACTIVE');
  if (active.length > 0) return active.map((r) => r.parsed);

  const drafts = readable.filter((r) => r.parsed.status === 'DRAFT');
  if (drafts.length > 0) {
    logger.warn('trap.only_draft_assets', { files: drafts.map((d) => d.file) });
  }
  return [];
}

/** 生效中的错因资产（无则空数组） */
export function getTrapSets(): TrapSet[] {
  if (!trapSetsCache) trapSetsCache = readTrapSets();
  return trapSetsCache;
}

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
  const parsed = JSON.parse(
    fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8')
  ) as CurriculumAsset;

  // 知识叠加层（overlay）：把「不属于任何教材单元」的应试点型补进体系。
  // 与教材对齐一样是独立资产层：可单独下架/回滚，不动主资产。
  //
  // ⚠️ 必须排在错因资产**之前**：错因可以挂在叠加层知识点上
  // （英语知识地图的 338 条就落在 `cne_wb_*`），
  // 反过来先挂错因的话这些条目会因为「知识点还不存在」而全部落空。
  parsed.knowledgePoints = applyKnowledgeOverlays(parsed.knowledgePoints);

  // 错因资产覆盖：把 TrapSet 里的条目挂到对应知识点的 commonTraps 上。
  // 知识资产本身不带错因（cn-mt 无此字段），错因由独立资产层提供，
  // 这样错因可以单独更新/回滚，不必重跑整个知识体系导入。
  const traps = getTrapSets();
  if (traps.length > 0) {
    const result = applyTrapSets(parsed.knowledgePoints, [], traps);
    if (result.knowledgeTraps > 0) {
      logger.info('trap.overlay_applied', {
        knowledgeTraps: result.knowledgeTraps,
        affected: result.affectedKnowledgeIds.length,
      });
    }
  }

  // 教材对齐覆盖：把上海本地课本落点（沪教版数学 / 译林版英语）挂到知识点上。
  // 知识资产本身的 chapter 是人教版章节，不改写本体 —— 只叠加课本落点。
  const textbookMap = getTextbookMap();
  if (Object.keys(textbookMap).length > 0) {
    const result = applyTextbookAlignment(parsed.knowledgePoints, textbookMap);
    logger.info('textbook.overlay_applied', {
      aligned: result.aligned,
      total: parsed.knowledgePoints.length,
    });
  }

  curriculumCache = parsed;
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
 * 多文件合并：第 1 条命中的**所有**文件都会被合并（按题 id 去重，先出现的保留）。
 * 这样「不同来源的题库各自成一个文件」（如 workbuddy 专项题库）可以并存，
 * 而不必把 1 万多道题塞进同一个文件里。
 *
 * 容错：某个文件损坏（JSON 非法）时跳过它；全部不可用才报错。
 */
function readActiveBankFiles(): { files: string[]; version: string } {
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

  // 1. 优先选与当前知识体系版本配套的题库（全部命中文件都合并）
  const curriculumVersion = getCurriculumVersion();
  const matched = readable.filter(
    (b) =>
      b.version === curriculumVersion ||
      b.version === `${curriculumVersion}+questions`
  );
  if (matched.length > 0) {
    // version 取按文件名排序后的第一个匹配文件的版本
    return { files: matched.map((m) => m.file), version: matched[0].version };
  }

  // 2. 回落：文件名排序最后（**不与其他文件合并**）
  const last = readable[readable.length - 1];
  return { files: [last.file], version: last.version };
}

export function getQuestionBank(): QuestionBankAsset {
  if (bankCache) return bankCache;
  const { files, version } = readActiveBankFiles();

  const questions: QuestionBankAsset['questions'] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(QUESTION_DIR, file), 'utf8')
    ) as QuestionBankAsset;
    for (const q of parsed.questions ?? []) {
      if (seen.has(q.id)) continue; // 同 id 保留先出现的
      seen.add(q.id);
      questions.push(q);
    }
  }

  const bank: QuestionBankAsset = { version, questions };

  // 题目级错因覆盖（commonErrors）。
  const traps = getTrapSets();
  if (traps.length > 0) {
    const result = applyTrapSets([], bank.questions, traps);
    if (result.questionErrors > 0) {
      logger.info('trap.question_overlay_applied', {
        questionErrors: result.questionErrors,
      });
    }
  }

  bankCache = bank;
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
