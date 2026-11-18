/**
 * 知识资产加载器测试：资产选择规则与目录回落。
 *
 * 覆盖：
 *  - selectCurriculumFile：优先 ACTIVE，否则排序最后
 *  - DATA_DIR 覆盖：自定义目录有资产则用之，无则回落到打包资产
 *  - 题库资产选择：取排序最后者，损坏文件被跳过
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  selectCurriculumFile,
  type CurriculumAsset,
} from '../src/infrastructure/knowledge/curriculum.ts';

function asset(version: string, status: CurriculumAsset['status']): CurriculumAsset {
  return {
    version,
    publishedAt: '2026-01-01T00:00:00.000Z',
    status,
    subjects: ['数学'],
    knowledgePoints: [],
  };
}

// ---------------------------------------------------------------------------
// selectCurriculumFile
// ---------------------------------------------------------------------------

test('资产选择：优先选 ACTIVE 版本', () => {
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'DRAFT') },
    { file: 'b.json', parsed: asset('2026.2', 'ACTIVE') },
    { file: 'c.json', parsed: asset('2026.3', 'DRAFT') },
  ]);
  assert.equal(picked, 'b.json');
});

test('资产选择：多个 ACTIVE 时取第一个（排序后顺序）', () => {
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'ACTIVE') },
    { file: 'b.json', parsed: asset('2026.2', 'ACTIVE') },
  ]);
  assert.equal(picked, 'a.json');
});

test('资产选择：没有 ACTIVE 时取排序最后的**非草稿**版本', () => {
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'DRAFT') },
    { file: 'b.json', parsed: asset('2026.2', 'DEPRECATED') },
  ]);
  assert.equal(picked, 'b.json');
});

test('资产选择：DRAFT 不参与回落选择（未经审核的草稿不得上线）', () => {
  // 草稿文件名排序更靠后，但**不应**被选中
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'DEPRECATED') },
    { file: 'z-draft.json', parsed: asset('2026.9', 'DRAFT') },
  ]);
  assert.equal(picked, 'a.json', 'DRAFT 不应被选中');
});

test('资产选择：ACTIVE 优先于排序更靠后的 DRAFT', () => {
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'ACTIVE') },
    { file: 'z-draft.json', parsed: asset('2026.9', 'DRAFT') },
  ]);
  assert.equal(picked, 'a.json');
});

test('资产选择：全是 DRAFT 时取最后一个并可加载（仅开发/预览）', () => {
  const picked = selectCurriculumFile([
    { file: 'a.json', parsed: asset('2026.1', 'DRAFT') },
    { file: 'b.json', parsed: asset('2026.2', 'DRAFT') },
  ]);
  assert.equal(picked, 'b.json');
});

test('资产选择：空候选必须抛错，不得静默返回空', () => {
  assert.throws(() => selectCurriculumFile([]), /No readable curriculum asset/);
});

// ---------------------------------------------------------------------------
// 目录回落（DATA_DIR 覆盖）
// ---------------------------------------------------------------------------

test('目录回落：自定义 DATA_DIR 无 knowledge 目录时用打包资产', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-data-'));
  try {
    // 模拟 seed.ts / backup.ts 的用法：DATA_DIR 只用于隔离业务数据
    process.env.DATA_DIR = tmp;
    // 重新 import 以触发模块级目录解析
    const resolved = (await import(
      `../src/infrastructure/knowledge/curriculum.ts?fresh=${Date.now()}`
    )) as typeof import('../src/infrastructure/knowledge/curriculum.ts');

    // tmp 下没有 knowledge/ → 回落打包目录 → 仍能加载到资产
    const c = resolved.getCurriculum();
    assert.ok(c.knowledgePoints.length > 0, '回落后应能加载到打包的知识资产');
    assert.equal(c.status, 'ACTIVE');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('目录回落：自定义 DATA_DIR 有 knowledge 目录时优先用之', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-data-'));
  try {
    const knowledgeDir = path.join(tmp, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(
      path.join(knowledgeDir, 'custom-2026.9.json'),
      JSON.stringify({
        version: 'custom-2026.9',
        publishedAt: '2026-01-01T00:00:00.000Z',
        status: 'ACTIVE',
        subjects: ['数学'],
        knowledgePoints: [
          {
            id: 'custom-1',
            subject: '数学',
            chapter: 'c',
            domain: 'd',
            name: 'n',
            subSkills: [],
            definition: 'x',
            prerequisites: [],
            commonExamForms: [],
            commonTraps: [],
            examWeight: 1,
            learningCostHours: 1,
          },
        ],
      }),
      'utf8'
    );

    process.env.DATA_DIR = tmp;
    const resolved = (await import(
      `../src/infrastructure/knowledge/curriculum.ts?fresh=${Date.now()}`
    )) as typeof import('../src/infrastructure/knowledge/curriculum.ts');

    const c = resolved.getCurriculum();
    assert.equal(c.version, 'custom-2026.9');
    assert.equal(c.knowledgePoints.length, 1);
    assert.equal(c.knowledgePoints[0].id, 'custom-1');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 题库版本配套
// ---------------------------------------------------------------------------

test('题库选择：优先选与知识体系版本配套的题库（而非文件名排序最后）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-data-'));
  try {
    const knowledgeDir = path.join(tmp, 'knowledge');
    const questionsDir = path.join(tmp, 'questions');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.mkdirSync(questionsDir, { recursive: true });

    // 知识体系版本：v2
    fs.writeFileSync(
      path.join(knowledgeDir, 'v2.json'),
      JSON.stringify({
        version: 'v2',
        publishedAt: '2026-01-01T00:00:00.000Z',
        status: 'ACTIVE',
        subjects: ['数学'],
        knowledgePoints: [],
      }),
      'utf8'
    );

    // 两个题库：
    //  - a-bank.json：文件名排序最后，但不配套（v1）
    //  - z-bank.json：文件名排序靠前，但配套（v2+questions）
    fs.writeFileSync(
      path.join(questionsDir, 'z-bank.json'),
      JSON.stringify({
        version: 'v2+questions',
        questions: [{ id: 'matched', stem: '配套题' }],
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(questionsDir, 'a-bank.json'),
      JSON.stringify({
        version: 'v1+questions',
        questions: [{ id: 'stale', stem: '旧版题' }],
      }),
      'utf8'
    );

    process.env.DATA_DIR = tmp;
    const resolved = (await import(
      `../src/infrastructure/knowledge/curriculum.ts?fresh=${Date.now()}`
    )) as typeof import('../src/infrastructure/knowledge/curriculum.ts');

    const bank = resolved.getQuestionBank();
    assert.equal(bank.version, 'v2+questions', '应选与知识体系配套的题库');
    assert.equal(bank.questions.length, 1);
    assert.equal(bank.questions[0].id, 'matched');
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('题库选择：无配套题库时回落到文件名排序最后者', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-data-'));
  try {
    const knowledgeDir = path.join(tmp, 'knowledge');
    const questionsDir = path.join(tmp, 'questions');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.mkdirSync(questionsDir, { recursive: true });

    fs.writeFileSync(
      path.join(knowledgeDir, 'v2.json'),
      JSON.stringify({
        version: 'v2',
        publishedAt: '2026-01-01T00:00:00.000Z',
        status: 'ACTIVE',
        subjects: ['数学'],
        knowledgePoints: [],
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(questionsDir, 'bank.json'),
      JSON.stringify({ version: 'other', questions: [{ id: 'only', stem: '唯一题' }] }),
      'utf8'
    );

    process.env.DATA_DIR = tmp;
    const resolved = (await import(
      `../src/infrastructure/knowledge/curriculum.ts?fresh=${Date.now()}`
    )) as typeof import('../src/infrastructure/knowledge/curriculum.ts');

    const bank = resolved.getQuestionBank();
    assert.equal(bank.version, 'other');
    assert.equal(bank.questions.length, 1);
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
