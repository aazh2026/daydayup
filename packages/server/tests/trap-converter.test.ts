/**
 * 易错（错因）资产层单元测试。
 *
 * 覆盖重点：
 *  - 转换器：atlas pitfalls 三段式、cst 易错 note、cn-mt 易错主题与显式警示解析
 *  - 红线：不得凭空生成易错点（普通解析不产出条目）；medium 置信度不得进 ACTIVE
 *  - 匹配器：三级匹配优先级、学段/学科否决、未匹配不丢弃
 *  - 覆盖层：只追加不覆盖、DRAFT 不生效、去重
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  atlasVolumeToStage,
  convertAtlasPoints,
  convertCnMtTrapQuestions,
  convertCnMtTrapTopics,
  convertCstCourses,
  convertCstRefuteQuestions,
  convertCstTeachingResearch,
  cstGradeRangeToStage,
  cstGradeToStage,
  ERROR_HINT_PATTERN,
  extractErrorFragment,
  extractHintFragment,
  nameAliasVariants,
  splitSentences,
  type AtlasPoint,
  type CnMtQuestionLike,
  type CnMtTopicLike,
  type CstCourse,
  type CstQuestionLike,
  type CstResearchRecord,
  type CstTopicLike,
  type TrapCandidate,
} from '../src/infrastructure/knowledge/converters/traps.ts';
import {
  buildKnowledgeIndex,
  matchTrapCandidates,
  normalizeName,
  resolveIndexStage,
} from '../src/infrastructure/knowledge/trap-matcher.ts';
import {
  applyTrapSets,
  formatTrapText,
} from '../src/infrastructure/knowledge/converters/trap-overlay.ts';
import type { TrapSet } from '@daydayup/contracts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<TrapCandidate> = {}): TrapCandidate {
  return {
    id: 'src:1#1',
    sourceRepo: 'src',
    sourceId: '1',
    subject: '数学',
    stage: '初中',
    wrong: '错在哪',
    why: '为什么',
    right: '怎么做',
    ...overrides,
  };
}

function trapSet(overrides: Partial<TrapSet> = {}): TrapSet {
  return {
    version: 'traps-test-1',
    publishedAt: '2026-11-18T00:00:00.000Z',
    status: 'ACTIVE',
    subject: '数学',
    source: { repo: 'src', path: 'resources/src', license: 'CC BY-SA 4.0' },
    entries: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 转换器
// ---------------------------------------------------------------------------

test('convertAtlasPoints：pitfalls 三段式原样保留，cautions 单独成条', () => {
  const points: AtlasPoint[] = [
    {
      id: 'm1-00-01',
      title: '有理数的加减法',
      textbook_ref: { volume: '七上' },
      sections: {
        pitfalls: [{ wrong: '异号相加忘记变号', why: '忽略了符号', right: '先定符号再定绝对值' }],
        cautions: ['结果为 0 时不要写成 -0'],
      },
    },
  ];

  const out = convertAtlasPoints(points);
  assert.equal(out.length, 2);

  const pitfall = out[0];
  assert.equal(pitfall.wrong, '异号相加忘记变号');
  assert.equal(pitfall.why, '忽略了符号');
  assert.equal(pitfall.right, '先定符号再定绝对值');
  assert.equal(pitfall.stage, '初中');
  assert.equal(pitfall.subject, '数学');
  assert.ok(pitfall.sourceText?.includes('异号相加忘记变号'));

  const caution = out[1];
  assert.equal(caution.wrong, '');
  assert.equal(caution.right, '结果为 0 时不要写成 -0');
});

test('convertAtlasPoints：空 pitfalls/cautions 不产出条目（不凭空生成）', () => {
  const out = convertAtlasPoints([
    { id: 'x', title: '空点', sections: { pitfalls: [{}], cautions: ['  '] } },
  ]);
  assert.equal(out.length, 0);
});

test('atlasVolumeToStage：七/八/九为初中，一至六为小学', () => {
  assert.equal(atlasVolumeToStage('七上'), '初中');
  assert.equal(atlasVolumeToStage('九下'), '初中');
  assert.equal(atlasVolumeToStage('五上'), '小学');
  assert.equal(atlasVolumeToStage(undefined), '初中');
});

test('convertCstCourses：只取含「易错」的 step.note，并剥掉前缀', () => {
  const courses: CstCourse[] = [
    {
      topicId: 'mt_01',
      title: '有理数',
      subject: '数学',
      grade: 7,
      steps: [
        { note: '这是一句普通讲解' },
        { note: '易错：把 0 看成是正数', warn: true },
      ],
    },
  ];

  const out = convertCstCourses(courses);
  assert.equal(out.length, 1);
  assert.equal(out[0].wrong, '把 0 看成是正数');
  assert.equal(out[0].stage, '初中');
  assert.equal(out[0].topicName, '有理数');
});

test('cstGradeToStage：1–6 小学 / 7–9 初中 / 其他高中', () => {
  assert.equal(cstGradeToStage(3), '小学');
  assert.equal(cstGradeToStage(8), '初中');
  assert.equal(cstGradeToStage(11), '高中');
  assert.equal(cstGradeToStage(undefined), '初中');
});

test('extractErrorFragment：取出「易错」片段', () => {
  assert.equal(
    extractErrorFragment('语文园地一·易错字音（削、骨、血、处）'),
    '易错字音（削、骨、血、处）'
  );
  assert.equal(extractErrorFragment('通假字与易错字'), '易错字');
});

test('convertCnMtTrapTopics：只取名字含「易错」的知识点', () => {
  const topics: CnMtTopicLike[] = [
    {
      id: 'cnc_p371',
      name: '语文园地一·易错字音（削、骨、血、处）',
      subject: 'chinese',
      grade: 7,
      description: '要读准这些字',
    },
    { id: 'cnm_x1', name: '有理数的概念', subject: 'math', grade: 7 },
  ];

  const out = convertCnMtTrapTopics(topics);
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceTopicId, 'cnc_p371');
  assert.equal(out[0].subject, '语文');
  assert.equal(out[0].stage, '初中');
  assert.equal(out[0].wrong, '易错字音（削、骨、血、处）');
  assert.equal(out[0].right, '要读准这些字');
});

test('convertCnMtTrapTopics：中文 subject 原样保留（不在中考范围的学科保持原名）', () => {
  const out = convertCnMtTrapTopics([
    { id: 'bio_1', name: '生物·易错概念', subject: '生物', grade: 8 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, '生物');
});

test('convertCnMtTrapQuestions：只有显式警示句才产出条目，普通解析不推断', () => {
  const questions: CnMtQuestionLike[] = [
    {
      id: 'q1',
      topicId: 'cnm_x1',
      explanation: '先通分再计算。注意：不能直接把分子相加。',
    },
    { id: 'q2', topicId: 'cnm_x1', explanation: '两边同乘 2 即可得到答案。' },
  ];

  const out = convertCnMtTrapQuestions(questions);
  assert.equal(out.length, 1);
  assert.equal(out[0].questionIds?.[0], 'q1');
  assert.ok(ERROR_HINT_PATTERN.test(out[0].wrong));
  assert.ok(out[0].wrong.includes('不能直接把分子相加'));
});

test('splitSentences：按中文标点切句', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), [
    '第一句。',
    '第二句！',
    '第三句？',
  ]);
});

test('extractHintFragment：裁掉解题步骤与尾部推导', () => {
  assert.equal(
    extractHintFragment('A-B=2x²-x-(x²+3x-1)=x²-4x+1，注意括号前是负号，-1 要变成 +1。'),
    '注意括号前是负号，-1 要变成 +1'
  );
  assert.equal(
    extractHintFragment('两边同乘 6（注意右边的 1 也要乘 6）：3(x-1)-2(2x+1)=6，得 x=-11。'),
    '注意右边的 1 也要乘 6'
  );
  assert.equal(
    extractHintFragment('把 1.5 h 当成 1 h 50 min 是常见错误。'),
    '把 1.5 h 当成 1 h 50 min 是常见错误'
  );
  // 「不要求」里的「不要」不是警示
  assert.equal(ERROR_HINT_PATTERN.test('并不要求必须等于 CD'), false);
  assert.equal(ERROR_HINT_PATTERN.test('不要把圆加进去'), true);
});

// ---------------------------------------------------------------------------
// 匹配器
// ---------------------------------------------------------------------------

test('normalizeName：去空白标点、全角转半角、小写', () => {
  assert.equal(normalizeName('有理数（概念与分类）'), normalizeName('有理数 概念与分类'));
  assert.equal(normalizeName('  ＡＢＣ  '), 'abc');
});

test('resolveIndexStage：id 后缀与章节特征判定学段', () => {
  assert.equal(resolveIndexStage({ id: 'cnm_p001', chapter: '' }), '小学');
  assert.equal(resolveIndexStage({ id: 'cnm_h001', chapter: '' }), '高中');
  assert.equal(resolveIndexStage({ id: 'cnm_x', chapter: '高一 必修' }), '高中');
  assert.equal(resolveIndexStage({ id: 'cnm_x', chapter: '七上 第一章' }), '初中');
});

test('匹配优先级：manual-map > source-topic > exact-name > name-contains', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_x1', name: '有理数', subject: '数学', chapter: '七上' },
    { id: 'cnm_x2', name: '有理数的加减法', subject: '数学', chapter: '七上' },
  ]);

  // manual-map 优先
  const r1 = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', sourceTopicId: 'cnm_x1', topicName: '有理数' })],
    index,
    { manualMap: { 'src:s1': 'cnm_x2' } }
  );
  assert.equal(r1.entries[0].matchMethod, 'manual-map');
  assert.equal(r1.entries[0].knowledgeId, 'cnm_x2');
  assert.equal(r1.entries[0].matchConfidence, 'high');

  // source-topic 次之
  const r2 = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', sourceTopicId: 'cnm_x1' })],
    index
  );
  assert.equal(r2.entries[0].matchMethod, 'source-topic');
  assert.equal(r2.entries[0].knowledgeId, 'cnm_x1');

  // exact-name
  const r3 = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', topicName: '有理数' })],
    index
  );
  assert.equal(r3.entries[0].matchMethod, 'exact-name');
  assert.equal(r3.entries[0].matchConfidence, 'high');

  // name-contains → medium
  const r4 = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', topicName: '有理数的加减法运算' })],
    index
  );
  assert.equal(r4.entries[0].matchMethod, 'name-contains');
  assert.equal(r4.entries[0].matchConfidence, 'medium');
});

test('学段/学科不符直接判否', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_p001', name: '有理数', subject: '数学', chapter: '一年级' },
  ]);

  const r = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', topicName: '有理数', stage: '初中' })],
    index
  );
  assert.equal(r.entries[0].knowledgeId, null);
  assert.equal(r.entries[0].matchConfidence, 'unmatched');
  assert.equal(r.summary.unmatched.length, 1);
});

test('匹配失败不丢弃条目', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_x1', name: '有理数', subject: '数学', chapter: '七上' },
  ]);
  const r = matchTrapCandidates(
    [candidate({ sourceRepo: 'src', sourceId: 's1', topicName: '完全不相关的知识点' })],
    index
  );
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].knowledgeId, null);
  assert.equal(r.entries[0].matchMethod, 'none');
});

// ---------------------------------------------------------------------------
// cst 教学研究 / refute 转换器（P2 错因层扩容）
// ---------------------------------------------------------------------------

test('cstGradeRangeToStage：按年级区间判学段，跨学段不约束', () => {
  assert.equal(cstGradeRangeToStage(1, 6), '小学');
  assert.equal(cstGradeRangeToStage(3, 4), '小学');
  assert.equal(cstGradeRangeToStage(7, 9), '初中');
  assert.equal(cstGradeRangeToStage(10, 12), '高中');
  // 跨学段（1~3 小学、3~4 小学、6~7 跨初中）→ 空串 = 不约束
  assert.equal(cstGradeRangeToStage(6, 7), '');
  // 缺年份不约束
  assert.equal(cstGradeRangeToStage(undefined, undefined), '');
  assert.equal(cstGradeRangeToStage(3, undefined), '');
});

test('nameAliasVariants：去掉「的」的别名变体', () => {
  assert.deepEqual(nameAliasVariants('同分母分数的加减法'), ['同分母分数加减法']);
  assert.deepEqual(nameAliasVariants('有理数'), []);
  assert.deepEqual(nameAliasVariants(''), []);
});

test('convertCstTeachingResearch：errors → wrong、nextMoves → right，why 留空', () => {
  const records: CstResearchRecord[] = [
    {
      topicId: 'mt_x1',
      topicName: '同分母分数的加减法',
      subject: '数学',
      gradeRangeStart: 5,
      gradeRangeEnd: 6,
      pedagogy: '教学难点在于通分意识。',
      assess: {
        errors: ['直接通分不约分', '把分子分母分别相加'],
        nextMoves: ['先约分再计算', '通分后检查分子分母'],
      },
    },
  ];

  const out = convertCstTeachingResearch(records);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'cst:mt_x1#e1');
  assert.equal(out[0].wrong, '直接通分不约分');
  assert.equal(out[0].right, '先约分再计算');
  assert.equal(out[0].why, '');
  assert.equal(out[0].stage, '小学');
  assert.equal(out[0].subject, '数学');
  assert.deepEqual(out[0].topicAliases, ['同分母分数加减法']);
  // pedagogy 只做溯源，不进三段式
  assert.ok(out[0].sourceText?.includes('教学难点在于通分意识。'));
  assert.equal(out[1].right, '通分后检查分子分母');
});

test('convertCstTeachingResearch：没有 errors 就不产出条目（不凭空生成）', () => {
  const out = convertCstTeachingResearch([
    { topicId: 'mt_x2', topicName: '空主题', subject: '数学', assess: { nextMoves: ['有补救没错误'] } },
  ]);
  assert.equal(out.length, 0);
});

test('convertCstTeachingResearch：nextMoves 缺失时 right 留空串', () => {
  const out = convertCstTeachingResearch([
    { topicId: 'mt_x3', topicName: 'T', subject: '数学', assess: { errors: ['错法一'] } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].right, '');
});

test('convertCstRefuteQuestions：错误选项 → wrong、反驳理由 → why、解析 → right', () => {
  const topicById = new Map<string, CstTopicLike>([
    ['t1', { id: 't1', name: '平均数', subject: '数学', gradeRangeStart: 5, gradeRangeEnd: 6 }],
  ]);
  const questions: CstQuestionLike[] = [
    {
      id: 'q1',
      topicId: 't1',
      prompt: '四个数的平均数是 11',
      answer: '10',
      explanation: '先求总和再除以个数。',
      refute: { '等于 11': '只有四个数都是 11 时平均数才是 11；有一个 4 就被拉低了。' },
    },
  ];

  const out = convertCstRefuteQuestions(questions, topicById);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'cst:q1#r1');
  assert.equal(out[0].wrong, '等于 11');
  assert.equal(out[0].why, '只有四个数都是 11 时平均数才是 11；有一个 4 就被拉低了。');
  assert.equal(out[0].right, '先求总和再除以个数。');
  assert.equal(out[0].topicName, '平均数');
  assert.equal(out[0].stage, '小学');
});

test('convertCstRefuteQuestions：没有 refute 的题目不产出条目', () => {
  const out = convertCstRefuteQuestions(
    [{ id: 'q2', topicId: 't1', prompt: 'p', answer: 'a', explanation: 'e' }],
    new Map<string, CstTopicLike>([['t1', { id: 't1', name: '平均数', subject: '数学' }]])
  );
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// 匹配器：exact-name-alias（P2）
// ---------------------------------------------------------------------------

test('exact-name-alias：两侧都去「的」后唯一命中 → high', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_p001', name: '同分母分数的加减法', subject: '数学', chapter: '五年级' },
  ]);

  const r = matchTrapCandidates(
    [
      candidate({
        sourceRepo: 'cst',
        sourceId: 'mt_x1',
        topicName: '同分母分数加减法',
        stage: '小学',
      }),
    ],
    index
  );

  assert.equal(r.entries[0].matchMethod, 'exact-name-alias');
  assert.equal(r.entries[0].knowledgeId, 'cnm_p001');
  assert.equal(r.entries[0].matchConfidence, 'high');
});

test('exact-name-alias：命中多个时不猜（退回 unmatched）', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_p001', name: '分数的加减', subject: '数学', chapter: '五年级' },
    { id: 'cnm_p002', name: '分数的加减', subject: '数学', chapter: '六年级' },
  ]);

  const r = matchTrapCandidates(
    [
      candidate({
        sourceRepo: 'cst',
        sourceId: 'mt_x1',
        topicName: '分数加减',
        stage: '小学',
      }),
    ],
    index
  );

  assert.equal(r.entries[0].knowledgeId, null);
  assert.equal(r.entries[0].matchConfidence, 'unmatched');
});

test('exact-name-alias：学科/学段不符仍然否决', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_p001', name: '同分母分数的加减法', subject: '数学', chapter: '五年级' },
  ]);

  const r = matchTrapCandidates(
    [
      candidate({
        sourceRepo: 'cst',
        sourceId: 'mt_x1',
        topicName: '同分母分数加减法',
        stage: '初中',
      }),
    ],
    index
  );

  assert.equal(r.entries[0].knowledgeId, null);
});

test('exact-name-alias：转换器显式给出的别名也能命中', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_x1', name: '有理数的绝对值', subject: '数学', chapter: '七上' },
  ]);

  const r = matchTrapCandidates(
    [
      candidate({
        sourceRepo: 'cst',
        sourceId: 'mt_x2',
        topicName: '完全不同的名字',
        topicAliases: ['有理数绝对值'],
        stage: '初中',
      }),
    ],
    index
  );

  assert.equal(r.entries[0].matchMethod, 'exact-name-alias');
  assert.equal(r.entries[0].knowledgeId, 'cnm_x1');
});

test('匹配器统计含 exact-name-alias 计数', () => {
  const index = buildKnowledgeIndex([
    { id: 'cnm_p001', name: '同分母分数的加减法', subject: '数学', chapter: '五年级' },
  ]);
  const r = matchTrapCandidates(
    [
      candidate({
        sourceRepo: 'cst',
        sourceId: 'mt_x1',
        topicName: '同分母分数加减法',
        stage: '小学',
      }),
    ],
    index
  );
  assert.equal(r.summary.byMethod['exact-name-alias'], 1);
});

// ---------------------------------------------------------------------------
// 覆盖层
// ---------------------------------------------------------------------------

test('formatTrapText：三段式压成一行', () => {
  assert.equal(
    formatTrapText({ wrong: 'A', why: 'B', right: 'C' }),
    'A（B）→ C'
  );
  assert.equal(formatTrapText({ wrong: 'A', why: '', right: '' }), 'A');
  assert.equal(formatTrapText({ wrong: '', why: '', right: 'C' }), 'C');
});

test('applyTrapSets：只处理 ACTIVE，DRAFT 不生效', () => {
  const kps = [{ id: 'cnm_x1', commonTraps: [] as string[] }];
  const questions = [{ id: 'q1', commonErrors: [] as string[] }];

  const entry = {
    id: 'e1',
    knowledgeId: 'cnm_x1',
    questionIds: ['q1'],
    subject: '数学',
    stage: '初中',
    matchConfidence: 'high' as const,
    matchMethod: 'source-topic' as const,
    wrong: 'A',
    why: '',
    right: '',
    sourceId: 's1',
  };

  applyTrapSets(kps, questions, [trapSet({ status: 'DRAFT', entries: [entry] })]);
  assert.equal(kps[0].commonTraps.length, 0);

  applyTrapSets(kps, questions, [trapSet({ status: 'ACTIVE', entries: [entry] })]);
  assert.equal(kps[0].commonTraps.length, 1);
  assert.equal(questions[0].commonErrors.length, 1);
});

test('applyTrapSets：只追加不覆盖，且去重', () => {
  const kps = [{ id: 'cnm_x1', commonTraps: ['教师手写的避坑点'] }];
  const entry = {
    id: 'e1',
    knowledgeId: 'cnm_x1',
    questionIds: [],
    subject: '数学',
    stage: '初中',
    matchConfidence: 'high' as const,
    matchMethod: 'source-topic' as const,
    wrong: 'A',
    why: '',
    right: '',
    sourceId: 's1',
  };

  applyTrapSets(kps, [], [trapSet({ entries: [entry, entry] })]);
  assert.deepEqual(kps[0].commonTraps, ['教师手写的避坑点', 'A']);
});

test('applyTrapSets：无 knowledgeId 且无 questionIds 的条目被跳过', () => {
  const kps = [{ id: 'cnm_x1', commonTraps: [] as string[] }];
  const entry = {
    id: 'e1',
    knowledgeId: null,
    questionIds: [],
    subject: '数学',
    stage: '初中',
    matchConfidence: 'unmatched' as const,
    matchMethod: 'none' as const,
    wrong: 'A',
    why: '',
    right: '',
    sourceId: 's1',
  };

  const result = applyTrapSets(kps, [], [trapSet({ entries: [entry] })]);
  assert.equal(result.skippedUnmatched, 1);
  assert.equal(kps[0].commonTraps.length, 0);
});
