/**
 * PrerequisiteEngine —— 先修关系图引擎测试。
 *
 * 测试用**注入的受控小图**，而不是真实知识资产。
 *
 * 为什么不在真实资产上测：资产版本会切换（18 点的 shanghai-junior-2026.1、
 * 2760 点的 taxonomy 导入版），同一份断言的语义会随资产形状漂移 ——
 * 例如「三级链」在 18 点版里可能不存在，测试就退化成恒真。
 *
 * 注入小图后，传递闭包、根因判定、拓扑序等语义可以被**精确断言**。
 * 真实资产上的集成行为由 prerequisite-api.test.ts 覆盖。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { MasteryRecord } from '@daydayup/contracts';
import {
  analyzeAllBlocking,
  analyzeBlockingChain,
  BLOCKING_STATES,
  collectAncestors,
  MASTERED_STATES,
  resolveState,
  type PrerequisiteGraph,
} from '../src/engines/prerequisite-engine.ts';

// ---------------------------------------------------------------------------
// 受控测试图
//
//   root (小学)  ← mid (初中)  ← leaf (初三)
//        ↑                            │
//        └──────────── 也直接是 leaf 的先修 ┘  （菱形依赖）
//
// 另外一条独立链：solo ← solo-mid，用于验证「已掌握则不阻断」
// ---------------------------------------------------------------------------

function node(
  id: string,
  prerequisites: string[],
  overrides: Partial<PrerequisiteGraph[string]> = {}
): PrerequisiteGraph[string] {
  return {
    id,
    name: `知识点-${id}`,
    subject: '数学',
    chapter: `章节-${id}`,
    domain: `领域-${id}`,
    prerequisites,
    ...overrides,
  };
}

/**
 * 严格链：chain-root ← chain-mid ← chain-leaf
 * 其中 chain-mid 只有 chain-root 一个先修，chain-root 无先修。
 */
const CHAIN_GRAPH: PrerequisiteGraph = {
  'chain-root': node('chain-root', []),
  'chain-mid': node('chain-mid', ['chain-root']),
  'chain-leaf': node('chain-leaf', ['chain-mid']),
  // 菱形：leaf 同时直接依赖 root
  'diamond-leaf': node('diamond-leaf', ['chain-mid', 'chain-root']),
};

/** 两个互不相交的根，用于验证多个根因 */
const MULTI_GRAPH: PrerequisiteGraph = {
  'r1': node('r1', []),
  'r2': node('r2', []),
  'm1': node('m1', ['r1']),
  'm2': node('m2', ['r2']),
  'top': node('top', ['m1', 'm2']),
};

function rec(
  knowledgeId: string,
  state: MasteryRecord['state']
): MasteryRecord {
  return {
    knowledgeId,
    state,
    confidence: '待验证',
    lostScoreEvidence: 0,
    recoveryProbability: 0.5,
    evidenceLogs: [],
    consecutiveErrors: 0,
    practiceCorrect: 0,
    practiceTotal: 0,
    variantPassed: false,
    delayedRetestPassed: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 把图中所有节点标记为已掌握，再按需覆盖 */
function allMastered(graph: PrerequisiteGraph): Record<string, MasteryRecord> {
  const out: Record<string, MasteryRecord> = {};
  for (const id of Object.keys(graph)) out[id] = rec(id, '掌握');
  return out;
}

// ---------------------------------------------------------------------------
// 状态解析
// ---------------------------------------------------------------------------

describe('状态解析', () => {
  test('无 MasteryRecord 视为「未诊断」且未诊断过', () => {
    const r = resolveState({}, 'whatever');
    assert.equal(r.state, '未诊断');
    assert.equal(r.diagnosed, false);
  });

  test('有 MasteryRecord 时返回其状态', () => {
    const r = resolveState({ k: rec('k', '掌握') }, 'k');
    assert.equal(r.state, '掌握');
    assert.equal(r.diagnosed, true);
  });

  test('阻断状态与已掌握状态互不相交', () => {
    for (const s of BLOCKING_STATES) {
      assert.ok(!MASTERED_STATES.includes(s), `${s} 不应同时是阻断态和掌握态`);
    }
  });
});

// ---------------------------------------------------------------------------
// 祖先闭包（传递性）
// ---------------------------------------------------------------------------

describe('祖先闭包', () => {
  test('包含全部间接先修，不只是直接先修', () => {
    const ids = collectAncestors('chain-leaf', {}, CHAIN_GRAPH).map(
      (n) => n.knowledgeId
    );
    assert.ok(ids.includes('chain-leaf'), '应包含目标自身');
    assert.ok(ids.includes('chain-mid'), '应包含直接先修');
    assert.ok(ids.includes('chain-root'), '应包含**间接**先修');
  });

  test('distance：目标 0、直接先修 1、间接先修 2', () => {
    const byId = new Map(
      collectAncestors('chain-leaf', {}, CHAIN_GRAPH).map((n) => [n.knowledgeId, n])
    );
    assert.equal(byId.get('chain-leaf')?.distance, 0);
    assert.equal(byId.get('chain-mid')?.distance, 1);
    assert.equal(byId.get('chain-root')?.distance, 2);
  });

  test('distance 取**最短**路径（菱形依赖时 root 距离为 1）', () => {
    const byId = new Map(
      collectAncestors('diamond-leaf', {}, CHAIN_GRAPH).map((n) => [n.knowledgeId, n])
    );
    // diamond-leaf 直接依赖 chain-root，所以是 1 而不是 2
    assert.equal(byId.get('chain-root')?.distance, 1);
  });

  test('拓扑序：先修必在被依赖者之前', () => {
    const nodes = collectAncestors('chain-leaf', {}, CHAIN_GRAPH);
    const index = new Map(nodes.map((n, i) => [n.knowledgeId, i]));
    for (const n of nodes) {
      for (const pre of n.prerequisites) {
        if (!index.has(pre)) continue;
        assert.ok(
          index.get(pre)! < index.get(n.knowledgeId)!,
          `先修 ${pre} 必须排在 ${n.knowledgeId} 之前`
        );
      }
    }
    // 具体顺序：root → mid → leaf
    assert.deepEqual(
      nodes.map((n) => n.knowledgeId),
      ['chain-root', 'chain-mid', 'chain-leaf']
    );
  });

  test('拓扑序稳定可复现', () => {
    const a = collectAncestors('chain-leaf', {}, CHAIN_GRAPH).map((n) => n.knowledgeId);
    const b = collectAncestors('chain-leaf', {}, CHAIN_GRAPH).map((n) => n.knowledgeId);
    assert.deepEqual(a, b);
  });

  test('未知知识点返回空集合而非抛错', () => {
    assert.deepEqual(collectAncestors('__nope__', {}, CHAIN_GRAPH), []);
  });

  test('图有环时不挂死（环保护生效）', () => {
    const cyclic: PrerequisiteGraph = {
      a: node('a', ['b']),
      b: node('b', ['a']),
    };
    const nodes = collectAncestors('a', {}, cyclic);
    const ids = nodes.map((n) => n.knowledgeId);
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });
});

// ---------------------------------------------------------------------------
// 根因判定
// ---------------------------------------------------------------------------

describe('阻断根因判定', () => {
  test('全链已掌握 → 无阻断、无根因', () => {
    const chain = analyzeBlockingChain(
      'chain-leaf',
      allMastered(CHAIN_GRAPH),
      CHAIN_GRAPH
    );
    assert.equal(chain.hasBlocking, false);
    assert.equal(chain.rootCauses.length, 0);
    assert.equal(chain.learningPath.length, 0);
  });

  test('中间层未掌握、底层已掌握 → 根因是中间层', () => {
    const records = allMastered(CHAIN_GRAPH);
    records['chain-mid'] = rec('chain-mid', '待学习');

    const chain = analyzeBlockingChain('chain-leaf', records, CHAIN_GRAPH);
    assert.equal(chain.hasBlocking, true);
    assert.deepEqual(
      chain.rootCauses.map((r) => r.knowledgeId),
      ['chain-mid'],
      '根因应恰为中间层'
    );
  });

  test('底层未掌握 → 根因**回溯**到最底层，而非中间层', () => {
    const records = allMastered(CHAIN_GRAPH);
    records['chain-mid'] = rec('chain-mid', '学习中');
    records['chain-root'] = rec('chain-root', '待学习');

    const chain = analyzeBlockingChain('chain-leaf', records, CHAIN_GRAPH);
    assert.deepEqual(
      chain.rootCauses.map((r) => r.knowledgeId),
      ['chain-root'],
      '中间层的先修未掌握，真正的缺口在最底层'
    );
  });

  test('根因不含目标自身', () => {
    const chain = analyzeBlockingChain('chain-leaf', {}, CHAIN_GRAPH);
    assert.ok(
      !chain.rootCauses.some((r) => r.knowledgeId === 'chain-leaf'),
      '目标自身不算根因'
    );
  });

  test('根因路径首尾正确（根因 → … → 目标）', () => {
    const chain = analyzeBlockingChain('chain-leaf', {}, CHAIN_GRAPH);
    const root = chain.rootCauses.find((r) => r.knowledgeId === 'chain-root');
    assert.ok(root, '应有 chain-root 根因');
    assert.equal(root.path[0], 'chain-root');
    assert.equal(root.path[root.path.length - 1], 'chain-leaf');
    assert.deepEqual(root.path, ['chain-root', 'chain-mid', 'chain-leaf']);
  });

  test('多个独立缺口 → 多个根因', () => {
    const chain = analyzeBlockingChain('top', {}, MULTI_GRAPH);
    const ids = chain.rootCauses.map((r) => r.knowledgeId).sort();
    assert.deepEqual(ids, ['r1', 'r2'], '两条链的底层都未掌握，应各报一个根因');
  });

  test('已掌握的分支不产生根因', () => {
    const records = allMastered(MULTI_GRAPH);
    records['m1'] = rec('m1', '待学习'); // r1 仍已掌握
    const chain = analyzeBlockingChain('top', records, MULTI_GRAPH);
    assert.deepEqual(
      chain.rootCauses.map((r) => r.knowledgeId),
      ['m1']
    );
  });

  test('学习路径含根因与目标，且按拓扑序', () => {
    const chain = analyzeBlockingChain('chain-leaf', {}, CHAIN_GRAPH);
    const ids = chain.learningPath.map((n) => n.knowledgeId);
    assert.deepEqual(ids, ['chain-root', 'chain-mid', 'chain-leaf']);

    const index = new Map(ids.map((id, i) => [id, i]));
    for (const n of chain.learningPath) {
      for (const pre of n.prerequisites) {
        if (!index.has(pre)) continue;
        assert.ok(index.get(pre)! < index.get(n.knowledgeId)!);
      }
    }
  });

  test('未知知识点返回空链', () => {
    const chain = analyzeBlockingChain('__nope__', {}, CHAIN_GRAPH);
    assert.equal(chain.hasBlocking, false);
    assert.equal(chain.rootCauses.length, 0);
    assert.equal(chain.learningPath.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 批量分析
// ---------------------------------------------------------------------------

describe('批量阻断分析', () => {
  test('统计口径自洽', () => {
    const s = analyzeAllBlocking({}, undefined, CHAIN_GRAPH);
    assert.equal(s.stats.totalKnowledgePoints, 4);
    assert.equal(s.stats.diagnosedCount, 0);
    assert.equal(
      s.stats.blockedTargetCount,
      new Set(s.blockedTargets.map((b) => b.knowledgeId)).size
    );
    assert.equal(s.stats.rootCauseCount, s.rootCauses.length);
  });

  test('无诊断时所有有先修的点都被判为阻断', () => {
    const s = analyzeAllBlocking({}, undefined, CHAIN_GRAPH);
    assert.ok(s.stats.blockedTargetCount > 0);
    assert.ok(s.rootCauses.some((r) => r.knowledgeId === 'chain-root'));
  });

  test('根因按阻断目标数降序', () => {
    const s = analyzeAllBlocking({}, undefined, MULTI_GRAPH);
    for (let i = 1; i < s.rootCauses.length; i++) {
      assert.ok(
        s.rootCauses[i - 1].blockingCount >= s.rootCauses[i].blockingCount
      );
    }
  });

  test('全部掌握后阻断归零', () => {
    const s = analyzeAllBlocking(
      allMastered(CHAIN_GRAPH),
      undefined,
      CHAIN_GRAPH
    );
    assert.equal(s.stats.blockedTargetCount, 0);
    assert.equal(s.stats.rootCauseCount, 0);
    assert.equal(s.stats.diagnosedCount, 4);
  });

  test('limit 只限制分析范围，不改变总资产统计', () => {
    const limited = analyzeAllBlocking({}, 2, CHAIN_GRAPH);
    const full = analyzeAllBlocking({}, undefined, CHAIN_GRAPH);
    assert.equal(limited.stats.totalKnowledgePoints, full.stats.totalKnowledgePoints);
    assert.ok(limited.blockedTargets.length <= full.blockedTargets.length);
  });

  test('maxDepth 反映最深阻断链', () => {
    const s = analyzeAllBlocking({}, undefined, CHAIN_GRAPH);
    assert.ok(s.stats.maxDepth >= 2, `最深链应 ≥2 层，实际 ${s.stats.maxDepth}`);
  });
});
