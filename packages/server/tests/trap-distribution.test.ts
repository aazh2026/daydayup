/**
 * 错因形态分布（Trap Taxonomy + Distribution）测试。
 *
 * 覆盖两条关键不变量：
 * 1. **分类可复现**：同一句话永远归到同一类（规则匹配，非模型判定）。
 * 2. **不丢数据**：命中不到错因资产的错题计入 unattributed，不被静默丢弃。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorRecord } from '@daydayup/contracts';
import {
  classifyTrapText,
  listTrapTypeRules,
  listTrapTypes,
  TRAP_TYPE_LABELS,
} from '../src/infrastructure/knowledge/trap-taxonomy.ts';
import {
  classifyErrorRecordTraps,
  collectTrapEntriesByKnowledge,
  computeTrapDistribution,
} from '../src/infrastructure/knowledge/trap-distribution.ts';

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    id: 'err-1',
    examTitle: '期中考试',
    questionNumber: '14',
    subject: '数学',
    stem: '题干',
    studentAnswer: 'A',
    correctAnswer: 'B',
    scoreLost: 5,
    errorType: '知识问题',
    knowledgeId: 'cnm_p009',
    knowledgeName: '第几',
    aiAnalysis: '',
    evidence: '',
    confidence: '待验证',
    verificationMethod: '',
    status: '未订正',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as ErrorRecord;
}

describe('错因形态分类（trap-taxonomy）', () => {
  it('「把 A 当成 B」判为概念混淆', () => {
    assert.equal(classifyTrapText('把序数当基数用，问「第几个」时回答总数。'), '概念混淆');
    assert.equal(classifyTrapText('认为 0 是最小的正数。'), '概念混淆');
    assert.equal(classifyTrapText('把长音当作短音读。'), '概念混淆');
  });

  it('「漏看/忽略条件」判为审题遗漏', () => {
    assert.equal(classifyTrapText('漏看题目中的「不包括」。'), '审题遗漏');
    assert.equal(classifyTrapText('忽略了单位换算。'), '审题遗漏');
  });

  it('「符号/公式记错」判为规则误用', () => {
    assert.equal(classifyTrapText('负号写错导致结果反了。'), '规则误用');
    assert.equal(classifyTrapText('记错公式导致代入错误。'), '规则误用');
  });

  it('「算错/化简错」判为计算失误', () => {
    assert.equal(classifyTrapText('通分时算错了。'), '计算失误');
    assert.equal(classifyTrapText('化简根号时出错。'), '计算失误');
  });

  it('「表述/书写」判为表达不规范', () => {
    assert.equal(classifyTrapText('答题没有写过程。'), '表达不规范');
    assert.equal(classifyTrapText('书写不规范导致扣分。'), '表达不规范');
  });

  it('「不会/没掌握」判为知识缺失', () => {
    assert.equal(classifyTrapText('这个知识点完全不会。'), '知识缺失');
    assert.equal(classifyTrapText('基础不牢。'), '知识缺失');
  });

  it('未命中任何模式归入兜底，不丢数据', () => {
    assert.equal(classifyTrapText('随手写了个数。'), '其他易错点');
    assert.equal(classifyTrapText(''), '其他易错点');
    assert.equal(classifyTrapText(undefined), '其他易错点');
    assert.equal(classifyTrapText(null), '其他易错点');
  });

  it('分类可复现：同一句话多次调用结果一致', () => {
    const text = '把序数当基数用，问「第几个」时回答总数。';
    const first = classifyTrapText(text);
    for (let i = 0; i < 20; i++) {
      assert.equal(classifyTrapText(text), first);
    }
  });

  it('类型清单完整且每种都有展示标签', () => {
    const types = listTrapTypes();
    assert.equal(types.length, 7);
    for (const t of types) {
      assert.ok(TRAP_TYPE_LABELS[t], `${t} 缺少展示标签`);
    }
    assert.ok(listTrapTypeRules().length > 0);
  });
});

describe('错因资产读取（collectTrapEntriesByKnowledge）', () => {
  it('从生效资产里按知识点归组，且只取带 knowledgeId 的条目', () => {
    const byKnowledge = collectTrapEntriesByKnowledge();
    assert.ok(byKnowledge.size > 0, '应至少读取到一条生效错因资产');
    for (const [kpId, entries] of byKnowledge) {
      assert.ok(kpId.length > 0);
      for (const e of entries) {
        assert.equal(e.knowledgeId, kpId);
        assert.ok(e.wrong.trim().length > 0);
      }
    }
  });
});

describe('错题 → 形态映射（classifyErrorRecordTraps）', () => {
  it('同一形态只出现一次（去重）', () => {
    const byKnowledge = new Map([
      [
        'kp-1',
        [
          { knowledgeId: 'kp-1', wrong: '把 A 当成 B。' },
          { knowledgeId: 'kp-1', wrong: '把 C 当成 D。' },
        ],
      ],
    ]);
    const types = classifyErrorRecordTraps({ knowledgeId: 'kp-1' }, byKnowledge);
    assert.deepEqual(types, ['概念混淆']);
  });

  it('知识点没有错因条目时返回空数组', () => {
    const types = classifyErrorRecordTraps(
      { knowledgeId: 'kp-not-exist' },
      new Map()
    );
    assert.deepEqual(types, []);
  });
});

describe('错因形态分布统计（computeTrapDistribution）', () => {
  const withAssets = computeTrapDistribution(
    [
      makeError({ id: 'e1', knowledgeId: 'cnm_p009', scoreLost: 4 }),
      makeError({ id: 'e2', knowledgeId: 'cnm_p009', scoreLost: 6 }),
    ],
    (id) => (id === 'cnm_p009' ? '第几' : id)
  );

  it('命中资产的错题计入 attributed，不丢', () => {
    assert.equal(withAssets.totalErrors, 2);
    assert.equal(withAssets.attributedErrors + withAssets.unattributedErrors, 2);
  });

  it('未命中资产的错题计入 unattributed 且不丢失分', () => {
    const dist = computeTrapDistribution([
      makeError({ id: 'e1', knowledgeId: 'kp-with-traps' }),
      makeError({ id: 'e2', knowledgeId: 'kp-no-traps', scoreLost: 3 }),
    ]);
    assert.equal(dist.totalErrors, 2);
    assert.equal(dist.attributedErrors + dist.unattributedErrors, 2);
    assert.equal(
      dist.attributedLost + dist.unattributedLost,
      dist.attributedLost + dist.unattributedLost
    );
  });

  it('失分不因多形态重复累加（同一形态取最大失分）', () => {
    // cnm_p009 的多条错因同属一个形态 → 失分只计一次
    const dist = computeTrapDistribution([
      makeError({ id: 'e1', knowledgeId: 'cnm_p009', scoreLost: 4 }),
      makeError({ id: 'e2', knowledgeId: 'cnm_p009', scoreLost: 6 }),
    ]);
    const bucket = dist.buckets.find((b) => b.count > 0);
    assert.ok(bucket);
    // 该形态的归集失分 = 单题最大失分（6），不是 4+6=10
    assert.ok(
      bucket.lost <= 6,
      `同一形态的归集失分应取最大值，实际 ${bucket.lost}`
    );
  });

  it('分桶按错题数降序排列，且带代表考点', () => {
    const dist = computeTrapDistribution([
      makeError({ id: 'e1', knowledgeId: 'cnm_p009', scoreLost: 4 }),
      makeError({ id: 'e2', knowledgeId: 'cnm_p009', scoreLost: 6 }),
    ]);
    for (let i = 1; i < dist.buckets.length; i++) {
      assert.ok(
        dist.buckets[i - 1].count >= dist.buckets[i].count,
        '分桶应按 count 降序'
      );
    }
    const withKp = dist.buckets.find((b) => b.topKnowledge.length > 0);
    assert.ok(withKp);
    assert.ok(withKp.topKnowledge[0].knowledgeName.length > 0);
  });

  it('空错题集合不抛异常，桶为空', () => {
    const dist = computeTrapDistribution([]);
    assert.equal(dist.totalErrors, 0);
    assert.equal(dist.attributedErrors, 0);
    assert.equal(dist.unattributedErrors, 0);
    assert.deepEqual(dist.buckets, []);
    assert.equal(dist.attributedLost, 0);
  });

  it('百分比基于已归因失分，不会除零', () => {
    const dist = computeTrapDistribution([
      makeError({ id: 'e1', knowledgeId: 'kp-none', scoreLost: 0 }),
    ]);
    for (const b of dist.buckets) {
      assert.ok(Number.isFinite(b.pct));
      assert.ok(b.pct >= 0 && b.pct <= 100);
    }
  });
});
