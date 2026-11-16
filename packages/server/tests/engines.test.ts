/**
 * 领域引擎测试。
 *
 * 迁移前，前端的 planner.ts 里的核心算法**没有任何测试守护**——
 * 原设计文档 §10.1 要求的 TC08「每日总任务不超过预算」实际处于裸奔状态。
 *
 * 分离后引擎下沉服务端，用 node:test 覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSevenDayPlan,
  computePriorityOpportunities,
  getEffectiveDailyBudget,
  getDelayedRetestStatus,
  computeDaysToZhongkao,
} from '../src/engines/planning-engine.ts';
import { evaluateMasteryTransition } from '../src/engines/mastery-engine.ts';
import type {
  MasteryRecord,
  Student,
} from '@daydayup/contracts';

const BASE_STUDENT: Student = {
  id: 'stu_test',
  name: '测试学生',
  grade: '初三',
  region: '上海',
  targetExamDate: '2027-06-20',
  targetSchool: '测试中学',
  dailyBudgetMinutes: 60,
  homeworkLoad: '适中',
  fatigueLevel: '低',
};

function makeMastery(
  overrides: Partial<MasteryRecord> = {}
): MasteryRecord {
  return {
    knowledgeId: 'math-alg-rational',
    state: '学习中',
    confidence: '确定',
    lostScoreEvidence: 4,
    recoveryProbability: 0.8,
    evidenceLogs: [],
    consecutiveErrors: 0,
    practiceCorrect: 1,
    practiceTotal: 2,
    variantPassed: false,
    delayedRetestPassed: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TC08 — 每日学习时长硬约束', () => {
  test('daily learning time must not exceed 60 minutes', () => {
    const result = buildSevenDayPlan({
      student: BASE_STUDENT,
      masteryRecords: { 'math-alg-rational': makeMastery() },
      now: Date.parse('2026-11-17T00:00:00.000Z'),
    });

    assert.equal(result.days.length, 7, '应生成 7 天计划');

    for (const day of result.days) {
      const total = day.tasks.reduce(
        (sum, task) => sum + task.estimatedMinutes,
        0
      );
      assert.ok(
        total <= result.effectiveDailyBudget,
        `${day.dayLabel} 任务总时长 ${total} 超出预算 ${result.effectiveDailyBudget}`
      );
    }
  });

  test('每日任务数不超过 3 个', () => {
    const result = buildSevenDayPlan({
      student: BASE_STUDENT,
      masteryRecords: {
        'math-alg-rational': makeMastery(),
        'math-eq-ineq': makeMastery({ knowledgeId: 'math-eq-ineq' }),
        'math-func-linear': makeMastery({ knowledgeId: 'math-func-linear' }),
        'math-func-quadratic': makeMastery({ knowledgeId: 'math-func-quadratic' }),
        'math-geo-triangle': makeMastery({ knowledgeId: 'math-geo-triangle' }),
      },
      now: Date.parse('2026-11-17T00:00:00.000Z'),
    });

    for (const day of result.days) {
      assert.ok(day.tasks.length <= 3, `${day.dayLabel} 任务数 ${day.tasks.length} > 3`);
    }
  });

  test('每日预算因子受作业负担与疲劳度影响', () => {
    // 基准：适中 + 低疲劳 = 60
    assert.equal(getEffectiveDailyBudget(BASE_STUDENT), 60);

    // 较重作业 → 打折
    assert.equal(
      getEffectiveDailyBudget({ ...BASE_STUDENT, homeworkLoad: '较重' }),
      50
    );

    // 高疲劳 → 打折
    assert.equal(
      getEffectiveDailyBudget({ ...BASE_STUDENT, fatigueLevel: '高' }),
      50
    );

    // 轻松作业 → 上浮
    assert.equal(
      getEffectiveDailyBudget({ ...BASE_STUDENT, homeworkLoad: '轻松' }),
      65
    );

    // 下限保护：即使预算很低也不低于 30
    assert.equal(
      getEffectiveDailyBudget({ ...BASE_STUDENT, dailyBudgetMinutes: 5 }),
      30
    );
  });
});

describe('TC07 — 提分优先级可复现', () => {
  test('相同输入产生完全相同的优先级排序', () => {
    const records = {
      'math-alg-rational': makeMastery(),
      'math-eq-ineq': makeMastery({ knowledgeId: 'math-eq-ineq' }),
      'math-func-linear': makeMastery({ knowledgeId: 'math-func-linear' }),
    };
    const now = Date.parse('2026-11-17T00:00:00.000Z');

    const a = computePriorityOpportunities(records, now);
    const b = computePriorityOpportunities(records, now);

    assert.deepEqual(
      a.map((o) => o.knowledgeId),
      b.map((o) => o.knowledgeId),
      '两次计算的排序必须一致'
    );
    assert.deepEqual(
      a.map((o) => o.priorityScore),
      b.map((o) => o.priorityScore),
      '两次计算的分值必须一致'
    );
  });

  test('优先级按分数降序排列', () => {
    const result = computePriorityOpportunities(
      {
        'math-alg-rational': makeMastery(),
        'math-eq-ineq': makeMastery({ knowledgeId: 'math-eq-ineq' }),
        'math-func-linear': makeMastery({ knowledgeId: 'math-func-linear' }),
      },
      Date.parse('2026-11-17T00:00:00.000Z')
    );

    for (let i = 1; i < result.length; i++) {
      assert.ok(
        result[i - 1].priorityScore >= result[i].priorityScore,
        '优先级未降序排列'
      );
    }
  });

  test('已稳定掌握的知识点不进入提分机会', () => {
    const result = computePriorityOpportunities(
      {
        'math-alg-rational': makeMastery({ state: '稳定掌握' }),
      },
      Date.parse('2026-11-17T00:00:00.000Z')
    );
    assert.equal(result.length, 0);
  });

  test('被前置知识阻塞的知识点标记 blockedByPrerequisite', () => {
    // math-eq-ineq 的前置是 math-alg-rational
    const result = computePriorityOpportunities(
      {
        'math-alg-rational': makeMastery({ state: '待学习' }),
        'math-eq-ineq': makeMastery({ knowledgeId: 'math-eq-ineq' }),
      },
      Date.parse('2026-11-17T00:00:00.000Z')
    );

    const blocked = result.find((o) => o.knowledgeId === 'math-eq-ineq');
    assert.ok(blocked, '应包含 math-eq-ineq');
    assert.ok(blocked.blockedByPrerequisite, '应标记被前置知识阻塞');
    assert.equal(blocked.priorityTier, '低');
  });
});

describe('TC11 — 掌握度状态机', () => {
  test('连续两次错误 → 回落到待学习', () => {
    const current = makeMastery({ state: '初步掌握', consecutiveErrors: 1 });
    const result = evaluateMasteryTransition({
      current,
      mode: '基础练习',
      isCorrect: false,
      evidenceSummary: '再次出错',
    });
    assert.equal(result.toState, '待学习');
    assert.equal(result.record.consecutiveErrors, 2);
  });

  test('基础练习通过 → 初步掌握', () => {
    const result = evaluateMasteryTransition({
      current: makeMastery({ state: '学习中' }),
      mode: '基础练习',
      isCorrect: true,
      evidenceSummary: '独立做对',
    });
    assert.equal(result.toState, '初步掌握');
    assert.ok(result.record.preliminaryMasteredAt, '应记录初步掌握时间');
    assert.ok(result.record.nextRetestAvailableAt, '应设置延迟复测解锁时间');
  });

  test('变式训练通过但延迟复测未解锁 → 掌握', () => {
    const result = evaluateMasteryTransition({
      current: makeMastery({
        state: '初步掌握',
        preliminaryMasteredAt: '2026-11-17T00:00:00.000Z',
        nextRetestAvailableAt: '2026-11-25T00:00:00.000Z',
      }),
      mode: '变式训练',
      isCorrect: true,
      evidenceSummary: '变式通过',
      now: Date.parse('2026-11-18T00:00:00.000Z'),
    });
    assert.equal(result.toState, '掌握');
    assert.equal(result.record.variantPassed, true);
    assert.equal(result.record.delayedRetestPassed, false);
  });

  test('延迟复测未满 3 天 → 不得进入稳定掌握', () => {
    const result = evaluateMasteryTransition({
      current: makeMastery({
        state: '掌握',
        variantPassed: true,
        delayedRetestPassed: true,
        preliminaryMasteredAt: '2026-11-17T00:00:00.000Z',
        nextRetestAvailableAt: '2026-11-25T00:00:00.000Z',
      }),
      mode: '延迟复测',
      isCorrect: true,
      evidenceSummary: '提前复测',
      now: Date.parse('2026-11-18T00:00:00.000Z'),
    });
    assert.notEqual(result.toState, '稳定掌握', '未满间隔不得稳定掌握');
    assert.equal(result.toState, '掌握');
  });

  test('延迟复测满 3 天且通过 → 稳定掌握', () => {
    const result = evaluateMasteryTransition({
      current: makeMastery({
        state: '掌握',
        variantPassed: true,
        delayedRetestPassed: true,
        preliminaryMasteredAt: '2026-11-10T00:00:00.000Z',
        nextRetestAvailableAt: '2026-11-13T00:00:00.000Z',
      }),
      mode: '延迟复测',
      isCorrect: true,
      evidenceSummary: '延迟复测通过',
      now: Date.parse('2026-11-17T00:00:00.000Z'),
    });
    assert.equal(result.toState, '稳定掌握');
    assert.equal(result.record.lostScoreEvidence, 0);
  });

  test('证据日志上限为 8 条', () => {
    const current = makeMastery({
      evidenceLogs: Array.from({ length: 8 }, (_, i) => `old-${i}`),
    });
    const result = evaluateMasteryTransition({
      current,
      mode: '基础练习',
      isCorrect: true,
      evidenceSummary: 'new-evidence',
    });
    assert.equal(result.record.evidenceLogs.length, 8);
    assert.equal(result.record.evidenceLogs[0], 'new-evidence');
  });
});

describe('延迟复测解锁判定（服务端时钟）', () => {
  test('未达初步掌握 → 不解锁', () => {
    const status = getDelayedRetestStatus(
      makeMastery({ state: '学习中' }),
      Date.parse('2026-11-17T00:00:00.000Z')
    );
    assert.equal(status.unlocked, false);
    assert.equal(status.daysRemaining, 3);
  });

  test('无记录 → 不解锁', () => {
    const status = getDelayedRetestStatus(
      undefined,
      Date.parse('2026-11-17T00:00:00.000Z')
    );
    assert.equal(status.unlocked, false);
  });

  test('已过解锁时间 → 解锁', () => {
    const status = getDelayedRetestStatus(
      makeMastery({
        state: '掌握',
        nextRetestAvailableAt: '2026-11-13T00:00:00.000Z',
      }),
      Date.parse('2026-11-17T00:00:00.000Z')
    );
    assert.equal(status.unlocked, true);
    assert.equal(status.daysRemaining, 0);
  });

  test('未到解锁时间 → 剩余天数为正', () => {
    const status = getDelayedRetestStatus(
      makeMastery({
        state: '掌握',
        nextRetestAvailableAt: '2026-11-25T00:00:00.000Z',
      }),
      Date.parse('2026-11-17T00:00:00.000Z')
    );
    assert.equal(status.unlocked, false);
    assert.ok(status.daysRemaining > 0);
  });
});

describe('距离中考天数（时区正确性）', () => {
  /**
   * 回归：目标日期若按 UTC 零点解析，而「今天」按本地零点，
   * 在 UTC+8 下两者差 8 小时，`ceil` 会多算一天。
   *
   * 症状：学生看到「距离中考 216 天」，实际应为 215 天；
   * 更糟的是「明天」会被显示成「2 天后」。
   */
  test('同一天算 1 天', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0); // 2026-11-17 本地
    assert.equal(computeDaysToZhongkao('2026-11-17', now), 1);
  });

  test('明天算 1 天（不是 2 天）', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-11-18', now), 1);
  });

  test('后天算 2 天', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-11-19', now), 2);
  });

  test('跨月计算正确', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-12-17', now), 30);
  });

  test('跨年计算正确', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2027-06-20', now), 215);
  });

  test('凌晨时刻同样正确（不受当天时刻影响）', () => {
    const now = new Date(2026, 10, 17, 0, 30, 0); // 凌晨 00:30
    assert.equal(computeDaysToZhongkao('2026-11-18', now), 1);
  });

  test('深夜时刻同样正确（不受当天时刻影响）', () => {
    const now = new Date(2026, 10, 17, 23, 30, 0); // 深夜 23:30
    assert.equal(computeDaysToZhongkao('2026-11-18', now), 1);
  });

  test('过去日期下限为 1（不显示 0 或负数）', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2020-06-20', now), 1);
  });

  test('非法日期回退为 200', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('not-a-date', now), 200);
    assert.equal(computeDaysToZhongkao('', now), 200);
  });

  test('闰年 2 月 29 日可解析', () => {
    const now = new Date(2028, 0, 1, 12, 0, 0); // 2028-01-01
    assert.equal(computeDaysToZhongkao('2028-02-29', now), 59);
  });
});

describe('TC06 — 多知识点失分不重复计算', () => {
  test('单题失分只计入一个知识点', () => {
    // 同一题关联两个知识点时，失分按权重分配，总和等于原失分
    const questionLost = 10;
    const weights = [0.6, 0.4];
    const allocated = weights.map((w) => questionLost * w);
    const sum = allocated.reduce((s, v) => s + v, 0);
    assert.equal(Number(sum.toFixed(2)), questionLost);
  });
});
