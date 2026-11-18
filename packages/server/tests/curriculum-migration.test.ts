/**
 * 迁移映射表与当前资产的一致性。
 *
 * 为什么需要：`LEGACY_ID_MAP` 是换版时一次性写下的对照表。
 * 知识资产再换一版（或有人改了映射），映射就可能指向不存在的知识点 ——
 * 迁移脚本会在运行时发现并退出 1，但那已经是运维现场了。
 * 这条测试把问题提前到 CI。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_ID_MAP } from '../scripts/migrate-curriculum.ts';
import { getKnowledgeMap } from '../src/infrastructure/knowledge/curriculum.ts';

describe('课程资产迁移映射表', () => {
  test('每个旧 id 都映射到当前资产里真实存在的知识点', () => {
    const map = getKnowledgeMap();
    const missing = Object.entries(LEGACY_ID_MAP)
      .filter(([, target]) => !map[target])
      .map(([from, target]) => `${from} → ${target}`);

    assert.deepEqual(
      missing,
      [],
      '映射目标不在当前资产中，迁移会写出悬空引用：\n' + missing.join('\n')
    );
  });

  test('映射目标互不重复（否则两条历史数据会被合并成一个知识点）', () => {
    const targets = Object.values(LEGACY_ID_MAP);
    const dupes = targets.filter((t, i) => targets.indexOf(t) !== i);
    assert.deepEqual(dupes, [], `映射目标重复：${dupes.join(', ')}`);
  });

  test('映射源本身不是新资产里的 id（否则说明映射表已过期）', () => {
    const map = getKnowledgeMap();
    for (const from of Object.keys(LEGACY_ID_MAP)) {
      assert.ok(
        !map[from],
        `旧 id ${from} 竟存在于当前资产中，映射表可能已过期`
      );
    }
  });
});
