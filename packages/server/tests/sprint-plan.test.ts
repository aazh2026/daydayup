/**
 * 30 天冲刺计划测试（workbuddy「上海中考英语 30 天冲刺」资产接入）。
 *
 * 覆盖：
 * 1. 结构约束：30 天、每天 ≤3 任务、每天总时长 ≤ 有效每日预算、每天 ≥1 任务、任务 id 唯一；
 * 2. 确定性：同样输入两次调用结果一致（id 不含随机数/当前时刻）；
 * 3. 阶段边界：day1/11/21/30 的阶段与 day30 的任务文案；
 * 4. 资产加载：只有 ACTIVE 生效，DRAFT 不生效（DATA_DIR 临时目录 + 动态 import）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SprintSet, Student } from '@daydayup/contracts';

import {
  buildSprintPlan,
  getEffectiveDailyBudget,
  SPRINT_ENGINE_VERSION,
} from '../src/engines/planning-engine.ts';

const FIXED_NOW = new Date('2026-11-19T08:00:00.000Z');

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: 'stu-sprint-test',
    name: '冲刺测试同学',
    grade: '初三',
    region: '上海',
    targetExamDate: '2027-06-20',
    targetSchool: '上海市实验中学',
    dailyBudgetMinutes: 60,
    homeworkLoad: '适中',
    fatigueLevel: '低',
    ...overrides,
  };
}

test('冲刺计划：结构约束（30 天 / ≤3 任务 / ≤预算 / ≥1 任务 / id 唯一）', () => {
  const student = makeStudent();
  const budget = getEffectiveDailyBudget(student);
  const plan = buildSprintPlan(student, { now: FIXED_NOW });

  assert.equal(plan.engineVersion, SPRINT_ENGINE_VERSION);
  assert.equal(plan.subject, '英语');
  assert.equal(plan.effectiveDailyBudget, budget);
  assert.equal(plan.totalDays, 30);
  assert.equal(plan.days.length, 30);

  const ids = new Set<string>();
  for (const day of plan.days) {
    assert.ok(day.tasks.length >= 1, `第${day.dayIndex}天至少要有 1 个任务`);
    assert.ok(
      day.tasks.length <= 3,
      `第${day.dayIndex}天任务数 ${day.tasks.length} 超过 3`
    );
    assert.ok(
      day.totalMinutes <= budget,
      `第${day.dayIndex}天总时长 ${day.totalMinutes} 超出预算 ${budget}`
    );
    assert.equal(
      day.totalMinutes,
      day.tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0)
    );
    for (const task of day.tasks) {
      assert.ok(task.estimatedMinutes >= 5, `任务 ${task.id} 分钟数低于下限`);
      assert.ok(
        task.id.startsWith(`sprint-d${day.dayIndex}-`),
        `任务 id 命名不符：${task.id}`
      );
      assert.ok(task.knowledgeId.length > 0, '任务必须挂到知识点上');
      assert.ok(task.knowledgeName.length > 0, '任务必须有知识点名称');
      assert.equal(task.subject, '英语');
      assert.ok(
        task.verifiableOutcome.includes('当日验收标准'),
        '验收标准应进入 verifiableOutcome'
      );
      assert.ok(task.objective.includes(day.task), '当日任务文本应进入 objective');
      assert.equal(ids.has(task.id), false, `任务 id 重复：${task.id}`);
      ids.add(task.id);
    }
  }
});

test('冲刺计划：确定性（同输入两次调用结果一致）', () => {
  const student = makeStudent();
  const a = buildSprintPlan(student, { now: FIXED_NOW });
  const b = buildSprintPlan(student, { now: FIXED_NOW });
  assert.deepEqual(a, b);
  assert.equal(a.id, b.id);

  // 不显式传 now 时：id 与日程内容仍必须一致（只有 generatedAt 随生成时刻变化）
  const c = buildSprintPlan(student);
  const d = buildSprintPlan(student);
  assert.equal(c.id, d.id);
  assert.deepEqual(c.days, d.days);
});

test('冲刺计划：阶段边界正确（day1/11/21/30）', () => {
  const plan = buildSprintPlan(makeStudent(), { now: FIXED_NOW });
  const byIndex = new Map(plan.days.map((d) => [d.dayIndex, d]));

  assert.ok(byIndex.get(1)!.stage.includes('第一阶段'));
  assert.ok(byIndex.get(11)!.stage.includes('第二阶段'));
  assert.ok(byIndex.get(21)!.stage.includes('第三阶段'));
  assert.ok(byIndex.get(30)!.stage.includes('第三阶段'));

  assert.equal(byIndex.get(1)!.dayLabel, '第1天');
  assert.equal(byIndex.get(30)!.dayLabel, '第30天');
  assert.ok(byIndex.get(30)!.task.includes('考前一天'));

  // 整套卷日（day21/day27）限时 90 分钟 → 但总时长仍受每日预算约束
  assert.equal(byIndex.get(21)!.timeLimit, '每日 35–45 分钟；整套卷日 90 分钟');
  assert.ok(byIndex.get(21)!.totalMinutes <= plan.effectiveDailyBudget);
});

test('冲刺计划：预算不足时按比例缩减，仍不低于每任务 5 分钟', () => {
  const tight = makeStudent({ dailyBudgetMinutes: 30, homeworkLoad: '较重', fatigueLevel: '高' });
  const budget = getEffectiveDailyBudget(tight);
  const plan = buildSprintPlan(tight, { now: FIXED_NOW });

  assert.equal(plan.totalDays, 30);
  for (const day of plan.days) {
    assert.ok(day.tasks.length >= 1);
    assert.ok(day.totalMinutes <= budget, `第${day.dayIndex}天超预算`);
    for (const task of day.tasks) {
      assert.ok(task.estimatedMinutes >= 5, `任务 ${task.id} 低于 5 分钟`);
    }
  }
});

async function loadFreshSprintModule(): Promise<
  typeof import('../src/infrastructure/knowledge/sprint.ts')
> {
  return (await import(
    `../src/infrastructure/knowledge/sprint.ts?fresh=${Date.now()}-${Math.random()}`
  )) as typeof import('../src/infrastructure/knowledge/sprint.ts');
}

test('冲刺资产加载：只有 ACTIVE 生效，DRAFT 不生效', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-sprint-'));
  const dir = path.join(tmp, 'sprints');
  fs.mkdirSync(dir, { recursive: true });

  const draft: SprintSet = {
    version: 'draft-only',
    publishedAt: '2026-11-19T00:00:00.000Z',
    status: 'DRAFT',
    source: { repo: 'workbuddy-research', path: 'x', license: '内部资料' },
    stages: [],
    days: [
      {
        dayIndex: 1,
        stage: '第一阶段',
        task: '草稿冲刺',
        timeLimit: '45 分钟',
        acceptanceCriteria: '草稿验收',
        subject: '英语',
        knowledgeIds: [],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'draft-only.json'), JSON.stringify(draft), 'utf8');

  try {
    process.env.DATA_DIR = tmp;
    const mod = await loadFreshSprintModule();
    assert.equal(mod.getSprintSets().length, 0, 'DRAFT 冲刺资产不应生效');
    assert.equal(mod.getActiveSprintSet(), null, '不应有生效的冲刺资产');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('冲刺资产加载：ACTIVE 生效且可被引擎消费', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-sprint-'));
  const dir = path.join(tmp, 'sprints');
  fs.mkdirSync(dir, { recursive: true });

  const active: SprintSet = {
    version: 'active-test',
    publishedAt: '2026-11-19T00:00:00.000Z',
    status: 'ACTIVE',
    source: { repo: 'workbuddy-research', path: 'x', license: '内部资料' },
    stages: [{ name: '第一阶段', acceptanceCriteria: '验收', fromDay: 1, toDay: 1 }],
    days: [
      {
        dayIndex: 1,
        stage: '第一阶段',
        task: '测试冲刺任务',
        timeLimit: '每日 35–45 分钟；整套卷日 90 分钟',
        acceptanceCriteria: '错题 ≤1',
        subject: '英语',
        knowledgeIds: ['不存在的知识点'],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'active-test.json'), JSON.stringify(active), 'utf8');

  try {
    process.env.DATA_DIR = tmp;
    const mod = await loadFreshSprintModule();
    assert.equal(mod.getSprintSets().length, 1);
    assert.equal(mod.getActiveSprintSet()?.version, 'active-test');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
