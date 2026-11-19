/**
 * 掌握度持久化服务（服务端唯一写入口）。
 *
 * 背景：
 * 掌握度的**状态迁移只能由服务端产生并落库**，前端只消费变更结果
 * （见 packages/contracts/src/domain/index.ts 的 MASTERY_ORDER 注释）。
 *
 * 此前的问题：
 * - 练习路径（POST /students/:id/mastery/:knowledgeId/attempt）在
 *   `mastery.routes.ts` 内联地读写 `db/mastery/{studentId}.json`；
 * - 诊断路径（POST /exams/:examId/papers）**完全不写** MasteryRecord ——
 *   失分证据只留在前端内存，刷新即丢，导致「诊断 → 提分规划」闭环在服务端断开。
 *
 * 本模块把「读聚合 → 判迁移 → 写聚合 → 记事件」抽成唯一入口，
 * 两条路径共用，避免再出现「一条路径写、另一条路径不写」的偏差。
 */
import { randomUUID } from 'node:crypto';
import type {
  MasteryRecord,
  MasteryTransitionEvent,
} from '@daydayup/contracts';
import type { Container } from '../../bootstrap/container.ts';
import {
  evaluateMasteryTransition,
  buildTransitionEvent,
  applyDiagnosisMasteryLoss,
  evaluateDiagnosticTriState,
} from '../../engines/mastery-engine.ts';

export const MASTERY_DIR = ['db', 'mastery'];

export interface MasteryAggregate {
  studentId: string;
  records: Record<string, MasteryRecord>;
  history: MasteryTransitionEvent[];
  lastComputedAt: string;
}

/** 历史上限，避免文件无限增长 */
const HISTORY_LIMIT = 200;

export async function readMasteryAggregate(
  container: Container,
  studentId: string
): Promise<MasteryAggregate> {
  const stored = await container.db.read<MasteryAggregate>([
    ...MASTERY_DIR,
    `${studentId}.json`,
  ]);
  return (
    stored ?? {
      studentId,
      records: {},
      history: [],
      lastComputedAt: new Date().toISOString(),
    }
  );
}

export async function writeMasteryAggregate(
  container: Container,
  aggregate: MasteryAggregate
): Promise<void> {
  aggregate.lastComputedAt = new Date().toISOString();
  await container.db.write(
    [...MASTERY_DIR, `${aggregate.studentId}.json`],
    aggregate
  );
}

/** 空白记录（知识点首次出现时的初值） */
export function createEmptyMasteryRecord(
  knowledgeId: string
): MasteryRecord {
  return {
    knowledgeId,
    state: '未诊断',
    confidence: '待验证',
    lostScoreEvidence: 0,
    recoveryProbability: 0.5,
    evidenceLogs: [],
    consecutiveErrors: 0,
    practiceCorrect: 0,
    practiceTotal: 0,
    variantPassed: false,
    delayedRetestPassed: false,
    updatedAt: new Date().toISOString(),
  };
}

export interface ApplyMasteryTransitionParams {
  studentId: string;
  knowledgeId: string;
  mode: MasteryRecord extends never ? never : string;
  isCorrect: boolean;
  evidenceSummary: string;
  subject: string;
  /** 本次作答使用了多少提示（0 = 完全独立）—— 参与置信度分级 */
  hintsUsed?: number;
  /** 触发描述，写入迁移事件的 trigger */
  triggerPrefix?: string;
  now?: number;
}

export interface ApplyMasteryTransitionResult {
  record: MasteryRecord;
  changed: boolean;
  fromState: MasteryRecord['state'];
  toState: MasteryRecord['state'];
  transitionEventId?: string;
}

/**
 * 应用一次掌握度状态迁移并落库。
 *
 * **整个读-判-写过程在按学生维度的排他锁内完成**：
 * 否则并发请求会各自读到同一个旧聚合、各自写回自己的版本，
 * 后写者覆盖先写者 —— 知识点记录被静默丢弃。
 *
 * 实测：5 个并发作答全部返回 200，但聚合里只剩 1 条记录。
 */
export async function applyMasteryTransition(
  container: Container,
  params: ApplyMasteryTransitionParams
): Promise<ApplyMasteryTransitionResult> {
  const { studentId, knowledgeId } = params;

  return container.db.withExclusive(`mastery:${studentId}`, async () => {
    const aggregate = await readMasteryAggregate(container, studentId);
    const current =
      aggregate.records[knowledgeId] ??
      createEmptyMasteryRecord(knowledgeId);

    const result = evaluateMasteryTransition({
      current,
      mode: params.mode as never,
      isCorrect: params.isCorrect,
      evidenceSummary: params.evidenceSummary,
      subject: params.subject,
      hintsUsed: params.hintsUsed,
      now: params.now,
    });

    aggregate.records[knowledgeId] = result.record;

    let transitionEventId: string | undefined;
    if (result.changed) {
      const event = buildTransitionEvent({
        id: `mte_${randomUUID()}`,
        knowledgeId,
        subject: params.subject,
        fromState: result.fromState,
        toState: result.toState,
        trigger: params.triggerPrefix
          ? `${params.triggerPrefix}: ${params.evidenceSummary}`.slice(0, 200)
          : `${params.mode}: ${params.evidenceSummary}`.slice(0, 200),
        now: params.now,
      });
      transitionEventId = event.id;
      aggregate.history.unshift(event);
      aggregate.history = aggregate.history.slice(0, HISTORY_LIMIT);
    }

    await writeMasteryAggregate(container, aggregate);
    return { ...result, transitionEventId };
  });
}

export interface ApplyDiagnosticTriStateParams {
  studentId: string;
  knowledgeId: string;
  status: 'mastered' | 'shaky' | 'weak';
  evidenceSummary: string;
  subject: string;
  now?: number;
}

/**
 * 应用**三态自适应诊断**的结论并落库。
 *
 * 与 `applyMasteryTransition`（一次作答对错）的区别：
 * 这里的输入是一段诊断会话的结论（掌握 / 不稳 / 薄弱），
 * 走 `evaluateDiagnosticTriState` 的专属规则 ——
 * 掌握只到「初步掌握」，不稳留在「学习中」，薄弱直接「待学习」。
 */
export async function applyDiagnosticTriState(
  container: Container,
  params: ApplyDiagnosticTriStateParams
): Promise<ApplyMasteryTransitionResult> {
  const { studentId, knowledgeId } = params;

  return container.db.withExclusive(`mastery:${studentId}`, async () => {
    const aggregate = await readMasteryAggregate(container, studentId);
    const current =
      aggregate.records[knowledgeId] ??
      createEmptyMasteryRecord(knowledgeId);

    const result = evaluateDiagnosticTriState({
      current,
      status: params.status,
      evidenceSummary: params.evidenceSummary,
      subject: params.subject,
      now: params.now,
    });

    aggregate.records[knowledgeId] = result.record;

    let transitionEventId: string | undefined;
    if (result.changed) {
      const event = buildTransitionEvent({
        id: `mte_${randomUUID()}`,
        knowledgeId,
        subject: params.subject,
        fromState: result.fromState,
        toState: result.toState,
        trigger: `自适应诊断: ${params.evidenceSummary}`.slice(0, 200),
        now: params.now,
      });
      transitionEventId = event.id;
      aggregate.history.unshift(event);
      aggregate.history = aggregate.history.slice(0, HISTORY_LIMIT);
    }

    await writeMasteryAggregate(container, aggregate);
    return { ...result, transitionEventId };
  });
}

export interface ApplyDiagnosisMasteryParams {
  studentId: string;
  knowledgeId: string;
  scoreLost: number;
  evidenceSummary: string;
  subject: string;
  confidence: MasteryRecord['confidence'];
  now?: number;
}

/**
 * 应用一次**诊断失分**驱动的掌握度变更并落库。
 *
 * 与练习路径的差别：
 * - 诊断失分等价于一次失败证据，但要回退状态而不是推进状态；
 * - **不计入 practiceTotal** —— 报告页第一层的「无提示独立作答率」
 *   只应统计真实练习，诊断失分不是练习。
 *
 * 必须在排他锁内完成（与练习路径同一把按学生维度的锁）。
 */
export async function applyDiagnosisMastery(
  container: Container,
  params: ApplyDiagnosisMasteryParams
): Promise<ApplyMasteryTransitionResult> {
  const { studentId, knowledgeId } = params;

  return container.db.withExclusive(`mastery:${studentId}`, async () => {
    const aggregate = await readMasteryAggregate(container, studentId);
    const current =
      aggregate.records[knowledgeId] ??
      createEmptyMasteryRecord(knowledgeId);

    const result = applyDiagnosisMasteryLoss({
      current,
      scoreLost: params.scoreLost,
      evidenceSummary: params.evidenceSummary,
      confidence: params.confidence,
      now: params.now,
    });

    aggregate.records[knowledgeId] = result.record;

    let transitionEventId: string | undefined;
    if (result.changed) {
      const event = buildTransitionEvent({
        id: `mte_${randomUUID()}`,
        knowledgeId,
        subject: params.subject,
        fromState: result.fromState,
        toState: result.toState,
        trigger: params.evidenceSummary.slice(0, 200),
        now: params.now,
      });
      transitionEventId = event.id;
      aggregate.history.unshift(event);
      aggregate.history = aggregate.history.slice(0, HISTORY_LIMIT);
    }

    await writeMasteryAggregate(container, aggregate);
    return { ...result, transitionEventId };
  });
}
