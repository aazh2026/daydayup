/**
 * cn-math-taxonomy 转换器单元测试。
 *
 * 覆盖重点：
 *  - 学科/学段映射（数学缺省 subject、10–16 是高中册次不是教学年份）
 *  - 权重/成本推导的边界钳制
 *  - 先修边筛选（soft 默认排除）与悬空边剔除
 *  - 题目类型/难度/分值映射
 *  - 端到端转换的完整性与外键有效性
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertQuestion,
  convertTaxonomy,
  convertTopic,
  deriveExamWeight,
  deriveLearningCostHours,
  DIFFICULTY_MAP,
  LEVEL_MAP,
  QUESTION_TYPE_MAP,
  resolveChapter,
  resolveSeniorVolume,
  resolveStage,
  resolveSubject,
  shouldIncludeTopic,
  SCORE_VALUE_MAP,
  SUBJECT_MAP,
  type TaxonomyDependency,
  type TaxonomyQuestion,
  type TaxonomyTopic,
} from '../src/infrastructure/knowledge/converters/taxonomy.ts';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function topic(overrides: Partial<TaxonomyTopic> = {}): TaxonomyTopic {
  return {
    id: 'cnm_test001',
    name: '测试知识点',
    domain: '数与代数',
    grade: 8,
    semester: '上',
    chapter: '八上 第一章',
    type: 'conceptual',
    description: '测试描述',
    mastery_criteria: ['能判断', '能说明'],
    standards: [{ id: 'cms-2022:4.NA.01', confidence: 'exact' }],
    ...overrides,
  };
}

function question(overrides: Partial<TaxonomyQuestion> = {}): TaxonomyQuestion {
  return {
    id: 'q1',
    topicId: 'cnm_test001',
    type: 'choice',
    difficulty: 'basic',
    prompt: '题干',
    answer: 'A',
    explanation: '解析',
    choices: [
      { key: 'A', text: '选项一' },
      { key: 'B', text: '选项二' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 学科映射
// ---------------------------------------------------------------------------

test('学科映射：数学缺省 subject 必须映射为「数学」而非跳过', () => {
  assert.equal(resolveSubject(topic({ subject: undefined })), '数学');
  assert.equal(resolveSubject(topic({ subject: '' })), '数学');
  assert.equal(resolveSubject(topic({ subject: 'english' })), '英语');
  assert.equal(resolveSubject(topic({ subject: 'morality' })), '道德与法治');
});

test('学科映射：未知学科必须抛错，不得静默猜测', () => {
  assert.throws(() => resolveSubject(topic({ subject: 'astronomy' })), /未知学科/);
});

test('SUBJECT_MAP 覆盖 cn-mt 全部学科取值', () => {
  assert.equal(SUBJECT_MAP.math, '数学');
  assert.equal(SUBJECT_MAP.english, '英语');
  assert.equal(SUBJECT_MAP.physics, '物理');
  assert.equal(SUBJECT_MAP.chemistry, '化学');
  assert.equal(SUBJECT_MAP.chinese, '语文');
});

// ---------------------------------------------------------------------------
// 学段映射
// ---------------------------------------------------------------------------

test('学段映射：1–6 小学、7–9 初中、10+ 高中', () => {
  assert.equal(resolveStage(topic({ grade: 1 })), '小学');
  assert.equal(resolveStage(topic({ grade: 6 })), '小学');
  assert.equal(resolveStage(topic({ grade: 7 })), '初中');
  assert.equal(resolveStage(topic({ grade: 9 })), '初中');
  assert.equal(resolveStage(topic({ grade: 10 })), '高中');
  assert.equal(resolveStage(topic({ grade: 16 })), '高中');
});

test('学段映射：越界 grade 必须抛错', () => {
  assert.throws(() => resolveStage(topic({ grade: 0 })), /无法判定学段/);
  assert.throws(() => resolveStage(topic({ grade: 99 })), /无法判定学段/);
});

test('高中册次编码：10–16 是分册编码而非教学年份', () => {
  assert.equal(resolveSeniorVolume(10), '必修第一册');
  assert.equal(resolveSeniorVolume(12), '必修第三册');
  assert.equal(resolveSeniorVolume(13), '选择性必修第一册');
  assert.equal(resolveSeniorVolume(16), '选择性必修第四册');
  assert.throws(() => resolveSeniorVolume(9), /未知的高中册次/);
});

test('章节映射：高中补册次前缀，初中原样保留', () => {
  assert.equal(resolveChapter(topic({ grade: 8, chapter: '八上 第一章' })), '八上 第一章');
  assert.equal(
    resolveChapter(topic({ grade: 10, chapter: '第一章 集合与常用逻辑用语' })),
    '必修第一册 第一章 集合与常用逻辑用语'
  );
});

// ---------------------------------------------------------------------------
// 权重与成本
// ---------------------------------------------------------------------------

test('考试权重钳制在 [0.6, 1.5] 区间内', () => {
  const weights = [1, 6, 7, 9, 10, 16].flatMap((grade) =>
    (['conceptual', 'procedural', 'reasoning', 'application', 'modeling'] as const).map((type) =>
      deriveExamWeight(topic({ grade, type }))
    )
  );
  for (const w of weights) {
    assert.ok(w >= 0.6 && w <= 1.5, `权重越界：${w}`);
  }
});

test('考试权重：初中 procedural 高于小学 conceptual', () => {
  const junior = deriveExamWeight(topic({ grade: 8, type: 'procedural' }));
  const primary = deriveExamWeight(topic({ grade: 3, type: 'conceptual' }));
  assert.ok(junior > primary, `初中技能点 ${junior} 应高于小学概念点 ${primary}`);
});

test('考试权重：精确对齐课标的点权重更高', () => {
  const exact = deriveExamWeight(
    topic({ standards: [{ id: 'cms-2022:4.NA.01', confidence: 'exact' }] })
  );
  const paraphrase = deriveExamWeight(
    topic({ standards: [{ id: 'cms-2022:4.NA.01', confidence: 'paraphrase' }] })
  );
  assert.ok(exact > paraphrase);
});

test('学习成本钳制在 [0.5, 8] 区间内', () => {
  const costs = [1, 6, 7, 9, 10].flatMap((grade) =>
    (['conceptual', 'procedural', 'reasoning', 'application', 'modeling'] as const).map((type) =>
      deriveLearningCostHours(topic({ grade, type }))
    )
  );
  for (const c of costs) {
    assert.ok(c >= 0.5 && c <= 8, `成本越界：${c}`);
  }
});

test('学习成本：子技能越多成本越高', () => {
  const few = deriveLearningCostHours(topic({ mastery_criteria: ['a'] }));
  const many = deriveLearningCostHours(topic({ mastery_criteria: ['a', 'b', 'c', 'd'] }));
  assert.ok(many > few);
});

// ---------------------------------------------------------------------------
// 筛选逻辑
// ---------------------------------------------------------------------------

test('筛选：非中考学科被排除', () => {
  const r = shouldIncludeTopic(topic({ subject: 'biology' }), {});
  assert.equal(r.include, false);
  assert.match(r.reason ?? '', /不在导入范围/);
});

test('筛选：external 节点被排除', () => {
  const r = shouldIncludeTopic(topic({ external: true }), {});
  assert.equal(r.include, false);
  assert.match(r.reason ?? '', /external/);
});

test('筛选：按学段筛选生效', () => {
  const r = shouldIncludeTopic(topic({ grade: 3 }), { stages: ['初中'] });
  assert.equal(r.include, false);
  const r2 = shouldIncludeTopic(topic({ grade: 8 }), { stages: ['初中'] });
  assert.equal(r2.include, true);
});

test('筛选：显式指定学科可包含非默认学科', () => {
  const r = shouldIncludeTopic(topic({ subject: 'biology' }), { subjects: ['生物'] });
  assert.equal(r.include, true);
});

// ---------------------------------------------------------------------------
// 题目转换
// ---------------------------------------------------------------------------

test('题目映射表完整覆盖 cn-mt 四种题型', () => {
  assert.equal(QUESTION_TYPE_MAP.choice, '选择');
  assert.equal(QUESTION_TYPE_MAP.numeric, '填空');
  assert.equal(QUESTION_TYPE_MAP.short, '解答');
  assert.equal(QUESTION_TYPE_MAP.self, '解答');
});

test('难度映射：basic/standard 对应基础题/变式题，challenge/advanced 提升到迁移题', () => {
  assert.equal(LEVEL_MAP.basic, '基础题');
  assert.equal(LEVEL_MAP.standard, '变式题');
  assert.equal(LEVEL_MAP.challenge, '迁移题');
  assert.equal(LEVEL_MAP.advanced, '迁移题');
  assert.equal(DIFFICULTY_MAP.basic, 1);
  assert.equal(DIFFICULTY_MAP.advanced, 4);
});

test('分值映射随难度递增', () => {
  assert.ok(SCORE_VALUE_MAP.basic < SCORE_VALUE_MAP.standard);
  assert.ok(SCORE_VALUE_MAP.standard < SCORE_VALUE_MAP.challenge);
  assert.ok(SCORE_VALUE_MAP.challenge < SCORE_VALUE_MAP.advanced);
});

test('题目转换：选择题展开为带序号的选项数组', () => {
  const q = convertQuestion(question(), '数学', '初三');
  assert.ok(q);
  assert.deepEqual(q.options, ['A. 选项一', 'B. 选项二']);
  assert.equal(q.questionType, '选择');
  assert.equal(q.region, '上海');
  assert.equal(q.grade, '初三');
});

test('题目转换：数值题不产生 options 字段', () => {
  const q = convertQuestion(
    question({ type: 'numeric', choices: undefined, answer: '4' }),
    '数学',
    '初三'
  );
  assert.ok(q);
  assert.equal(q.options, undefined);
  assert.equal(q.questionType, '填空');
});

test('题目转换：缺少题干或答案返回 null', () => {
  assert.equal(convertQuestion(question({ prompt: '' }), '数学', '初三'), null);
  assert.equal(convertQuestion(question({ answer: '' }), '数学', '初三'), null);
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

test('端到端：转换产出结构完整且外键有效', () => {
  const topics: TaxonomyTopic[] = [
    topic({ id: 'cnm_p001', grade: 3, chapter: '三上 第一单元' }),
    topic({ id: 'cnm_001', grade: 8, chapter: '八上 第一章' }),
    topic({ id: 'cnm_002', grade: 8, chapter: '八上 第二章' }),
    topic({ id: 'cnb_j001', subject: 'biology', grade: 7 }),
  ];
  const deps: TaxonomyDependency[] = [
    { topicId: 'cnm_001', prerequisiteId: 'cnm_p001', strength: 'hard' },
    { topicId: 'cnm_002', prerequisiteId: 'cnm_001', strength: 'hard' },
    { topicId: 'cnm_002', prerequisiteId: 'cnm_p001', strength: 'soft' },
    { topicId: 'cnm_002', prerequisiteId: 'cnm_999', strength: 'hard' }, // 悬空
  ];
  const questions: TaxonomyQuestion[] = [
    question({ id: 'q1', topicId: 'cnm_001' }),
    question({ id: 'q2', topicId: 'cnm_002' }),
    question({ id: 'q3', topicId: 'cnb_j001' }), // 生物，已被排除
  ];

  const { curriculum, bank, report } = convertTaxonomy(topics, deps, questions, {});

  // 生物被排除 → 3 个知识点
  assert.equal(curriculum.knowledgePoints.length, 3);
  assert.equal(report.convertedTopics, 3);

  // soft 边默认排除 → 保留 2 条硬边
  assert.equal(report.keptEdges, 2);
  const cnm002 = curriculum.knowledgePoints.find((k) => k.id === 'cnm_002');
  assert.deepEqual(cnm002?.prerequisites, ['cnm_001']);

  // 悬空边被剔除并记录原因（不得静默丢弃）
  const dangling = report.skipped.filter(
    (s) => s.kind === 'edge' && s.reason.includes('悬空')
  );
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].id, 'cnm_002<-cnm_999');
  // 被剔除的边不得出现在任何知识点的 prerequisites 里
  assert.ok(!cnm002?.prerequisites.includes('cnm_999'));

  // 题目：q3 所属知识点被排除 → 跳过
  assert.equal(bank.questions.length, 2);
  assert.equal(report.convertedQuestions, 2);

  // 资产默认 DRAFT
  assert.equal(curriculum.status, 'DRAFT');
  assert.deepEqual(curriculum.subjects, ['数学']);

  // 外键全部有效
  const ids = new Set(curriculum.knowledgePoints.map((k) => k.id));
  for (const kp of curriculum.knowledgePoints) {
    for (const p of kp.prerequisites) {
      assert.ok(ids.has(p), `悬空先修：${kp.id} → ${p}`);
    }
  }
});

test('端到端：includeSoft 开启后 soft 边被保留', () => {
  const topics = [topic({ id: 'a' }), topic({ id: 'b' })];
  const deps = [{ topicId: 'b', prerequisiteId: 'a', strength: 'soft' as const }];

  const withoutSoft = convertTaxonomy(topics, deps, [], {});
  assert.equal(withoutSoft.report.keptEdges, 0);

  const withSoft = convertTaxonomy(topics, deps, [], { includeSoftPrerequisites: true });
  assert.equal(withSoft.report.keptEdges, 1);
  assert.deepEqual(
    withSoft.curriculum.knowledgePoints.find((k) => k.id === 'b')?.prerequisites,
    ['a']
  );
});

test('端到端：先修边去重，不重复记录同一先修', () => {
  const topics = [topic({ id: 'a' }), topic({ id: 'b' })];
  const deps = [
    { topicId: 'b', prerequisiteId: 'a', strength: 'hard' as const },
    { topicId: 'b', prerequisiteId: 'a', strength: 'hard' as const },
  ];
  const { curriculum } = convertTaxonomy(topics, deps, [], {});
  assert.deepEqual(
    curriculum.knowledgePoints.find((k) => k.id === 'b')?.prerequisites,
    ['a']
  );
});

test('端到端：mastery_criteria 映射为 subSkills', () => {
  const kp = convertTopic(topic({ mastery_criteria: ['标准一', '标准二'] }), [], {});
  assert.deepEqual(kp?.subSkills, ['标准一', '标准二']);
});

test('端到端：commonTraps 为空并产生告警（cn-mt 无错因数据）', () => {
  const { curriculum, report } = convertTaxonomy([topic()], [], [], {});
  assert.deepEqual(curriculum.knowledgePoints[0].commonTraps, []);
  assert.ok(report.warnings.some((w) => w.includes('commonTraps')));
});

test('端到端：转换是幂等的（同样输入同样输出）', () => {
  const topics = [topic({ id: 'a' }), topic({ id: 'b' })];
  const deps = [{ topicId: 'b', prerequisiteId: 'a', strength: 'hard' as const }];
  const opts = { version: 'v1', publishedAt: '2026-01-01T00:00:00.000Z' };

  const r1 = convertTaxonomy(topics, deps, [], opts);
  const r2 = convertTaxonomy(topics, deps, [], opts);
  assert.deepEqual(r1.curriculum, r2.curriculum);
  assert.deepEqual(r1.bank, r2.bank);
});

test('端到端：publishedAt 未传入时使用固定纪元值（保证幂等，不读时钟）', () => {
  const { curriculum } = convertTaxonomy([topic()], [], [], {});
  assert.equal(curriculum.publishedAt, new Date(0).toISOString());
});
