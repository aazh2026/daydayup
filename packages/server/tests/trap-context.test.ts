/**
 * 出题/教练场景的错因兜底（服务端）单元测试。
 *
 * 覆盖重点：
 *  - 前端没传 commonTraps 时，服务端能从错因资产层补出来
 *  - 题目级 commonErrors（题库）能进兜底结果
 *  - 前端传的排前面，服务端补的排后面，且去重
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getKnowledgeTraps,
  getQuestionTraps,
  mergeTraps,
} from '../src/infrastructure/knowledge/trap-context.ts';
import { getCurriculum, getQuestionBank } from '../src/infrastructure/knowledge/curriculum.ts';

test('trap-context：知识点错因可按 id 取出', () => {
  const cur = getCurriculum();
  const kp = cur.knowledgePoints.find((k) => (k.commonTraps ?? []).length > 0);
  if (!kp) return; // 没有错因资产时跳过

  const traps = getKnowledgeTraps(kp.id);
  assert.deepEqual(traps, kp.commonTraps);
});

test('trap-context：未知知识点 id 返回空数组', () => {
  assert.deepEqual(getKnowledgeTraps('不存在的知识点'), []);
  assert.deepEqual(getKnowledgeTraps(null), []);
  assert.deepEqual(getKnowledgeTraps(undefined), []);
});

test('trap-context：题目级错因按知识点取得到', () => {
  const bank = getQuestionBank();
  const q = bank.questions.find((x) => (x.commonErrors ?? []).length > 0);
  if (!q) return; // 题库无题目级错因时跳过

  const traps = getQuestionTraps((q.knowledgeIds ?? [])[0]);
  assert.ok(traps.length > 0, '应取到题目级错因');
  for (const t of traps) {
    assert.ok(q.commonErrors.includes(t));
  }
});

test('trap-context：mergeTraps 前端在前、服务端补在后且去重', () => {
  const cur = getCurriculum();
  const kp = cur.knowledgePoints.find((k) => (k.commonTraps ?? []).length > 0);
  if (!kp) return;

  const serverTrap = kp.commonTraps![0];
  const merged = mergeTraps([serverTrap, '前端自带的陷阱'], kp.id);
  assert.equal(merged[0], serverTrap, '前端传的排最前');
  assert.ok(merged.includes('前端自带的陷阱'));
  assert.equal(new Set(merged).size, merged.length, '不应有重复');
});

test('trap-context：前端完全不传也能兜底出知识点错因', () => {
  const cur = getCurriculum();
  const kp = cur.knowledgePoints.find((k) => (k.commonTraps ?? []).length > 0);
  if (!kp) return;

  const merged = mergeTraps([], kp.id);
  assert.ok(merged.length > 0, '服务端应能兜底补出错因');
  assert.ok(merged.includes(kp.commonTraps![0]));
});
