/**
 * MasteryEngine —— 掌握度状态机（服务端权威）。
 *
 * 迁移自 web 前端 src/engine/planner.ts 的 evaluateMasteryTransition。
 * **逻辑逐行等价**，仅位置改变。
 *
 * 关键设计：状态迁移只能由服务端产生并落库，前端只消费变更结果。
 * 学生无法通过篡改前端伪造「已稳定掌握」。
 */
import type {
  MasteryRecord,
  MasteryState,
  PracticeMode,
  MasteryTransitionEvent,
} from '@daydayup/contracts';
import { RETEST_INTERVAL_DAYS, getDelayedRetestStatus } from './planning-engine.ts';

export const MASTERY_ENGINE_VERSION = 'mastery.v1';

export interface MasteryTransitionInput {
  current: MasteryRecord;
  mode: PracticeMode;
  isCorrect: boolean;
  evidenceSummary: string;
  subject?: string;
  now?: number;
}

export interface MasteryTransitionResult {
  record: MasteryRecord;
  /** 是否发生状态变更（用于生成迁移事件） */
  changed: boolean;
  fromState: MasteryState;
  toState: MasteryState;
}

export function evaluateMasteryTransition(
  input: MasteryTransitionInput
): MasteryTransitionResult {
  const nowMs = input.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const current = input.current;

  const nextLogs = [input.evidenceSummary, ...current.evidenceLogs].slice(0, 8);
  const practiceTotal = current.practiceTotal + 1;
  const practiceCorrect = current.practiceCorrect + (input.isCorrect ? 1 : 0);

  if (!input.isCorrect) {
    const consecutiveErrors = current.consecutiveErrors + 1;
    const nextState: MasteryState =
      consecutiveErrors >= 2
        ? '待学习'
        : current.state === '未诊断'
          ? '待学习'
          : '学习中';
    return {
      record: {
        ...current,
        state: nextState,
        confidence: '确定',
        consecutiveErrors,
        practiceCorrect,
        practiceTotal,
        variantPassed:
          input.mode === '变式训练' ? false : current.variantPassed,
        delayedRetestPassed:
          input.mode === '延迟复测' ? false : current.delayedRetestPassed,
        evidenceLogs: nextLogs,
        updatedAt: now,
      },
      changed: nextState !== current.state,
      fromState: current.state,
      toState: nextState,
    };
  }

  let nextState: MasteryState = current.state;
  let variantPassed = current.variantPassed;
  let delayedRetestPassed = current.delayedRetestPassed;
  let lostScoreEvidence = current.lostScoreEvidence;
  let preliminaryMasteredAt = current.preliminaryMasteredAt;
  let nextRetestAvailableAt = current.nextRetestAvailableAt;

  if (
    !preliminaryMasteredAt &&
    (input.mode === '基础练习' ||
      input.mode === '变式训练' ||
      input.mode === '迁移应用')
  ) {
    preliminaryMasteredAt = now;
    nextRetestAvailableAt = new Date(
      nowMs + RETEST_INTERVAL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  if (input.mode === '诊断微测' || input.mode === '基础练习') {
    if (
      current.state === '未诊断' ||
      current.state === '待学习' ||
      current.state === '学习中'
    ) {
      nextState = '初步掌握';
    }
    lostScoreEvidence = Math.max(1, Number((lostScoreEvidence * 0.75).toFixed(1)));
  } else if (input.mode === '变式训练' || input.mode === '迁移应用') {
    variantPassed = true;
    const retestStatus = getDelayedRetestStatus(
      { ...current, state: '掌握', nextRetestAvailableAt },
      nowMs
    );
    nextState = current.delayedRetestPassed && retestStatus.unlocked ? '稳定掌握' : '掌握';
    lostScoreEvidence = Math.max(0.5, Number((lostScoreEvidence * 0.45).toFixed(1)));
  } else if (input.mode === '延迟复测') {
    const retestStatus = getDelayedRetestStatus(current, nowMs);
    if (retestStatus.unlocked) {
      delayedRetestPassed = true;
      nextState = '稳定掌握';
      lostScoreEvidence = 0;
    } else {
      variantPassed = true;
      nextState = '掌握';
    }
  }

  return {
    record: {
      ...current,
      state: nextState,
      confidence: '确定',
      consecutiveErrors: 0,
      practiceCorrect,
      practiceTotal,
      variantPassed,
      delayedRetestPassed,
      lostScoreEvidence,
      preliminaryMasteredAt,
      nextRetestAvailableAt,
      evidenceLogs: nextLogs,
      updatedAt: now,
    },
    changed: nextState !== current.state,
    fromState: current.state,
    toState: nextState,
  };
}

/** 构造迁移事件（用于审计与报告） */
export function buildTransitionEvent(params: {
  id: string;
  knowledgeId: string;
  subject: string;
  fromState: MasteryState;
  toState: MasteryState;
  trigger: string;
  now?: number;
}): MasteryTransitionEvent {
  return {
    id: params.id,
    knowledgeId: params.knowledgeId,
    subject: params.subject as MasteryTransitionEvent['subject'],
    fromState: params.fromState,
    toState: params.toState,
    trigger: params.trigger,
    timestamp: new Date(params.now ?? Date.now()).toISOString(),
  };
}

export type { MasteryRecord, MasteryState, PracticeMode, MasteryTransitionEvent };
