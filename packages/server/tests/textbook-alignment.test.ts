/**
 * 教材对齐层测试（上海本地课本落点）。
 *
 * 覆盖：
 * 1. 只加载 ACTIVE 教材对齐资产，DRAFT 不生效；
 * 2. 上海本地教材（沪教版/译林版）优先于跨版本参考；
 * 3. 知识点被写上 textbook 落点，未对齐的不被污染；
 * 4. 排课任务的 objective 带上课本落点（含「重点：undefined」的历史缺陷回归）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { KnowledgePoint, TextbookAlignmentSet } from '@daydayup/contracts';

function makeKp(id: string, name: string): KnowledgePoint {
  return {
    id,
    subject: '数学',
    chapter: '人教版章节',
    domain: '数与式',
    name,
    subSkills: [],
    definition: '',
    prerequisites: [],
    commonExamForms: [],
    commonTraps: [],
    examWeight: 1,
    learningCostHours: 1,
  };
}

function writeSet(
  dir: string,
  file: string,
  set: Omit<TextbookAlignmentSet, 'version' | 'publishedAt'>
): void {
  const full: TextbookAlignmentSet = {
    version: file.replace('.json', ''),
    publishedAt: '2026-11-19T00:00:00.000Z',
    ...set,
  };
  fs.writeFileSync(path.join(dir, file), JSON.stringify(full), 'utf8');
}

async function loadFresh(): Promise<
  typeof import('../src/infrastructure/knowledge/textbook-alignment.ts')
> {
  return (await import(
    `../src/infrastructure/knowledge/textbook-alignment.ts?fresh=${Date.now()}-${Math.random()}`
  )) as typeof import('../src/infrastructure/knowledge/textbook-alignment.ts');
}

test('教材对齐：只有 ACTIVE 生效，DRAFT 只告警', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tb-'));
  const dir = path.join(tmp, 'curriculum');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeSet(dir, 'a-draft.json', {
      status: 'DRAFT',
      source: { repo: 'cn-math-taxonomy', path: 'x', license: 'CC BY-NC 4.0' },
      entries: [
        {
          knowledgeId: 'cnm_001',
          textbook: {
            editionKey: 'hujiao_math',
            edition: '沪教版数学',
            grade: '七年级',
            term: '上册',
            unit: '第1章',
            chapter: '有理数',
          },
        },
      ],
    });

    process.env.DATA_DIR = tmp;
    const mod = await loadFresh();
    assert.equal(mod.getTextbookAlignmentSets().length, 0, 'DRAFT 不应生效');
    assert.equal(Object.keys(mod.getTextbookMap()).length, 0);
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('教材对齐：上海本地教材优先于跨版本参考', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tb-'));
  const dir = path.join(tmp, 'curriculum');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeSet(dir, 'a-sujiao.json', {
      status: 'ACTIVE',
      source: { repo: 'cn-math-taxonomy', path: 'x', license: 'CC BY-NC 4.0' },
      entries: [
        {
          knowledgeId: 'cnm_001',
          textbook: {
            editionKey: 'sujiao_math',
            edition: '苏教版数学',
            grade: '七年级',
            term: '上册',
            unit: '第1章',
            chapter: '苏教章节',
          },
        },
        {
          knowledgeId: 'cnm_002',
          textbook: {
            editionKey: 'sujiao_math',
            edition: '苏教版数学',
            grade: '七年级',
            term: '上册',
            unit: '第1章',
            chapter: '仅苏教有',
          },
        },
      ],
    });
    writeSet(dir, 'b-hujiao.json', {
      status: 'ACTIVE',
      source: { repo: 'cn-math-taxonomy', path: 'x', license: 'CC BY-NC 4.0' },
      entries: [
        {
          knowledgeId: 'cnm_001',
          textbook: {
            editionKey: 'hujiao_math',
            edition: '沪教版数学',
            grade: '七年级',
            term: '上册',
            unit: '第2章',
            chapter: '有理数的运算',
          },
        },
      ],
    });

    process.env.DATA_DIR = tmp;
    const mod = await loadFresh();
    const map = mod.getTextbookMap();
    assert.equal(map['cnm_001'].editionKey, 'hujiao_math', '沪教版应覆盖苏教版');
    assert.equal(map['cnm_001'].chapter, '有理数的运算');
    assert.equal(map['cnm_002'].editionKey, 'sujiao_math', '无沪教版落点时用参考版');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('教材对齐：只写回有落点的知识点，未对齐不被污染', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tb-'));
  const dir = path.join(tmp, 'curriculum');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeSet(dir, 'b-hujiao.json', {
      status: 'ACTIVE',
      source: { repo: 'cn-math-taxonomy', path: 'x', license: 'CC BY-NC 4.0' },
      entries: [
        {
          knowledgeId: 'cnm_001',
          textbook: {
            editionKey: 'hujiao_math',
            edition: '沪教版数学',
            grade: '七年级',
            term: '上册',
            unit: '第2章',
            chapter: '有理数的运算',
          },
        },
      ],
    });

    process.env.DATA_DIR = tmp;
    const mod = await loadFresh();
    const kps = [makeKp('cnm_001', '有理数'), makeKp('cnm_002', '分数')];
    const result = mod.applyTextbookAlignment(kps, mod.getTextbookMap());
    assert.equal(result.aligned, 1);
    assert.equal(kps[0].textbook?.chapter, '有理数的运算');
    assert.equal(kps[1].textbook, undefined, '未对齐知识点不应被写入');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('教材对齐：仓库内 ACTIVE 资产可加载且外键全部命中知识资产', async () => {
  const mod = await import('../src/infrastructure/knowledge/textbook-alignment.ts');
  const sets = mod.getTextbookAlignmentSets();
  assert.ok(sets.length >= 2, '应至少有沪教版数学与译林版英语两份生效资产');

  const map = mod.getTextbookMap();
  assert.ok(Object.keys(map).length >= 300, '生效课本落点应覆盖 300+ 个知识点');

  const curriculum = await import('../src/infrastructure/knowledge/curriculum.ts');
  const kps = curriculum.getCurriculum().knowledgePoints;
  const ids = new Set(kps.map((k) => k.id));
  for (const id of Object.keys(map)) {
    assert.ok(ids.has(id), `课本落点指向不存在的知识点：${id}`);
  }

  const aligned = kps.filter((k) => k.textbook);
  assert.ok(aligned.length >= 300, `应至少 300 个知识点带课本落点，实际 ${aligned.length}`);
  assert.ok(
    aligned.every((k) => k.textbook!.grade.includes('年级')),
    '课本落点应含年级'
  );
});

test('排课：任务 objective 带上海课本落点，且不再出现「重点：undefined」', async () => {
  const { buildSevenDayPlan } = await import('../src/engines/planning-engine.ts');
  const curriculum = await import('../src/infrastructure/knowledge/curriculum.ts');

  const kps = curriculum
    .getCurriculum()
    .knowledgePoints.filter((k) => k.textbook && k.commonTraps.length === 0)
    .slice(0, 3);
  assert.ok(kps.length > 0, '需要至少一个带课本落点的知识点');

  const masteryRecords = Object.fromEntries(
    kps.map((k) => [
      k.id,
      {
        knowledgeId: k.id,
        state: '学习中',
        confidence: '确定',
        lostScoreEvidence: 4,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ])
  );

  const plan = buildSevenDayPlan({
    student: {
      id: 'stu_tb',
      name: '教材对齐测试',
      grade: '初三',
      region: '上海',
      targetExamDate: '2027-06-20',
      targetSchool: '测试中学',
      dailyBudgetMinutes: 60,
      homeworkLoad: '适中',
      fatigueLevel: '低',
    },
    masteryRecords: masteryRecords as never,
    now: Date.parse('2026-11-17T00:00:00.000Z'),
  });

  const tasks = plan.days.flatMap((d) => d.tasks);
  assert.ok(tasks.length > 0, '应排出任务');

  const withTextbook = tasks.filter((t) => t.textbook);
  assert.ok(withTextbook.length > 0, '应有任务携带课本落点');
  for (const t of withTextbook) {
    assert.ok(
      t.objective.includes(t.textbook!.edition),
      `objective 应含教材版本：${t.objective}`
    );
    assert.ok(
      t.objective.includes(t.textbook!.chapter),
      `objective 应含课本章节：${t.objective}`
    );
  }
  for (const t of tasks) {
    assert.ok(!t.objective.includes('undefined'), `objective 不应出现 undefined：${t.objective}`);
  }
});
