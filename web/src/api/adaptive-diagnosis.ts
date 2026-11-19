/**
 * 三态自适应诊断取数层。
 *
 * 与「试卷诊断」（POST /exams/:id/diagnosis）不同，这是一条**交互式微测**链路：
 * 前端出题 → 学生作答 → 服务端判题 → 连对/错判三态 → finalize 写回掌握度。
 *
 * 三条硬约束（前端必须遵守，否则结论不可信）：
 *
 * 1. **判题只在服务端**。前端不下发 standardAnswer，也不本地算对错；
 *    作答提交后由 `judge-engine` 判定，前端只展示 `judged`。
 * 2. **掌握度状态迁移只在服务端**。finalize 之后服务端才写 MasteryRecord，
 *    前端只负责把结论展示出来。
 * 3. **题目不含答案**。会话视图里的 question 只有 stem / options / level，
 *    拿不到答案就改不了结论。
 */
import { api } from './client.ts';

/** 会话中的当前题目（不含答案） */
export interface AdaptiveQuestionView {
  id: string;
  stem: string;
  level: string;
  questionType: string;
  /** 选择题选项；缺省表示填空/解答题，需要文本输入 */
  options?: string[];
}

/** 当前待答项 */
export interface AdaptiveItem {
  knowledgeId: string;
  question: AdaptiveQuestionView;
  attempt: number;
}

/** 三态结论汇总 */
export interface AdaptiveSummary {
  /** 掌握（连续答对确认） */
  mastered: string[];
  /** 不稳（错过又答对） */
  shaky: string[];
  /** 薄弱（确认题未通过） */
  weak: string[];
  /** 未测 */
  untested: string[];
  /** 建议回退补强的先修点 */
  backtrack: Array<{
    knowledgeId: string;
    name: string;
    dependedBy: number;
  }>;
  answered: number;
  limit: number;
}

/** 会话视图 */
export interface AdaptiveSessionView {
  sessionId: string;
  item: AdaptiveItem | null;
  answered: number;
  limit: number;
  finished: boolean;
  summary?: AdaptiveSummary;
}

/** 提交作答后的返回（多一段判题结果） */
export interface AdaptiveAnswerResult extends AdaptiveSessionView {
  judged: {
    isCorrect: boolean;
    feedback?: string;
    errorType?: string;
  };
}

export interface StartAdaptiveParams {
  /** 目标知识点（可含外部 id，服务端负责解析） */
  knowledgeIds: string[];
  /** target = 只测指定点；screen = 连带先修一起测 */
  mode?: 'target' | 'screen';
  /** 判定「掌握」所需的连续答对题数 */
  confirm?: number;
  /** 题目上限 */
  limit?: number;
  /** 固定随机种子（同一 seed 出同一批题，便于复现） */
  seed?: string;
}

/** 开始一次自适应诊断，返回第一题 */
export async function startAdaptiveDiagnosis(
  studentId: string,
  params: StartAdaptiveParams
): Promise<AdaptiveSessionView> {
  return api.post<AdaptiveSessionView>(
    `/api/v1/students/${studentId}/diagnosis/adaptive/start`,
    params
  );
}

/**
 * 提交一次作答。
 *
 * `answer` 传**选项字母**（如 'B'）或填空原文；服务端按确定性引擎判定，
 * 判不了记 skip（不计失败），不推进掌握度。
 */
export async function submitAdaptiveAnswer(
  studentId: string,
  payload: {
    sessionId: string;
    knowledgeId: string;
    answer: string;
    /** 指定题目 id（可选，用于钉题重放） */
    qid?: string;
  }
): Promise<AdaptiveAnswerResult> {
  return api.post<AdaptiveAnswerResult>(
    `/api/v1/students/${studentId}/diagnosis/adaptive/answer`,
    payload
  );
}

/** 结束会话：把三态结论写回服务端掌握度 */
export async function finalizeAdaptiveDiagnosis(
  studentId: string,
  sessionId: string
): Promise<AdaptiveSummary> {
  return api.post<AdaptiveSummary>(
    `/api/v1/students/${studentId}/diagnosis/adaptive/${sessionId}/finalize`
  );
}

/** 读取单个会话当前状态（刷新页面后恢复进度） */
export async function fetchAdaptiveSession(
  studentId: string,
  sessionId: string
): Promise<AdaptiveSessionView> {
  return api.get<AdaptiveSessionView>(
    `/api/v1/students/${studentId}/diagnosis/adaptive/${sessionId}`
  );
}

/** 会话记录（列表接口返回的是流水记录，不是会话视图） */
export interface AdaptiveSessionRecord {
  id: string;
  /** 已解析的目标知识点 id */
  targets: string[];
  mode: 'target' | 'screen';
  confirm: number;
  limit: number;
  seed: string;
  answers: Array<{
    knowledgeId: string;
    qid: string | null;
    result: 'correct' | 'wrong' | 'skip';
    text?: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
  finished: boolean;
}

/** 会话列表 */
export async function fetchAdaptiveSessions(
  studentId: string
): Promise<{ sessions: AdaptiveSessionRecord[] }> {
  return api.get<{ sessions: AdaptiveSessionRecord[] }>(
    `/api/v1/students/${studentId}/diagnosis/adaptive/sessions`
  );
}
