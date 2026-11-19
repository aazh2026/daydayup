/**
 * 错因证据匹配（资产为中心）单元测试。
 *
 * 覆盖重点：
 *  - 证据分级：name==title / name-in-title / name-in-body / keyword-overlap /
 *    name-token-weak / soft-in-item 各自的分值与置信度
 *  - 硬门槛：册次、章号、节号、学科、学段不一致时**不匹配**
 *  - 分配规则：每个知识点只取分数最高的来源主题；不做 1:1 唯一分配
 *  - 红线：匹配只搬运来源原文，不改写、不生成任何易错内容
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignEvidence,
  buildTopicBody,
  EVIDENCE_HIGH,
  EVIDENCE_MEDIUM,
  normalizeBody,
  scoreEvidence,
  type EvidenceAsset,
  type EvidenceTopic,
} from '../src/infrastructure/knowledge/trap-evidence.ts';
import type { TrapCandidate } from '../src/infrastructure/knowledge/converters/traps.ts';
import { cstTextbookVolumes } from '../src/infrastructure/knowledge/converters/traps.ts';
import { namePhrases } from '../src/infrastructure/knowledge/trap-text.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function asset(over: Partial<EvidenceAsset> = {}): EvidenceAsset {
  return {
    id: 'cnm_001',
    name: '全等三角形',
    subject: '数学',
    stage: '初中',
    scope: { volume: '八上', chapter: '11', section: '11.1' },
    ...over,
  };
}

function candidate(id: string, wrong: string): TrapCandidate {
  return {
    id,
    sourceRepo: 'junior-math-atlas',
    sourceId: 'm1-00-05',
    subject: '数学',
    stage: '初中',
    wrong,
    why: '源文本原因',
    right: '源文本正解',
    sourceText: wrong,
  };
}

function topic(over: Partial<EvidenceTopic> = {}): EvidenceTopic {
  return {
    id: 'atlas:1',
    repo: 'junior-math-atlas',
    title: '全等三角形',
    subject: '数学',
    stage: '初中',
    keywords: [],
    body: '',
    scope: { volume: '八上', chapter: '11' },
    items: [candidate('atlas:1#p1', '源文本错误做法')],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 证据分级
// ---------------------------------------------------------------------------

test('name==title 是最强证据（100 / high）', () => {
  const s = scoreEvidence(asset(), topic());
  assert.ok(s);
  assert.equal(s.reason, 'name==title');
  assert.equal(s.score, 100);
  assert.ok(s.score >= EVIDENCE_HIGH);
});

test('name-in-title 次之（90 / high）', () => {
  const s = scoreEvidence(
    asset({ name: '有理数的加法' }),
    topic({ title: '有理数的加法与减法' })
  );
  assert.ok(s);
  assert.equal(s.reason, 'name-in-title');
  assert.equal(s.score, 90);
});

test('name-in-body 命中正文即为 high（88）', () => {
  const s = scoreEvidence(
    asset({ name: '销售利润' }),
    topic({
      title: '一元二次方程的应用',
      body: buildTopicBody('本节讲销售利润与增长率的实际问题'),
    })
  );
  assert.ok(s);
  assert.equal(s.reason, 'name-in-body');
  assert.equal(s.score, 88);
});

test('keyword-overlap 只能到 medium', () => {
  const s = scoreEvidence(
    asset({ name: '一元二次方程根与系数的关系' }),
    topic({ title: '一元二次方程的解法', keywords: ['一元二次方程根的判别'] })
  );
  assert.ok(s);
  assert.equal(s.reason, 'keyword-overlap');
  assert.ok(s.score < EVIDENCE_HIGH);
  assert.ok(s.score >= EVIDENCE_MEDIUM);
});

test('只命中两字碎词时是 name-token-weak（40 / medium）', () => {
  const s = scoreEvidence(
    asset({ name: '线段的比较与运算' }),
    topic({ title: '直线射线线段', keywords: [] })
  );
  assert.ok(s);
  assert.equal(s.reason, 'name-token-weak');
  assert.ok(s.score < EVIDENCE_HIGH);
});

test('子技能短语命中条目时是 soft-in-item（30 / medium）', () => {
  const s = scoreEvidence(
    asset({ name: '甲乙丙丁戊己', subSkills: ['柱锥组合体'] }),
    topic({
      title: '壬癸子丑寅卯',
      body: '',
      items: [candidate('atlas:9#p1', '柱锥组合体表面积算错')],
    })
  );
  assert.ok(s);
  assert.equal(s.reason, 'soft-in-item');
  assert.equal(s.score, 30);
});

test('STOP 词不出现在正文时不算证据', () => {
  // 「数量关系」里的通用词说明不了任何事
  const s = scoreEvidence(
    asset({ name: '数量的计算' }),
    topic({ title: '完全无关的主题', body: buildTopicBody('数量关系与数量变化') })
  );
  assert.equal(s, null);
});

test('知识点名本身不被 STOP 词误杀（相反数 / 绝对值）', () => {
  const s = scoreEvidence(
    asset({ name: '相反数的意义' }),
    topic({ title: '正数与负数', body: buildTopicBody('相反数表示相反意义的量') })
  );
  assert.ok(s);
  assert.equal(s.reason, 'name-in-body');
  assert.equal(s.score, 88);
});

// ---------------------------------------------------------------------------
// 硬门槛
// ---------------------------------------------------------------------------

test('册次不一致 → 不匹配', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '七上', chapter: '1' } })],
    [topic({ scope: { volume: '八上', chapter: '1' } })]
  );
  assert.equal(result.assignments.length, 0);
  assert.deepEqual(result.unmatchedAssetIds, ['cnm_001']);
});

test('章号不一致 → 不匹配', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '七上', chapter: '2' } })],
    [topic({ scope: { volume: '七上', chapter: '1' } })]
  );
  assert.equal(result.assignments.length, 0);
});

test('节号不相交 → 不匹配', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '七上', chapter: '1', section: '1.2' } })],
    [topic({ scope: { volume: '七上', chapter: '1', sections: ['3.1'] } })]
  );
  assert.equal(result.assignments.length, 0);
});

test('知识点无节号时放行', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '七上', chapter: '1' } })],
    [topic({ scope: { volume: '七上', chapter: '1', sections: ['3.1'] } })]
  );
  assert.equal(result.assignments.length, 1);
});

test('学科 / 学段不一致 → 该来源主题被排除', () => {
  const result = assignEvidence(
    [asset()],
    [
      topic({ id: 'other-subject', subject: '物理' }),
      topic({ id: 'other-stage', stage: '小学' }),
      topic({ id: 'right' }),
    ]
  );
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].topic.id, 'right');
});

// ---------------------------------------------------------------------------
// 分配规则
// ---------------------------------------------------------------------------

test('每个知识点只取分数最高的来源主题', () => {
  const result = assignEvidence(
    [asset()],
    [
      topic({
        id: 'weaker',
        title: '全等',
        body: buildTopicBody('全等三角形的判定与应用'),
      }),
      topic({ id: 'stronger', title: '全等三角形' }),
    ]
  );
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].topic.id, 'stronger');
  assert.equal(result.assignments[0].confidence, 'high');
});

test('不做 1:1 唯一分配：一个来源主题可服务多个知识点', () => {
  const shared = topic({ id: 'shared', title: '全等三角形' });
  const result = assignEvidence(
    [
      asset({ id: 'cnm_122', name: '全等三角形' }),
      asset({ id: 'cnm_123', name: '全等三角形的判定' }),
    ],
    [shared]
  );
  assert.equal(result.assignments.length, 2);
  assert.equal(result.assignments[0].topic.id, 'shared');
  assert.equal(result.assignments[1].topic.id, 'shared');
  assert.deepEqual(result.unmatchedTopicIds, []);
});

test('minScore 可以把 medium 全部挡掉', () => {
  const result = assignEvidence(
    [asset({ name: '一元二次方程根与系数的关系' })],
    [topic({ title: '一元二次方程的解法', keywords: ['一元二次方程根的判别'] })],
    { minScore: EVIDENCE_HIGH }
  );
  assert.equal(result.assignments.length, 0);
  assert.deepEqual(result.unmatchedAssetIds, ['cnm_001']);
});

test('未被采纳的来源主题进入待审池', () => {
  const result = assignEvidence(
    [asset()],
    [topic({ id: 'used' }), topic({ id: 'unused', title: '别的主题', subject: '化学' })]
  );
  assert.deepEqual(result.unmatchedTopicIds, ['unused']);
});

test('byReason 统计每个证据类型的命中数', () => {
  const result = assignEvidence(
    [
      asset({ id: 'a', name: '全等三角形' }),
      asset({ id: 'b', name: '等边三角形' }),
    ],
    [
      topic({
        id: 't',
        title: '全等三角形',
        body: buildTopicBody('等边三角形是特殊的全等三角形'),
      }),
    ]
  );
  assert.equal(result.byReason['name==title'], 1);
  assert.equal(result.byReason['name-in-body'], 1);
});

// ---------------------------------------------------------------------------
// 红线
// ---------------------------------------------------------------------------

test('匹配只搬运来源原文，不改写易错内容', () => {
  const raw = '把 -5 + 3 算成 -8';
  const t = topic({ items: [candidate('atlas:1#p1', raw)] });
  const result = assignEvidence([asset()], [t]);
  assert.equal(result.assignments.length, 1);
  const carried = result.assignments[0].topic.items[0];
  assert.equal(carried.wrong, raw);
  assert.equal(carried.sourceText, raw);
});

test('正文规范化会去掉标点与 LaTeX 记号', () => {
  const body = normalizeBody('$x \\le 12.5$，取整数解。');
  assert.ok(!body.includes('$'));
  assert.ok(!body.includes('\\'));
  assert.ok(!body.includes('。'));
  assert.ok(body.includes('125'));
});

// ---------------------------------------------------------------------------
// 词表裁剪：碎片不进正文匹配，原名必须保留
// ---------------------------------------------------------------------------

test('知识点名的候选短语保留完整原名（勾股定理不被削成「勾股」）', () => {
  assert.ok(namePhrases('勾股定理').includes('勾股定理'));
  assert.ok(namePhrases('一元二次方程的解法').includes('一元二次方程的解法'));
});

test('知识点名的候选短语不取连接词碎片（避免 name-in-body 噪声）', () => {
  const parts = namePhrases('加法运算律与简便运算');
  assert.ok(!parts.includes('简便运算'));
  assert.ok(parts.includes('加法运算律与简便运算'));
  assert.ok(!namePhrases('频率（相对频数）的计算与意义').includes('的计算'));
});

test('碎片仍可通过词参与标题弱匹配（term-in-title）', () => {
  const s = scoreEvidence(
    asset({ name: '加法运算律与简便运算' }),
    topic({ title: '简便运算的技巧', body: '' })
  );
  assert.ok(s);
  assert.equal(s.reason, 'term-in-title');
});

// ---------------------------------------------------------------------------
// 册次冲突：降级而非丢弃
// ---------------------------------------------------------------------------

test('册次冲突 → 从 high 降级为 medium（不丢弃匹配）', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '九上' } })],
    [
      topic({
        title: '全等三角形',
        scope: { volumes: ['八上'] },
      }),
    ]
  );
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].confidence, 'medium');
});

test('来源主题册次包含知识点册次 → 仍是 high', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '八上' } })],
    [
      topic({
        title: '全等三角形',
        scope: { volumes: ['八上', '九上'] },
      }),
    ]
  );
  assert.equal(result.assignments[0].confidence, 'high');
});

test('来源主题册次未知 → 不降级（宁可不降级也不误伤）', () => {
  const result = assignEvidence(
    [asset({ scope: { volume: '九上' } })],
    [topic({ title: '全等三角形', scope: {} })]
  );
  assert.equal(result.assignments[0].confidence, 'high');
});

test('cstTextbookVolumes 从 textbooks 推导册次（只认人教版）', () => {
  assert.deepEqual(cstTextbookVolumes(['pep-math:7a:u2']), ['七上']);
  assert.deepEqual(cstTextbookVolumes(['pep-math:8b:u5', 'pep-math:9a:u1']), ['八下', '九上']);
  assert.deepEqual(cstTextbookVolumes(['bnu-math:7a:u2']), []);
  assert.deepEqual(cstTextbookVolumes(undefined), []);
});
