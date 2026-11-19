/**
 * 三态自适应诊断服务（服务端权威）。
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *
 * 把 `diagnosis-engine.ts`（纯函数引擎）接到三件事上：
 *
 * 1. **项目资产**：知识点图谱取自项目原生知识资产，题目取自项目题库；
 * 2. **持久化**：会话状态存 `db/diagnosis/{studentId}.json`，
 *    刷新 / 断线 / 服务重启后可继续（答案记录里带 qid，用 `replay()` 精确重建）；
 * 3. **掌握度落库**：会话结束后把三态结论写进 MasteryRecord ——
 *    `mastered → 初步掌握`、`shaky → 学习中`、`weak → 待学习`。
 *
 * ── 为什么不直接在前端做 ──────────────────────────────────────────────
 *
 * 掌握度状态迁移只能由服务端产生并落库（见 mastery-engine 头注释）。
 * 如果诊断在前端算状态，学生改一下 JS 就能把自己从「待学习」改成「掌握」。
 *
 * ── 会话文件结构 ──────────────────────────────────────────────────────
 *
 * ```json
 * {
 *   "studentId": "...",
 *   "sessions": {
 *     "<sessionId>": {
 *       "id": "...", "targets": [...], "mode": "target",
 *       "confirm": 3, "limit": 24, "seed": "...",
 *       "answers": [{ "knowledgeId": "...", "qid": "...", "result": "correct", "text": "...", "at": "..." }],
 *       "createdAt": "...", "updatedAt": "...", "finished": false
 *     }
 *   }
 * }
 * ```
 *
 * 存的是**答案流水**而不是引擎内部状态 —— 内部状态由 `replay()` 重建，
 * 这样引擎升级后老会话也能用新逻辑继续算，不会出现「旧状态无法解释」。
 */

import { randomUUID } from 'node:crypto';
import type { Container } from '../../bootstrap/container.ts';
import { getKnowledgeMap, getQuestionBank } from '../../infrastructure/knowledge/curriculum.ts';
import { resolveKnowledgeIds } from '../../infrastructure/knowledge/id-aliases.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import {
  applyAnswer,
  buildDiagnosticGraph,
  createSession,
  nextItem,
  replay,
  summarize,
  type AnswerResult,
  type DiagnosticGraph,
  type DiagnosticSession,
  type DiagnosticSummary,
} from '../../engines/diagnosis-engine.ts';
import { judgeAnswerDeterministically } from '../../engines/judge-engine.ts';
import {
  applyDiagnosticTriState,
  readMasteryAggregate,
} from '../mastery/mastery-service.ts';

export const DIAGNOSIS_DIR = ['db', 'diagnosis'];

/**
 * 目标知识点无法解析（既不是原生 id，也没有别名映射）。
 *
 * 单独一个错误类型，让路由层能把它翻译成 400 而不是笼统的 500 ——
 * 「你传了一个我不认识的知识点」是调用方的问题，不是服务端崩了。
 */
export class UnresolvedKnowledgeError extends Error {
  readonly unresolved: string[];
  constructor(unresolved: string[]) {
    super(
      unresolved.length
        ? `知识点无法解析：${unresolved.join(', ')}`
        : '至少需要一个目标知识点'
    );
    this.name = 'UnresolvedKnowledgeError';
    this.unresolved = unresolved;
  }
}

export interface AdaptiveSessionRecord {
  id: string;
  targets: string[];
  mode: 'target' | 'screen';
  confirm: number;
  limit: number;
  seed: string;
  answers: Array<{
    knowledgeId: string;
    qid: string | null;
    result: AnswerResult;
    text?: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
  finished: boolean;
}

export interface DiagnosisStore {
  studentId: string;
  sessions: Record<string, AdaptiveSessionRecord>;
}

// ---------------------------------------------------------------- 图（缓存）

let graphCache: DiagnosticGraph | null = null;

/** 项目原生诊断图（知识点 + 题库），进程内缓存 */
export function getProjectDiagnosticGraph(): DiagnosticGraph {
  if (graphCache) return graphCache;
  const knowledgeMap = getKnowledgeMap();
  const bank = getQuestionBank();
  graphCache = buildDiagnosticGraph({
    knowledgePoints: Object.values(knowledgeMap).map((kp) => ({
      id: kp.id,
      name: kp.name,
      subject: kp.subject,
      prerequisites: kp.prerequisites ?? [],
    })),
    questions: bank.questions.map((q) => ({
      id: q.id,
      level: q.level,
      questionType: q.questionType,
      stem: q.stem,
      standardAnswer: q.standardAnswer,
      knowledgeIds: q.knowledgeIds ?? [],
      ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
    })),
  });
  return graphCache;
}

/** 仅测试用：清缓存 */
export function resetDiagnosticGraphCache(): void {
  graphCache = null;
}

// ---------------------------------------------------------------- 存储

async function readStore(
  container: Container,
  studentId: string
): Promise<DiagnosisStore> {
  const stored = await container.db.read<DiagnosisStore>([
    ...DIAGNOSIS_DIR,
    `${studentId}.json`,
  ]);
  return (
    stored ?? {
      studentId,
      sessions: {},
    }
  );
}

async function writeStore(
  container: Container,
  store: DiagnosisStore
): Promise<void> {
  await container.db.write([...DIAGNOSIS_DIR, `${store.studentId}.json`], store);
}

// ---------------------------------------------------------------- 会话

export interface StartSessionParams {
  studentId: string;
  /** 目标知识点（可含外部 id，服务端解析成原生 id） */
  knowledgeIds: string[];
  mode?: 'target' | 'screen';
  confirm?: number;
  limit?: number;
  seed?: string;
}

export interface AdaptiveItem {
  knowledgeId: string;
  question: {
    id: string;
    stem: string;
    level: string;
    questionType: string;
    /**
     * 选择题选项（可选）。
     *
     * 刻意**不含 standardAnswer**：答案只在服务端判题，
     * 下发到前端等于把答案放在题面上。
     */
    options?: string[];
  };
  attempt: number;
}

export interface AdaptiveSessionView {
  sessionId: string;
  item: AdaptiveItem | null;
  answered: number;
  limit: number;
  finished: boolean;
  summary?: DiagnosticSummary;
}

/** 创建一个诊断会话并返回第一题 */
export async function startAdaptiveSession(
  container: Container,
  params: StartSessionParams
): Promise<AdaptiveSessionView> {
  const graph = getProjectDiagnosticGraph();

  // 外部 id → 原生 id（不猜：无映射就报错，而不是静默少一个目标）
  const { resolved, unresolved } = resolveKnowledgeIds(params.knowledgeIds);
  if (unresolved.length > 0) {
    throw new UnresolvedKnowledgeError(unresolved);
  }
  if (resolved.length === 0) {
    throw new UnresolvedKnowledgeError([]);
  }

  const seed = params.seed ?? randomUUID();
  const record: AdaptiveSessionRecord = {
    id: `ads_${randomUUID()}`,
    targets: resolved,
    mode: params.mode === 'screen' ? 'screen' : 'target',
    confirm: params.confirm ?? 3,
    limit: params.limit ?? 24,
    seed,
    answers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finished: false,
  };

  await container.db.withExclusive(`diagnosis:${params.studentId}`, async () => {
    const store = await readStore(container, params.studentId);
    store.sessions[record.id] = record;
    await writeStore(container, store);
  });

  return viewSession(graph, record);
}

function toSession(
  graph: DiagnosticGraph,
  record: AdaptiveSessionRecord
): DiagnosticSession {
  return replay(graph, record.targets, record.answers, {
    mode: record.mode,
    confirm: record.confirm,
    limit: record.limit,
    seed: record.seed,
  });
}

function viewSession(
  graph: DiagnosticGraph,
  record: AdaptiveSessionRecord
): AdaptiveSessionView {
  const session = toSession(graph, record);
  const item = record.finished ? null : nextItem(graph, session);
  return {
    sessionId: record.id,
    item: item
      ? {
          knowledgeId: item.knowledgeId,
          question: {
            id: item.question.id,
            stem: item.question.stem,
            level: item.question.level,
            questionType: item.question.questionType,
            ...(item.question.options && item.question.options.length > 0
              ? { options: item.question.options }
              : {}),
          },
          attempt: item.attempt,
        }
      : null,
    answered: record.answers.length,
    limit: record.limit,
    finished: record.finished,
    ...(record.finished ? { summary: summarize(graph, session) } : {}),
  };
}

export interface SubmitAnswerParams {
  studentId: string;
  sessionId: string;
  knowledgeId: string;
  /** 学生答案原文 */
  answer: string;
  /** 指定题目 id（可选，用于钉题重放） */
  qid?: string;
}

export interface SubmitAnswerResult extends AdaptiveSessionView {
  judged: { isCorrect: boolean; feedback?: string; errorType?: string };
}

/**
 * 提交一次作答。
 *
 * 判题走**确定性引擎**（judge-engine）：
 * 客观题 / 数值题 / 规范表达式能 100% 确定，不消耗 AI 成本；
 * 判不了时返回 `isCorrect: false` 且要求 AI 复判（本服务暂不做 AI 复判，
 * 交由调用方补充），不会把「判不了」当成「答错」写入掌握度。
 */
export async function submitAdaptiveAnswer(
  container: Container,
  params: SubmitAnswerParams
): Promise<SubmitAnswerResult> {
  const graph = getProjectDiagnosticGraph();

  return container.db.withExclusive(
    `diagnosis:${params.studentId}`,
    async () => {
      const store = await readStore(container, params.studentId);
      const record = store.sessions[params.sessionId];
      if (!record) throw new Error('诊断会话不存在');
      if (record.finished) throw new Error('诊断会话已结束');

      const session = toSession(graph, record);
      const item = nextItem(graph, session);
      const qid = params.qid ?? item?.question.id ?? null;

      let question: { stem: string; standardAnswer: string } | null = null;
      for (const kid of [params.knowledgeId, item?.knowledgeId]) {
        if (!kid) continue;
        const q = (graph.bank[kid] ?? []).find((x) => x.id === qid);
        if (q) {
          question = { stem: q.stem, standardAnswer: q.standardAnswer };
          break;
        }
      }
      if (!question) throw new Error('题目不存在或与知识点不匹配');

      const judged = judgeAnswerDeterministically(
        question.stem,
        question.standardAnswer,
        params.answer
      );

      /**
       * 判不了 → 记 skip（不作为失败证据），不推进掌握度。
       *
       * 理由：把「无法判定」当成「答错」会误伤学生，
       * 也和引擎里 skip 的语义（没作答 / 不确定）保持一致。
       */
      const result: AnswerResult = judged.isDeterministic
        ? judged.isCorrect
          ? 'correct'
          : 'wrong'
        : 'skip';

      record.answers.push({
        knowledgeId: params.knowledgeId,
        qid,
        result,
        ...(params.answer ? { text: params.answer } : {}),
        at: new Date().toISOString(),
      });
      record.updatedAt = new Date().toISOString();

      const nextSession = applyAnswer(graph, session, params.knowledgeId, result, {
        ...(params.answer ? { text: params.answer } : {}),
        ...(qid ? { qid } : {}),
      });
      const next = nextItem(graph, nextSession);
      if (!next) {
        record.finished = true;
      }

      await writeStore(container, store);

      return {
        ...viewSession(graph, record),
        judged: {
          isCorrect: result === 'correct',
          ...(judged.feedback ? { feedback: judged.feedback } : {}),
          ...(judged.errorType ? { errorType: judged.errorType } : {}),
        },
      };
    }
  );
}

/**
 * 结束会话：把三态结论写进掌握度。
 *
 * 映射：
 * - `mastered` → 初步掌握（一次诊断只到「初步」，掌握/稳定掌握仍需变式与延迟复测）
 * - `shaky` → 学习中（会但不稳，不能算掌握）
 * - `weak` → 待学习
 *
 * 只写**有结论**的点；未测的点不动。
 */
export async function finalizeAdaptiveSession(
  container: Container,
  studentId: string,
  sessionId: string
): Promise<DiagnosticSummary> {
  const graph = getProjectDiagnosticGraph();
  const store = await readStore(container, studentId);
  const record = store.sessions[sessionId];
  if (!record) throw new Error('诊断会话不存在');

  const session = toSession(graph, record);
  const summary = summarize(graph, session);
  const knowledgeMap = getKnowledgeMap();

  const TRI_STATE_LABEL: Record<'mastered' | 'shaky' | 'weak', string> = {
    mastered: '连续答对确认掌握',
    shaky: '曾答错、确认题答对（会但不稳）',
    weak: '确认题未通过（薄弱）',
  };

  for (const [ids, status] of [
    [summary.mastered, 'mastered'],
    [summary.shaky, 'shaky'],
    [summary.weak, 'weak'],
  ] as Array<[string[], 'mastered' | 'shaky' | 'weak']>) {
    for (const kid of ids) {
      const kp = knowledgeMap[kid];
      if (!kp) continue;
      try {
        await applyDiagnosticTriState(container, {
          studentId,
          knowledgeId: kid,
          status,
          evidenceSummary: `自适应诊断：${TRI_STATE_LABEL[status]}`,
          subject: kp.subject,
        });
      } catch (err) {
        logger.error('diagnosis.mastery_write_failed', {
          studentId,
          knowledgeId: kid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  record.finished = true;
  record.updatedAt = new Date().toISOString();
  await container.db.withExclusive(`diagnosis:${studentId}`, async () => {
    const s = await readStore(container, studentId);
    s.sessions[sessionId] = record;
    await writeStore(container, s);
  });

  return summary;
}

/** 读取学生的诊断会话列表 */
export async function listAdaptiveSessions(
  container: Container,
  studentId: string
): Promise<AdaptiveSessionRecord[]> {
  const store = await readStore(container, studentId);
  return Object.values(store.sessions).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

/** 读取单个会话的当前视图 */
export async function getAdaptiveSession(
  container: Container,
  studentId: string,
  sessionId: string
): Promise<AdaptiveSessionView | null> {
  const store = await readStore(container, studentId);
  const record = store.sessions[sessionId];
  if (!record) return null;
  return viewSession(getProjectDiagnosticGraph(), record);
}

/** 供掌握度报告使用：读取某学生的诊断会话汇总 */
export async function readMasteryAggregateForReport(
  container: Container,
  studentId: string
) {
  return readMasteryAggregate(container, studentId);
}
