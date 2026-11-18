/**
 * 先修链 API 客户端。
 *
 * 提供「目标知识点 → 阻断根因 → 学习路径」的传递性分析。
 * 这是 cn-math-taxonomy 的核心能力（答错初中题一路回溯到小学），
 * 在 daydayup 里由服务端 `PrerequisiteEngine` 实现，前端只消费结果。
 */
import { api } from './client.ts';

export type MasteryState =
  | '未诊断'
  | '待学习'
  | '学习中'
  | '初步掌握'
  | '掌握'
  | '稳定掌握';

export interface PrerequisiteNode {
  knowledgeId: string;
  name: string;
  subject: string;
  chapter: string;
  domain: string;
  /** 到目标点的距离（0 = 目标本身） */
  distance: number;
  state: MasteryState;
  /** 是否存在 MasteryRecord（false = 从未诊断） */
  diagnosed: boolean;
  blocking: boolean;
  prerequisites: string[];
}

export interface RootCause {
  knowledgeId: string;
  name: string;
  subject: string;
  state: MasteryState;
  /** 沿先修链到目标的路径（含两端） */
  path: string[];
  depth: number;
}

export interface BlockingChain {
  targetId: string;
  targetName: string;
  rootCauses: RootCause[];
  /** 从根因到目标的完整学习路径（按拓扑序，先修在前） */
  learningPath: PrerequisiteNode[];
  hasBlocking: boolean;
}

export interface PrerequisiteChainResponse {
  version: string;
  knowledgeId: string;
  chain: BlockingChain;
}

export interface BlockingSummary {
  blockedTargets: Array<{
    knowledgeId: string;
    name: string;
    subject: string;
    rootCauseId: string;
    rootCauseName: string;
    rootCauseState: MasteryState;
    depth: number;
  }>;
  rootCauses: Array<{
    knowledgeId: string;
    name: string;
    subject: string;
    state: MasteryState;
    /** 阻断了多少个目标 */
    blockingCount: number;
  }>;
  stats: {
    totalKnowledgePoints: number;
    diagnosedCount: number;
    blockedTargetCount: number;
    rootCauseCount: number;
    /** 最深的一条阻断链 */
    maxDepth: number;
  };
}

/**
 * 取得某知识点的先修链与阻断根因。
 *
 * @param studentId 学生 ID
 * @param knowledgeId 目标知识点 ID
 */
export async function fetchPrerequisiteChain(
  studentId: string,
  knowledgeId: string
): Promise<PrerequisiteChainResponse> {
  return api.get<PrerequisiteChainResponse>(
    `/api/v1/students/${studentId}/prerequisite-chain?knowledgeId=${encodeURIComponent(knowledgeId)}`
  );
}

/**
 * 取得全量知识点的阻断概况。
 *
 * @param studentId 学生 ID
 * @param limit 只分析前 N 个目标（可选，用于大资产下的性能控制）
 */
export async function fetchBlockingSummary(
  studentId: string,
  limit?: number
): Promise<BlockingSummary> {
  const suffix = limit !== undefined ? `?limit=${limit}` : '';
  const res = await api.get<{ version: string; summary: BlockingSummary }>(
    `/api/v1/students/${studentId}/blocking-summary${suffix}`
  );
  return res.summary;
}
