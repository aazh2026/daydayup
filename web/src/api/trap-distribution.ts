/**
 * 错因形态分布 API 客户端。
 *
 * 回答「学生的失分集中在哪些**具体陷阱形态**上」——
 * 与五维错因（知识/方法/计算/熟练度/审题，来自 AI 诊断）是**两条正交的轴**：
 *   - 五维错因：错在哪个**环节**
 *   - 陷阱形态：错成了什么**样子**（来自错因资产 TrapSet）
 *
 * 分类在服务端完成（规则匹配，可复现、可审计），前端只消费结果。
 */
import { api } from './client.ts';

/** 错因形态类型（与服务端 `TrapType` 一致）。 */
export type TrapType =
  | '概念混淆'
  | '规则误用'
  | '审题遗漏'
  | '计算失误'
  | '表达不规范'
  | '知识缺失'
  | '其他易错点';

export interface TrapTypeBucket {
  type: TrapType;
  label: string;
  /** 命中该形态的错题数（一道错题在同一形态下只计一次） */
  count: number;
  /** 该形态归集到的失分 */
  lost: number;
  /** 占已归因失分的百分比 */
  pct: number;
  /** 该形态下的代表考点（按失分降序） */
  topKnowledge: Array<{
    knowledgeId: string;
    knowledgeName: string;
    count: number;
    lost: number;
  }>;
}

export interface TrapDistribution {
  totalErrors: number;
  attributedErrors: number;
  unattributedErrors: number;
  attributedLost: number;
  unattributedLost: number;
  buckets: TrapTypeBucket[];
  samples: Array<{
    errorId: string;
    knowledgeId: string;
    knowledgeName: string;
    types: TrapType[];
    scoreLost: number;
  }>;
}

/**
 * 取得学生的错因形态分布。
 *
 * @param studentId 学生 ID
 */
export async function fetchTrapDistribution(
  studentId: string
): Promise<TrapDistribution> {
  return api.get<TrapDistribution>(
    `/api/v1/students/${studentId}/trap-distribution`
  );
}
