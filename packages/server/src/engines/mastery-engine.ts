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
  /** 本次作答使用了多少提示（0 = 完全独立） */
  hintsUsed?: number;
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

  /**
   * 置信度分级（规格 §模块01 §2：「置信度：确定 / 较可能 / 待验证」）。
   *
   * 此前无论对错都硬编码 `confidence: '确定'` ——
   * 于是「微测即时提升置信度」只是把置信度**拉满**，
   * 完全没有区分对待不同强度的证据。
   *
   * 现在的分级规则（按证据强度从弱到强）：
   * - 作答错误 → 证据不足，回落到 `待验证`
   *   （错题本身就是「待验证」假设的来源，不是确认）
   * - 作答正确但用了提示 → `较可能`
   *   （有提示的答对不足以独立确认掌握）
   * - 作答正确且完全独立（无提示）→ `确定`
   *
   * 注意：置信度**只升不降到高于证据强度的档位**，
   * 且不会把已有的 `确定` 降级 —— 因为已经独立验证过的知识点
   * 不该因为一次带提示的练习就失去「确定」判定。
   */
  const gradedConfidence = ((): MasteryRecord['confidence'] => {
    if (!input.isCorrect) return '待验证';
    if ((input.hintsUsed ?? 0) > 0) return '较可能';
    return '确定';
  })();

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
        // 作答错误 = 假设未被证实，置信度回落到「待验证」
        confidence: gradedConfidence,
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
      /**
       * 置信度按证据强度分级（见上方 gradedConfidence 说明）。
       *
       * 但**不会把已有的「确定」降级** ——
       * 已经独立验证过的知识点，不该因为一次带提示的练习就失去「确定」判定。
       */
      confidence:
        current.confidence === '确定' ? '确定' : gradedConfidence,
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

/**
 * 诊断失分驱动的掌握度变更。
 *
 * 与 `evaluateMasteryTransition`（练习路径）的区别：
 * 练习是一次「作答」，有对错；诊断是**考试失分证据**，
 * 语义上等价于一次失败作答，但**不计入 practiceTotal** ——
 * 报告页第一层的「无提示独立作答率」只应统计真实练习。
 *
 * 规格依据：
 * - TC-01：「新增对应 ErrorRecord 并**更新相关知识点 MasteryRecord** 与 7 天排序」
 * - §模块01 §2：诊断结论必须带证据与验证方式 —— 证据写入 evidenceLogs
 * - §模块06 第二层：「已验证修复知识点数」—— 诊断失分不得计入修复
 *
 * 状态规则：
 * - `掌握` / `稳定掌握` → 回退到 `学习中`（有新失分证据）
 * - 其余状态 → 回退到 `待学习`
 * - 连续失分累积（consecutiveErrors）用于降阶保护
 * - lostScoreEvidence 累加失分（按 0.7 折扣，与前端历史逻辑一致）
 */
export interface DiagnosisMasteryInput {
  current: MasteryRecord;
  /** 诊断条目的失分证据 */
  scoreLost: number;
  /** 证据摘要（写入 evidenceLogs 与迁移事件 trigger） */
  evidenceSummary: string;
  /** AI 判定的置信度 —— 直接来自诊断结论，不做硬编码 */
  confidence: MasteryRecord['confidence'];
  now?: number;
}

export interface DiagnosisMasteryResult {
  record: MasteryRecord;
  changed: boolean;
  fromState: MasteryState;
  toState: MasteryState;
}

export function applyDiagnosisMasteryLoss(
  input: DiagnosisMasteryInput
): DiagnosisMasteryResult {
  const now = new Date(input.now ?? Date.now()).toISOString();
  const current = input.current;

  /**
   * 诊断失分 = 一次失败证据。
   *
   * 状态回退规则（规格 §3.2「状态回退规则」）：
   * 若后续测试再次失败或连续失误 ≥ 2 次，状态自动回退至 `学习中` 或 `待学习`。
   */
  const nextState: MasteryState =
    current.state === '稳定掌握' || current.state === '掌握'
      ? '学习中'
      : '待学习';

  const consecutiveErrors = current.consecutiveErrors + 1;

  const record: MasteryRecord = {
    ...current,
    state: nextState,
    // 置信度来自诊断结论本身（AI 给出的确定/较可能/待验证），不硬编码
    confidence: input.confidence,
    lostScoreEvidence: Number(
      (current.lostScoreEvidence + input.scoreLost * 0.7).toFixed(1)
    ),
    consecutiveErrors,
    /**
     * 诊断失分证明「变式/迁移/延迟复测」并未独立通过 ——
     * 否则报告页会把「已验证修复」算到一个其实还在错的知识点上。
     */
    variantPassed: false,
    delayedRetestPassed: false,
    evidenceLogs: [input.evidenceSummary, ...current.evidenceLogs].slice(0, 8),
    updatedAt: now,
  };

  return {
    record,
    changed: nextState !== current.state,
    fromState: current.state,
    toState: nextState,
  };
}

/**
 * 三态自适应诊断结论 → 掌握度状态。
 *
 * 为什么单独一条规则，而不是复用 `evaluateMasteryTransition`：
 * 练习路径的输入是「一次作答的对错」，而三态诊断的输入是
 * **一段会话的结论**（掌握 / 不稳 / 薄弱）。
 *
 * 两者的语义差别会直接导致误判：
 * - `shaky`（答错过、确认题答对）如果按「答对」处理，
 *   会被算成「初步掌握」——但这个学生是**不稳**的，
 *   不该进已掌握名单；
 * - `weak`（确认题也没过）如果按「答错」处理，
 *   只会掉到「学习中」——但确认题都错了，应该直接进「待学习」。
 *
 * 状态规则：
 * - `mastered` → **初步掌握**（一次诊断只到「初步」；
 *   「掌握 / 稳定掌握」仍需变式训练与延迟复测来确认，
 *   否则报告页会把「已验证修复」算到没验证过的点上）；
 * - `shaky` → **学习中**（会但不稳，必须继续练）；
 * - `weak` → **待学习**（连确认题都不过，先补先修）。
 */
export interface DiagnosticTriStateInput {
  current: MasteryRecord;
  status: 'mastered' | 'shaky' | 'weak';
  evidenceSummary: string;
  subject?: string;
  now?: number;
}

export function evaluateDiagnosticTriState(
  input: DiagnosticTriStateInput
): MasteryTransitionResult {
  const nowMs = input.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const current = input.current;

  const nextState: MasteryState =
    input.status === 'mastered'
      ? '初步掌握'
      : input.status === 'shaky'
        ? '学习中'
        : '待学习';

  const confidence: MasteryRecord['confidence'] =
    input.status === 'mastered'
      ? '确定'
      : input.status === 'shaky'
        ? '较可能'
        : '待验证';

  const record: MasteryRecord = {
    ...current,
    state: nextState,
    confidence:
      current.confidence === '确定' && nextState === '初步掌握'
        ? '确定'
        : confidence,
    consecutiveErrors: input.status === 'mastered' ? 0 : current.consecutiveErrors + 1,
    evidenceLogs: [input.evidenceSummary, ...current.evidenceLogs].slice(0, 8),
    updatedAt: now,
  };

  return {
    record,
    changed: nextState !== current.state,
    fromState: current.state,
    toState: nextState,
  };
}

export type { MasteryRecord, MasteryState, PracticeMode, MasteryTransitionEvent };
