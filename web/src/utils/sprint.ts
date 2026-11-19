/**
 * 冲刺计划的纯展示计算。
 *
 * 与服务端 `buildSprintPlan()` 的分工：
 * - 服务端负责排期（哪一天做什么、限时多少分钟、验收标准）；
 * - 前端只做分组与统计这类展示层计算，便于单测覆盖。
 */
import type { SprintDayPlan } from '@daydayup/contracts';

export interface SprintStageGroup {
  name: string;
  /** 阶段内的天序号（升序） */
  days: number[];
  fromDay: number;
  toDay: number;
}

/** 按阶段名把 30 天分组（保持首次出现顺序） */
export function groupSprintStages(days: SprintDayPlan[]): SprintStageGroup[] {
  const map = new Map<string, number[]>();
  for (const day of days) {
    const list = map.get(day.stage) ?? [];
    list.push(day.dayIndex);
    map.set(day.stage, list);
  }
  return [...map.entries()].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return {
      name,
      days: sorted,
      fromDay: sorted[0] ?? 0,
      toDay: sorted[sorted.length - 1] ?? 0,
    };
  });
}

export interface SprintDaySummary {
  /** 已绑定知识点的天数 */
  boundDays: number;
  /** 未绑定知识点的天数（走兜底） */
  unboundDays: number;
  /** 总任务数 */
  totalTasks: number;
  /** 平均每日分钟 */
  averageMinutes: number;
  /** 超过每日预算的天数（应为 0） */
  overBudgetDays: number;
}

/** 统计冲刺计划的结构与预算合规性 */
export function summarizeSprintPlan(
  days: SprintDayPlan[],
  effectiveDailyBudget: number
): SprintDaySummary {
  let boundDays = 0;
  let unboundDays = 0;
  let totalTasks = 0;
  let totalMinutes = 0;
  let overBudgetDays = 0;

  for (const day of days) {
    totalTasks += day.tasks.length;
    totalMinutes += day.totalMinutes;
    if (day.tasks.length > 0) boundDays += 1;
    else unboundDays += 1;
    if (day.totalMinutes > effectiveDailyBudget) overBudgetDays += 1;
  }

  return {
    boundDays,
    unboundDays,
    totalTasks,
    averageMinutes: days.length === 0 ? 0 : Math.round(totalMinutes / days.length),
    overBudgetDays,
  };
}
