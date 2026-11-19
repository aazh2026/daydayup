/**
 * 三态自适应诊断引擎测试。
 *
 * 守护的三条语义：
 *
 * 1. **确认题才判掌握**：连对不足 confirm 题不算掌握；
 * 2. **错过之后降难度**：答错后的确认题优先更简单的题，
 *    不是随机换一道；
 * 3. **可复现**：同 seed + 同资产 → 同出题顺序，
 *    否则诊断结果无法重放，刷新页面就丢结论。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosticGraph,
  createSession,
  applyAnswer,
  nextItem,
  replay,
  statusOf,
  summarize,
  isUnconfirmed,
  levelToDifficulty,
  clampConfirm,
  normalizeConfirm,
  needConfirm,
  type DiagnosticGraph,
} from '../src/engines/diagnosis-engine.ts';

function makeGraph(): DiagnosticGraph {
  return buildDiagnosticGraph({
    knowledgePoints: [
      { id: 'cnm_p001', name: '整数', subject: '数学' },
      { id: 'cnm_p002', name: '分数', subject: '数学', prerequisites: ['cnm_p001'] },
      { id: 'cnm_p003', name: '小数', subject: '数学', prerequisites: ['cnm_p001'] },
    ],
    questions: [
      {
        id: 'cnm_p001_q1',
        level: '基础题',
        questionType: '选择',
        stem: '1+1=?',
        standardAnswer: '2',
        knowledgeIds: ['cnm_p001'],
      },
      {
        id: 'cnm_p001_q2',
        level: '变式题',
        questionType: '选择',
        stem: '1+2=?',
        standardAnswer: '3',
        knowledgeIds: ['cnm_p001'],
      },
      {
        id: 'cnm_p001_q3',
        level: '迁移题',
        questionType: '选择',
        stem: '1+3=?',
        standardAnswer: '4',
        knowledgeIds: ['cnm_p001'],
      },
      {
        id: 'cnm_p002_q1',
        level: '基础题',
        questionType: '选择',
        stem: '1/2+1/2=?',
        standardAnswer: '1',
        knowledgeIds: ['cnm_p002'],
      },
    ],
  });
}

test('难度映射：基础/变式/迁移 → basic/standard/challenge', () => {
  assert.equal(levelToDifficulty('基础题'), 'basic');
  assert.equal(levelToDifficulty('变式题'), 'standard');
  assert.equal(levelToDifficulty('迁移题'), 'challenge');
  assert.equal(levelToDifficulty('基础练习'), 'basic');
});

test('确认题数：界面只允许 2/3/5，引擎内部 1..10', () => {
  assert.equal(clampConfirm(2), 2);
  assert.equal(clampConfirm(3), 3);
  assert.equal(clampConfirm(5), 5);
  assert.equal(clampConfirm(4), 3, '非法值回落到默认 3');
  assert.equal(normalizeConfirm(1), 1, '引擎内部允许 1（测试用）');
  assert.equal(normalizeConfirm(11), 3);
});

test('掌握所需题数 = min(confirm, 该点题量)，至少 1', () => {
  const graph = makeGraph();
  const s = createSession(graph, ['cnm_p001'], { confirm: 3 });
  assert.equal(needConfirm(graph, s, 'cnm_p001'), 3, 'cnm_p001 有 3 题');
  const s2 = createSession(graph, ['cnm_p002'], { confirm: 3 });
  assert.equal(needConfirm(graph, s2, 'cnm_p002'), 1, 'cnm_p002 只有 1 题 → 1 题即算掌握');
});

test('连续答对未满 confirm → 仍无结论', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 3, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: 'cnm_p001_q1' });
  assert.equal(statusOf(s, 'cnm_p001'), 'unknown');
  s = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: 'cnm_p001_q2' });
  assert.equal(statusOf(s, 'cnm_p001'), 'unknown');
  s = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: 'cnm_p001_q3' });
  assert.equal(statusOf(s, 'cnm_p001'), 'mastered');
});

test('错过之后确认题答对 → shaky（会但不稳）', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 2, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: 'cnm_p001_q2' });
  // 第一次错：引擎不给结论，等确认题；但 statusOf 对「答错过却未确认」按 weak 计
  // （与 cn-mt 语义一致），区分「已确认薄弱」靠 isUnconfirmed。
  assert.equal(statusOf(s, 'cnm_p001'), 'weak');
  assert.equal(isUnconfirmed(s, 'cnm_p001'), true, '尚未确认');
  s = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: 'cnm_p001_q1' });
  assert.equal(statusOf(s, 'cnm_p001'), 'shaky');
});

test('确认题仍错 → weak', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 2, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: 'cnm_p001_q2' });
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: 'cnm_p001_q1' });
  assert.equal(statusOf(s, 'cnm_p001'), 'weak');
});

test('错过之后确认题优先更简单的题', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 2, limit: 10 });
  const first = nextItem(graph, s);
  assert.ok(first);
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: first.question.id });
  const next = nextItem(graph, s);
  assert.ok(next);
  assert.equal(
    levelToDifficulty(next.question.level),
    'basic',
    `答错后应降难度，实际 ${next.question.level}`
  );
});

test('答对未错过时优先出更难的题（challenge 优先）', () => {
  const graph = makeGraph();
  const s = createSession(graph, ['cnm_p001'], { confirm: 3, limit: 10 });
  const first = nextItem(graph, s);
  assert.ok(first);
  // 第一题优先 standard（变式）
  assert.equal(levelToDifficulty(first.question.level), 'standard');
  const s2 = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: first.question.id });
  const second = nextItem(graph, s2);
  assert.ok(second);
  assert.equal(levelToDifficulty(second.question.level), 'challenge');
});

test('掌握目标会推断祖先为掌握（inferred）', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p002'], { confirm: 1, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p002', 'correct', { qid: 'cnm_p002_q1' });
  assert.equal(statusOf(s, 'cnm_p002'), 'mastered');
  assert.equal(
    statusOf(s, 'cnm_p001'),
    'mastered',
    'cnm_p002 的先修 cnm_p001 应被推断为掌握'
  );
});

test('screen 模式只沿 hard 先修推断，且不把祖先并入范围', () => {
  const graph = buildDiagnosticGraph({
    knowledgePoints: [
      { id: 'cnm_p001', name: '整数', subject: '数学' },
      { id: 'cnm_p002', name: '分数', subject: '数学', prerequisites: ['cnm_p001'] },
    ],
    questions: [
      {
        id: 'cnm_p002_q1',
        level: '基础题',
        questionType: '选择',
        stem: '1/2+1/2=?',
        standardAnswer: '1',
        knowledgeIds: ['cnm_p002'],
      },
    ],
    prerequisiteStrength: { 'cnm_p002<cnm_p001': 'soft' },
  });
  let s = createSession(graph, ['cnm_p002'], { confirm: 1, mode: 'screen', limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p002', 'correct', { qid: 'cnm_p002_q1' });
  assert.equal(statusOf(s, 'cnm_p002'), 'mastered');
  assert.equal(
    statusOf(s, 'cnm_p001'),
    'unknown',
    'screen 模式沿 soft 先修不推断祖先'
  );
  const summary = summarize(graph, s);
  // screen 模式的汇总范围只有目标集本身，先修不在范围内
  assert.deepEqual(summary.untested, []);
});

test('薄弱时把先修压到出题栈顶（回溯补强）', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p002'], { confirm: 1, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p002', 'wrong', { qid: 'cnm_p002_q1' });
  assert.equal(statusOf(s, 'cnm_p002'), 'weak');
  // cnm_p002 的先修 cnm_p001 应被压到栈顶并可测
  const next = nextItem(graph, s);
  assert.ok(next);
  assert.equal(next.knowledgeId, 'cnm_p001', '应先补先修 cnm_p001');
});

test('可复现：同 seed 给出同样的题序', () => {
  const graph = makeGraph();
  const a = createSession(graph, ['cnm_p001'], { seed: 'seed-1', limit: 10 });
  const b = createSession(graph, ['cnm_p001'], { seed: 'seed-1', limit: 10 });
  assert.equal(nextItem(graph, a)?.question.id, nextItem(graph, b)?.question.id);
  const c = createSession(graph, ['cnm_p001'], { seed: 'seed-2', limit: 10 });
  // 不同 seed 也不必不同（题少时可能相同），但不能抛错
  assert.ok(nextItem(graph, c));
});

test('replay：由作答流水重建会话，结论一致', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 2, limit: 10, seed: 'x' });
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: 'cnm_p001_q2' });
  s = applyAnswer(graph, s, 'cnm_p001', 'correct', { qid: 'cnm_p001_q1' });

  const rebuilt = replay(
    graph,
    ['cnm_p001'],
    [
      { knowledgeId: 'cnm_p001', qid: 'cnm_p001_q2', result: 'wrong' },
      { knowledgeId: 'cnm_p001', qid: 'cnm_p001_q1', result: 'correct' },
    ],
    { confirm: 2, limit: 10, seed: 'x' }
  );
  assert.equal(statusOf(rebuilt, 'cnm_p001'), statusOf(s, 'cnm_p001'));
  assert.equal(statusOf(rebuilt, 'cnm_p001'), 'shaky');
});

test('汇总：分四类并给出回溯建议', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p002'], { confirm: 1, limit: 10 });
  s = applyAnswer(graph, s, 'cnm_p002', 'wrong', { qid: 'cnm_p002_q1' });
  const summary = summarize(graph, s);
  assert.deepEqual(summary.weak, ['cnm_p002']);
  assert.equal(summary.backtrack[0]?.knowledgeId, 'cnm_p001');
  assert.ok((summary.backtrack[0]?.dependedBy ?? 0) >= 1);
});

test('答错但题量用完 → 视为 weak（未确认）', () => {
  const graph = makeGraph();
  let s = createSession(graph, ['cnm_p001'], { confirm: 3, limit: 1 });
  s = applyAnswer(graph, s, 'cnm_p001', 'wrong', { qid: 'cnm_p001_q1' });
  // 答错过但还没出确认题 → 按 weak 计（isUnconfirmed 可区分）
  assert.equal(statusOf(s, 'cnm_p001'), 'weak');
  assert.equal(isUnconfirmed(s, 'cnm_p001'), true);
});
