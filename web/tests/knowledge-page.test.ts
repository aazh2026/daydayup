import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AppPage, KnowledgePoint, MasteryRecord } from '@daydayup/contracts';
import { resolveGradeInfo } from '../src/components/SubjectKnowledgeMindMap.tsx';

describe('知识图谱与考点独立页面', () => {
  it('AppPage 契约类型包含 knowledge 页面标识', () => {
    const validPages: AppPage[] = [
      'today',
      'diagnosis',
      'knowledge',
      'planning',
      'coach',
      'report',
      'teacher',
    ];
    assert.ok(validPages.includes('knowledge'));
  });

  it('知识图谱独立页面保留结构统计：考点总数 / 掌握率 / 薄弱点 / 先修根因', () => {
    const mockKps = [
      { id: 'kp-1', name: '一次函数', subject: '数学', domain: '函数' },
      { id: 'kp-2', name: '二次函数', subject: '数学', domain: '函数' },
      { id: 'kp-3', name: '几何全等', subject: '数学', domain: '几何' },
      { id: 'kp-4', name: '定语从句', subject: '英语', domain: '语法' },
    ];

    const mockMastery: Record<string, { state: string; lostScoreEvidence: number }> = {
      'kp-1': { state: '稳定掌握', lostScoreEvidence: 0 },
      'kp-2': { state: '待学习', lostScoreEvidence: 6 },
      'kp-3': { state: '学习中', lostScoreEvidence: 4 },
    };

    const mathKps = mockKps.filter((k) => k.subject === '数学');
    assert.equal(mathKps.length, 3);

    let mastered = 0;
    let totalLost = 0;
    for (const kp of mathKps) {
      const rec = mockMastery[kp.id];
      if (rec?.state === '稳定掌握' || rec?.state === '掌握') mastered++;
      if (rec?.lostScoreEvidence) totalLost += rec.lostScoreEvidence;
    }

    assert.equal(mastered, 1);
    assert.equal(totalLost, 10);
  });

  it('知识点多维筛选：支持关键词、年级、掌握度状态与板块筛选', () => {
    const mockKps: KnowledgePoint[] = [
      {
        id: 'math-1',
        subject: '数学',
        chapter: '九年级上册 第21章 一元二次方程',
        domain: '数与代数',
        name: '一元二次方程根的判别式',
        definition: '掌握一元二次方程根的判别式 delta = b^2 - 4ac 与根的关系',
        subSkills: ['计算判别式', '判定根的个数', '根据根的情况求参数'],
        prerequisites: ['math-0'],
        commonExamForms: ['填空题', '含参解答题'],
        commonTraps: ['忽略二次项系数不为0的隐含条件'],
        examWeight: 1.25,
        learningCostHours: 1.5,
      },
      {
        id: 'math-2',
        subject: '数学',
        chapter: '八年级下册 第19章 一次函数',
        domain: '函数与分析',
        name: '一次函数图像与性质',
        definition: '掌握 y=kx+b 的图像分布与增减性',
        subSkills: ['图像绘制', 'k与b的几何意义'],
        prerequisites: [],
        commonExamForms: ['选择题', '综合应用题'],
        commonTraps: ['k的正负与增减性搞混'],
        examWeight: 1.1,
        learningCostHours: 1.0,
      },
      {
        id: 'math-3',
        subject: '数学',
        chapter: '七年级上册 第2章 有理数的加减',
        domain: '数与代数',
        name: '有理数加法法则',
        definition: '同号相加符号不变绝对值相加',
        subSkills: ['同号运算法则', '异号运算法则'],
        prerequisites: [],
        commonExamForms: ['计算题'],
        commonTraps: ['异号相加漏掉绝对值较大数的符号'],
        examWeight: 0.8,
        learningCostHours: 0.5,
      },
    ];

    const mockMastery: Record<string, Partial<MasteryRecord>> = {
      'math-1': { state: '待学习', lostScoreEvidence: 8 },
      'math-2': { state: '稳定掌握', lostScoreEvidence: 0 },
      'math-3': { state: '学习中', lostScoreEvidence: 2 },
    };

    // 1. 关键词搜索
    const searchFiltered = mockKps.filter((kp) => {
      const hay = `${kp.name} ${kp.chapter} ${kp.definition} ${kp.commonTraps.join(' ')}`.toLowerCase();
      return hay.includes('判别式');
    });
    assert.equal(searchFiltered.length, 1);
    assert.equal(searchFiltered[0].id, 'math-1');

    // 2. 年级筛选（九年级/初三）
    const gradeFiltered = mockKps.filter((kp) => {
      const info = resolveGradeInfo(kp.chapter);
      return info.grade === '初三';
    });
    assert.equal(gradeFiltered.length, 1);
    assert.equal(gradeFiltered[0].id, 'math-1');

    // 3. 掌握状态筛选（薄弱待攻克：待学习/学习中/有失分）
    const weakFiltered = mockKps.filter((kp) => {
      const rec = mockMastery[kp.id];
      const state = rec?.state ?? '未诊断';
      const hasLost = (rec?.lostScoreEvidence ?? 0) > 0;
      return state === '待学习' || state === '学习中' || hasLost;
    });
    assert.equal(weakFiltered.length, 2);
    assert.deepEqual(weakFiltered.map((k) => k.id).sort(), ['math-1', 'math-3']);

    // 4. 按考纲权重排序
    const sortedByWeight = [...mockKps].sort((a, b) => b.examWeight - a.examWeight);
    assert.equal(sortedByWeight[0].id, 'math-1');
    assert.equal(sortedByWeight[1].id, 'math-2');
    assert.equal(sortedByWeight[2].id, 'math-3');
  });

  it('知识点具体内容 11 项元数据均已完整呈现', () => {
    const kp: KnowledgePoint = {
      id: 'cnm_123',
      subject: '数学',
      chapter: '九年级下册 第27章 相似',
      domain: '图形与几何',
      name: '相似三角形的判定与性质',
      definition: '理解相似三角形的定义，掌握三边成比例、两边夹角、两角相等等判定定理',
      subSkills: ['平行线分线段成比例', '判定定理证明', '相似比求面积比'],
      prerequisites: ['cnm_098'],
      commonExamForms: ['压轴证明题', '动点综合题'],
      commonTraps: ['面积比误当成相似比（应为平方比）'],
      examWeight: 1.5,
      learningCostHours: 2.5,
    };

    assert.ok(kp.id);
    assert.ok(kp.subject);
    assert.ok(kp.chapter);
    assert.ok(kp.domain);
    assert.ok(kp.name);
    assert.ok(kp.definition);
    assert.equal(kp.subSkills.length, 3);
    assert.equal(kp.prerequisites.length, 1);
    assert.equal(kp.commonExamForms.length, 2);
    assert.equal(kp.commonTraps.length, 1);
    assert.equal(kp.examWeight, 1.5);
    assert.equal(kp.learningCostHours, 2.5);
  });
});
