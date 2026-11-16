/**
 * 本地计划降级测试。
 *
 * 降级路径在服务端不可用时生效（本地开发未起后端、网络故障）。
 * 它**不是**权威实现，但展示性内容不能错 ——
 * 学科标错会让非数学学生看到一屏不相干的任务。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, KnowledgePoint } from '@daydayup/contracts';
import {
  buildLocalPlanFallback,
  getEffectiveDailyBudgetFallback,
} from '../src/engine/plan-fallback.ts';

function student(overrides: Partial<AppState['student']> = {}): AppState['student'] {
  return {
    id: 'stu-1',
    name: '张伟',
    grade: '初三',
    region: '上海',
    targetExamDate: '2027-06-20',
    targetSchool: '上海市重点高中',
    dailyBudgetMinutes: 60,
    homeworkLoad: '适中',
    fatigueLevel: '低',
    ...overrides,
  };
}

function mastery(overrides: Partial<AppState['masteryRecords'][string]> = {}) {
  return {
    knowledgeId: 'kp-1',
    state: '学习中',
    confidence: '较可能',
    lostScoreEvidence: 8,
    recoveryProbability: 0.6,
    evidenceLogs: [],
    consecutiveErrors: 0,
    practiceCorrect: 0,
    practiceTotal: 0,
    variantPassed: false,
    delayedRetestPassed: false,
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as AppState['masteryRecords'][string];
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    student: student(),
    exams: [],
    examResults: [],
    examPapers: [],
    errorRecords: [],
    masteryRecords: {},
    masteryHistory: [],
    learningAttempts: [],
    variantQuestions: [],
    completedTaskIds: [],
    deferredKnowledgeIds: [],
    coachHistoryByKnowledge: {},
    taskProgressByKnowledge: {},
    ...overrides,
  } as AppState;
}

const KP_EN: KnowledgePoint = {
  id: 'eng-grammar-tenses',
  name: '时态与语态',
  subject: '英语',
  domain: '语法',
  prerequisites: [],
  examWeight: 1.25,
  learningCostHours: 3,
} as unknown as KnowledgePoint;

describe('有效时长预算（与服务端规则一致）', () => {
  test('适中负荷 + 低疲劳 = 基准值', () => {
    assert.equal(
      getEffectiveDailyBudgetFallback(student({ dailyBudgetMinutes: 60 })),
      60
    );
  });

  test('较重作业 ×0.85 后向下取整到 5 的倍数', () => {
    // 60 × 0.85 = 51 → 50
    assert.equal(
      getEffectiveDailyBudgetFallback(
        student({ dailyBudgetMinutes: 60, homeworkLoad: '较重' })
      ),
      50
    );
  });

  test('轻松作业 +10%', () => {
    // 60 × 1.1 = 66 → 65
    assert.equal(
      getEffectiveDailyBudgetFallback(
        student({ dailyBudgetMinutes: 60, homeworkLoad: '轻松' })
      ),
      65
    );
  });

  test('高疲劳 ×0.85', () => {
    // 60 × 0.85 = 51 → 50
    assert.equal(
      getEffectiveDailyBudgetFallback(
        student({ dailyBudgetMinutes: 60, fatigueLevel: '高' })
      ),
      50
    );
  });

  test('较重作业 + 高疲劳叠加', () => {
    // 60 × 0.7 = 42 → 40
    assert.equal(
      getEffectiveDailyBudgetFallback(
        student({
          dailyBudgetMinutes: 60,
          homeworkLoad: '较重',
          fatigueLevel: '高',
        })
      ),
      40
    );
  });

  test('有下限 30 分钟（不能压到 0）', () => {
    assert.equal(
      getEffectiveDailyBudgetFallback(
        student({ dailyBudgetMinutes: 10, homeworkLoad: '较重', fatigueLevel: '高' })
      ),
      30
    );
  });
});

describe('降级计划的结构', () => {
  test('生成 7 天日程', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery() } })
    );
    assert.equal(plan.days.length, 7);
    assert.equal(plan.days[0].dayLabel, '今天');
    assert.equal(plan.days[6].dayLabel, '第7天');
  });

  test('每日任务总时长不超过有效预算', () => {
    const plan = buildLocalPlanFallback(
      state({
        masteryRecords: {
          'kp-1': mastery(),
          'kp-2': mastery({ knowledgeId: 'kp-2' }),
          'kp-3': mastery({ knowledgeId: 'kp-3' }),
        },
      })
    );
    for (const day of plan.days) {
      assert.ok(
        day.totalMinutes <= plan.effectiveDailyBudget,
        `第 ${day.dayIndex + 1} 天排期 ${day.totalMinutes} 超出预算 ${plan.effectiveDailyBudget}`
      );
    }
  });

  test('每日 totalMinutes 与任务之和一致', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery() } })
    );
    for (const day of plan.days) {
      const sum = day.tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      assert.equal(day.totalMinutes, sum);
    }
  });

  test('已完成的任务状态为「已完成」', () => {
    const plan = buildLocalPlanFallback(
      state({
        masteryRecords: { 'kp-1': mastery() },
        completedTaskIds: ['task-d0-kp-1'],
      })
    );
    assert.equal(plan.days[0].tasks[0].status, '已完成');
    assert.equal(plan.days[1].tasks[0].status, '待开始');
  });

  test('稳定掌握的知识点不进入提分机会', () => {
    const plan = buildLocalPlanFallback(
      state({
        masteryRecords: {
          'kp-1': mastery(),
          'kp-done': mastery({ knowledgeId: 'kp-done', state: '稳定掌握' }),
        },
      })
    );
    assert.equal(plan.priorities.length, 1);
    assert.equal(plan.priorities[0].knowledgeId, 'kp-1');
  });

  test('连续两次错误标记为难度调整', () => {
    const plan = buildLocalPlanFallback(
      state({
        masteryRecords: { 'kp-1': mastery({ consecutiveErrors: 2 }) },
      })
    );
    assert.equal(plan.days[0].tasks[0].difficultyAdjusted, true);
  });

  test('引擎版本标记为 local-fallback', () => {
    const plan = buildLocalPlanFallback(state());
    assert.equal(plan.engineVersion, 'local-fallback.v1');
  });

  test('无掌握度数据时也能生成空计划', () => {
    const plan = buildLocalPlanFallback(state());
    assert.equal(plan.days.length, 7);
    assert.equal(plan.priorities.length, 0);
  });
});

describe('展示字段取自知识体系（回归）', () => {
  /**
   * 历史缺陷：学科被硬编码为「数学」，
   * 知识点名称直接用 id。
   * 降级路径下，英语/物理/化学学生会看到一屏「数学」任务。
   */
  test('学科与知识点名称取自知识体系资产', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'eng-grammar-tenses': mastery({ knowledgeId: 'eng-grammar-tenses' }) } }),
      { 'eng-grammar-tenses': KP_EN }
    );

    assert.equal(plan.priorities[0].subject, '英语');
    assert.equal(plan.priorities[0].knowledgeName, '时态与语态');
    assert.equal(plan.priorities[0].domain, '语法');
    assert.equal(plan.days[0].tasks[0].title, '英语：时态与语态');
  });

  test('考试权重与学习成本也取自知识体系', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'eng-grammar-tenses': mastery({ knowledgeId: 'eng-grammar-tenses' }) } }),
      { 'eng-grammar-tenses': KP_EN }
    );
    assert.equal(plan.priorities[0].examWeight, 1.25);
    assert.equal(plan.priorities[0].learningCostHours, 3);
  });

  test('知识体系缺失时回退到 id（不崩）', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'unknown-kp': mastery({ knowledgeId: 'unknown-kp' }) } })
    );
    assert.equal(plan.priorities[0].knowledgeName, 'unknown-kp');
    assert.equal(plan.priorities[0].subject, '数学');
  });
});

describe('步骤拆分', () => {
  test('初步掌握 / 掌握 用三步方案', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery({ state: '初步掌握' }) } })
    );
    assert.equal(plan.days[0].tasks[0].steps.length, 3);
  });

  test('其它状态用四步方案', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery({ state: '学习中' }) } })
    );
    assert.equal(plan.days[0].tasks[0].steps.length, 4);
  });

  test('步骤时长之和等于任务时长', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery({ state: '学习中' }) } })
    );
    const task = plan.days[0].tasks[0];
    const sum = task.steps.reduce((s, st) => s + st.minutes, 0);
    assert.equal(sum, task.estimatedMinutes);
  });

  test('步骤时长不低于 2 分钟', () => {
    const plan = buildLocalPlanFallback(
      state({ masteryRecords: { 'kp-1': mastery() } })
    );
    for (const task of plan.days[0].tasks) {
      for (const step of task.steps) {
        assert.ok(step.minutes >= 2, `步骤时长 ${step.minutes} 过小`);
      }
    }
  });
});
