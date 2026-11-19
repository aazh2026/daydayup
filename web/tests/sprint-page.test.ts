import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AppPage, SprintDayPlan } from '@daydayup/contracts';
import { groupSprintStages, summarizeSprintPlan } from '../src/utils/sprint.ts';

function day(
  dayIndex: number,
  stage: string,
  taskCount: number,
  totalMinutes: number
): SprintDayPlan {
  return {
    dayIndex,
    dayLabel: `第${dayIndex}天`,
    stage,
    task: '任务',
    timeLimit: '每日 35–45 分钟',
    acceptanceCriteria: '验收',
    totalMinutes,
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `sprint-d${dayIndex}-t${i}`,
      dayIndex,
      dayLabel: `第${dayIndex}天`,
      subject: '英语' as const,
      knowledgeId: `cne_wb_${dayIndex}`,
      knowledgeName: '知识点',
      title: '英语：知识点',
      objective: '目标',
      verifiableOutcome: '可验证',
      estimatedMinutes: 15,
      steps: [],
      status: '待学习' as const,
      priorityRank: 1,
    })),
  };
}

describe('30 天冲刺页（前端展示层）', () => {
  it('AppPage 契约包含 sprint 页面标识', () => {
    const pages: AppPage[] = ['today', 'planning', 'sprint', 'coach'];
    assert.ok(pages.includes('sprint'));
  });

  it('阶段分组：按阶段名归并并保留天号区间', () => {
    const days = [
      day(1, '第一阶段 · 止血', 3, 45),
      day(2, '第一阶段 · 止血', 2, 45),
      day(11, '第二阶段 · 提分', 3, 60),
    ];
    const stages = groupSprintStages(days);
    assert.equal(stages.length, 2);
    assert.equal(stages[0].name, '第一阶段 · 止血');
    assert.equal(stages[0].fromDay, 1);
    assert.equal(stages[0].toDay, 2);
    assert.equal(stages[1].fromDay, 11);
  });

  it('结构统计：绑定天数、任务总数与平均时长', () => {
    const days = [
      day(1, 'A', 3, 45),
      day(2, 'A', 0, 45),
      day(3, 'A', 2, 60),
    ];
    const s = summarizeSprintPlan(days, 60);
    assert.equal(s.boundDays, 2);
    assert.equal(s.unboundDays, 1);
    assert.equal(s.totalTasks, 5);
    assert.equal(s.averageMinutes, 50);
    assert.equal(s.overBudgetDays, 0);
  });

  it('预算合规：超出每日预算的天数必须被统计出来', () => {
    const days = [day(1, 'A', 3, 45), day(2, 'A', 3, 90)];
    const s = summarizeSprintPlan(days, 60);
    assert.equal(s.overBudgetDays, 1);
  });

  it('空计划不产生除零异常', () => {
    const s = summarizeSprintPlan([], 60);
    assert.equal(s.averageMinutes, 0);
    assert.equal(s.totalTasks, 0);
    assert.equal(s.overBudgetDays, 0);
  });
});
