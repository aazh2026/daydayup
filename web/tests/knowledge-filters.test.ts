import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgePoint, MasteryRecord } from '@daydayup/contracts';
import {
  DEFAULT_KNOWLEDGE_FILTERS,
  buildDomainOptions,
  filterKnowledgePoints,
  isWeakMastery,
  matchesSearch,
  matchesStateFilter,
  sortKnowledgePoints,
} from '../src/utils/knowledge.ts';

function kp(partial: Partial<KnowledgePoint> & { id: string; name: string }): KnowledgePoint {
  return {
    subject: '数学',
    chapter: '九年级上册 第21章 一元二次方程',
    domain: '数与代数',
    definition: '定义',
    subSkills: [],
    prerequisites: [],
    commonExamForms: [],
    commonTraps: [],
    examWeight: 1,
    learningCostHours: 1,
    ...partial,
  };
}

const KPS: KnowledgePoint[] = [
  kp({
    id: 'k1',
    name: '一元二次方程根的判别式',
    definition: 'delta = b^2 - 4ac 与根的关系',
    commonTraps: ['忽略二次项系数不为0'],
    examWeight: 1.25,
    learningCostHours: 1.5,
  }),
  kp({
    id: 'k2',
    name: '一次函数图像与性质',
    chapter: '八年级下册 第19章 一次函数',
    domain: '函数与分析',
    definition: 'y=kx+b 的图像分布',
    examWeight: 1.1,
    learningCostHours: 1,
  }),
  kp({
    id: 'k3',
    name: '有理数加法法则',
    chapter: '七年级上册 第2章 有理数',
    definition: '同号相加符号不变',
    examWeight: 0.8,
    learningCostHours: 0.5,
  }),
];

const MASTERY: Record<string, Partial<MasteryRecord>> = {
  k1: { state: '待学习', lostScoreEvidence: 8 },
  k2: { state: '稳定掌握', lostScoreEvidence: 0 },
  k3: { state: '学习中', lostScoreEvidence: 2 },
};

describe('考点筛选共享口径（提分报告与知识图谱共用）', () => {
  it('薄弱判定：待学习/学习中/有失分证据即为薄弱', () => {
    assert.equal(isWeakMastery('待学习', 0), true);
    assert.equal(isWeakMastery('学习中', 0), true);
    assert.equal(isWeakMastery('掌握', 3), true);
    assert.equal(isWeakMastery('掌握', 0), false);
    assert.equal(isWeakMastery('未诊断', 0), false);
  });

  it('状态筛选：薄弱需攻克为聚合项', () => {
    assert.equal(matchesStateFilter('未诊断', 0, 'all'), true);
    assert.equal(matchesStateFilter('待学习', 0, '薄弱需攻克'), true);
    assert.equal(matchesStateFilter('掌握', 5, '薄弱需攻克'), true);
    assert.equal(matchesStateFilter('掌握', 0, '薄弱需攻克'), false);
    assert.equal(matchesStateFilter('稳定掌握', 0, '稳定掌握'), true);
  });

  it('关键词搜索同时命中定义与避坑点', () => {
    assert.equal(matchesSearch(KPS[0], '判别式'), true);
    assert.equal(matchesSearch(KPS[0], '二次项系数'), true);
    assert.equal(matchesSearch(KPS[0], '圆周率'), false);
    assert.equal(matchesSearch(KPS[0], '  '), true);
  });

  it('筛选组合：板块 + 状态 + 关键词', () => {
    const filtered = filterKnowledgePoints(
      KPS,
      { ...DEFAULT_KNOWLEDGE_FILTERS, domain: '数与代数', state: '薄弱需攻克' },
      MASTERY as Record<string, MasteryRecord>
    );
    assert.deepEqual(
      filtered.map((k) => k.id).sort(),
      ['k1', 'k3']
    );
  });

  it('排序：权重降序 / 学时升序 / 失分降序', () => {
    const byWeight = sortKnowledgePoints(KPS, 'weight', MASTERY as Record<string, MasteryRecord>);
    assert.equal(byWeight[0].id, 'k1');

    const byCost = sortKnowledgePoints(KPS, 'cost', MASTERY as Record<string, MasteryRecord>);
    assert.equal(byCost[0].id, 'k3');

    const byLost = sortKnowledgePoints(KPS, 'lostScore', MASTERY as Record<string, MasteryRecord>);
    assert.equal(byLost[0].id, 'k1');
  });

  it('板块统计带数量，且按名称稳定排序', () => {
    const options = buildDomainOptions(KPS);
    assert.deepEqual(
      options.map((o) => o.id),
      ['函数与分析', '数与代数']
    );
    assert.equal(options.find((o) => o.id === '数与代数')?.count, 2);
  });

  it('年级筛选与筛选器口径一致（图表两处共用同一套实现）', () => {
    const filtered = filterKnowledgePoints(
      KPS,
      { ...DEFAULT_KNOWLEDGE_FILTERS, grade: '初三' },
      MASTERY as Record<string, MasteryRecord>
    );
    assert.deepEqual(
      filtered.map((k) => k.id),
      ['k1']
    );
  });
});
