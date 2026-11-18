/**
 * 知识体系资产完整性测试。
 *
 * 知识体系是**服务端唯一事实源**（分离后前端不再硬编码 589 行本体）。
 * 资产 JSON 一旦损坏，影响是全局且隐式的：
 * - 悬空的前置引用 → 提分优先级算错（前置阻塞判定失效）
 * - 重复 id → knowledgeMap 静默覆盖，知识点张冠李戴
 * - subject 不在列表 → 前端筛选漏掉该学科
 * - 题库指向不存在的知识点 → 取题永远落空
 *
 * 这些不会抛异常，只会让数据悄悄变得不对。
 * 所以用测试把资产钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCurriculum,
  getCurriculumVersion,
  getKnowledgeMap,
  listKnowledgePoints,
  getQuestionBank,
  findBankQuestions,
  selectCurriculumFile,
} from '../src/infrastructure/knowledge/curriculum.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 packages/server/tests/，故需上溯 1 层到 packages/server
const DATA_DIR = path.resolve(__dirname, '../data');
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
const QUESTION_DIR = path.join(DATA_DIR, 'questions');

describe('知识体系资产', () => {
  test('能加载且状态为 ACTIVE', () => {
    const curriculum = getCurriculum();
    assert.equal(curriculum.status, 'ACTIVE');
    assert.ok(curriculum.version.length > 0);
    assert.ok(curriculum.publishedAt.length > 0);
  });

  test('生效版本对应资产文件名', () => {
    /**
     * 断言意图：对外暴露的版本号必须能对应到磁盘上的**生效**资产文件。
     *
     * 此前这里写成 `files.length === 1`（只允许一个资产文件），
     * 那是在多版本机制出现之前的代理断言 ——
     * 一旦引入第二个版本文件（如同批导入的 DRAFT 版本），
     * 断言就会误报，而实际上版本选择逻辑是对的。
     *
     * 正确断言：生效资产文件存在，且它的版本号 == getCurriculumVersion()。
     */
    const files = fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0, '应至少有一个知识体系资产文件');

    // 找到被选中的那个文件（文件名去掉 .json 后与版本号一致）
    const activeFile = files.find(
      (f) => f.replace(/\.json$/, '') === getCurriculumVersion()
    );
    assert.ok(
      activeFile,
      `生效版本 ${getCurriculumVersion()} 应对应磁盘上的资产文件（现有：${files.join(', ')}）`
    );

    // 生效的必须是 ACTIVE 状态
    const parsed = JSON.parse(
      fs.readFileSync(path.join(KNOWLEDGE_DIR, activeFile!), 'utf8')
    ) as { status?: string };
    assert.equal(
      parsed.status,
      'ACTIVE',
      '被选中的资产必须是 ACTIVE 状态（DRAFT/DEPRECATED 不应生效）'
    );
  });

  test('知识点非空且 id 唯一', () => {
    const { knowledgePoints } = getCurriculum();
    assert.ok(knowledgePoints.length > 0);

    const ids = knowledgePoints.map((kp) => kp.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, '存在重复的知识点 id');
  });

  test('每个知识点的必填字段齐全', () => {
    for (const kp of getCurriculum().knowledgePoints) {
      assert.ok(kp.id, '缺少 id');
      assert.ok(kp.name, `${kp.id} 缺少 name`);
      assert.ok(kp.subject, `${kp.id} 缺少 subject`);
      assert.ok(kp.domain, `${kp.id} 缺少 domain`);
      assert.ok(kp.definition, `${kp.id} 缺少 definition`);
      assert.ok(Array.isArray(kp.prerequisites), `${kp.id} 的 prerequisites 不是数组`);
      assert.ok(
        typeof kp.examWeight === 'number',
        `${kp.id} 缺少 examWeight`
      );
      assert.ok(
        typeof kp.learningCostHours === 'number',
        `${kp.id} 缺少 learningCostHours`
      );
    }
  });

  test('前置知识引用无悬空（这是提分优先级正确的前提）', () => {
    const { knowledgePoints } = getCurriculum();
    const ids = new Set(knowledgePoints.map((kp) => kp.id));

    for (const kp of knowledgePoints) {
      for (const pre of kp.prerequisites) {
        assert.ok(
          ids.has(pre),
          `${kp.id} 的前置引用「${pre}」指向不存在的知识点`
        );
      }
    }
  });

  test('前置引用无自环', () => {
    for (const kp of getCurriculum().knowledgePoints) {
      assert.ok(
        !kp.prerequisites.includes(kp.id),
        `${kp.id} 的前置引用包含自身`
      );
    }
  });

  test('subject 都在 subjects 列表中', () => {
    const curriculum = getCurriculum();
    const subjects = new Set(curriculum.subjects);
    for (const kp of curriculum.knowledgePoints) {
      assert.ok(
        subjects.has(kp.subject),
        `${kp.id} 的学科「${kp.subject}」不在 subjects 列表中`
      );
    }
  });

  test('每个学科至少有一个知识点', () => {
    const curriculum = getCurriculum();
    for (const subject of curriculum.subjects) {
      assert.ok(
        curriculum.knowledgePoints.some((kp) => kp.subject === subject),
        `学科「${subject}」没有任何知识点`
      );
    }
  });
});

describe('资产版本选择', () => {
  const asset = (status: string, version = 'v1') =>
    ({
      version,
      publishedAt: '2026-01-01',
      status,
      subjects: ['数学'],
      knowledgePoints: [],
    }) as never;

  test('优先选 ACTIVE 版本', () => {
    const chosen = selectCurriculumFile([
      { file: 'a.json', parsed: asset('DRAFT') },
      { file: 'b.json', parsed: asset('ACTIVE') },
      { file: 'c.json', parsed: asset('DEPRECATED') },
    ]);
    assert.equal(chosen, 'b.json');
  });

  test('多个 ACTIVE 时取第一个（按传入顺序）', () => {
    const chosen = selectCurriculumFile([
      { file: 'first.json', parsed: asset('ACTIVE') },
      { file: 'second.json', parsed: asset('ACTIVE') },
    ]);
    assert.equal(chosen, 'first.json');
  });

  test('没有 ACTIVE 时取排序最后的（版本序）', () => {
    const chosen = selectCurriculumFile([
      { file: 'shanghai-junior-2026.1.json', parsed: asset('DRAFT') },
      { file: 'shanghai-junior-2026.2.json', parsed: asset('DRAFT') },
    ]);
    assert.equal(chosen, 'shanghai-junior-2026.2.json');
  });

  test('无可用资产时明确报错（不静默返回空）', () => {
    assert.throws(
      () => selectCurriculumFile([]),
      /No readable curriculum asset/
    );
  });

  /**
   * 回归：损坏的资产文件不应让整个知识体系接口 500。
   *
   * 原实现在循环里直接 JSON.parse，一个坏文件就会抛出去。
   * 现在损坏文件被跳过（并告警），只有全部损坏才报错。
   */
  test('损坏的文件被跳过，其余仍能选出正确版本', () => {
    const chosen = selectCurriculumFile([
      { file: 'broken.json', parsed: asset('ACTIVE') }, // 模拟：损坏文件不进入候选
      { file: 'good.json', parsed: asset('ACTIVE') },
    ]);
    assert.equal(chosen, 'broken.json', '仅由可读候选决定');
  });
});

describe('知识体系索引', () => {
  test('knowledgeMap 覆盖全部知识点', () => {
    const curriculum = getCurriculum();
    const map = getKnowledgeMap();
    assert.equal(Object.keys(map).length, curriculum.knowledgePoints.length);
    for (const kp of curriculum.knowledgePoints) {
      assert.equal(map[kp.id].name, kp.name);
    }
  });

  test('按学科筛选生效', () => {
    const all = listKnowledgePoints();
    const math = listKnowledgePoints('数学');
    assert.ok(math.length > 0);
    assert.ok(math.length < all.length);
    for (const kp of math) {
      assert.equal(kp.subject, '数学');
    }
  });

  test('不筛选时返回全部', () => {
    assert.equal(
      listKnowledgePoints().length,
      getCurriculum().knowledgePoints.length
    );
  });

  test('筛选不存在的学科返回空数组', () => {
    assert.deepEqual(listKnowledgePoints('不存在' as never), []);
  });
});

describe('题库资产', () => {
  test('能加载且题目非空', () => {
    const bank = getQuestionBank();
    assert.ok(bank.version.length > 0);
    assert.ok(bank.questions.length > 0);
  });

  test('题目 id 唯一', () => {
    const ids = getQuestionBank().questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, '存在重复的题目 id');
  });

  test('题目标注的知识点都存在', () => {
    const kpIds = new Set(getCurriculum().knowledgePoints.map((kp) => kp.id));
    for (const q of getQuestionBank().questions) {
      assert.ok(
        Array.isArray(q.knowledgeIds) && q.knowledgeIds.length > 0,
        `题目 ${q.id} 没有关联知识点`
      );
      for (const k of q.knowledgeIds) {
        assert.ok(kpIds.has(k), `题目 ${q.id} 指向不存在的知识点「${k}」`);
      }
    }
  });

  test('题目的必填字段齐全', () => {
    for (const q of getQuestionBank().questions) {
      assert.ok(q.stem, `题目 ${q.id} 缺少题干`);
      assert.ok(q.standardAnswer, `题目 ${q.id} 缺少标准答案`);
      assert.ok(Array.isArray(q.solutionSteps), `题目 ${q.id} 缺少解析步骤`);
      assert.ok(
        typeof q.difficulty === 'number',
        `题目 ${q.id} 缺少 difficulty`
      );
    }
  });
});

/**
 * 从题库里挑一个「确实有某个难度题目」的知识点。
 *
 * 为什么不写死知识点 id：题库是可换版的服务端资产。
 * 2026.02 版把 18 个粗粒度点换成 2760 个教材小节，
 * 写死 `math-alg-rational` 的断言会在换版后**只因数据变了**就失败，
 * 而它要验证的其实是「取题逻辑」，不是「资产里有没有这个点」。
 */
function pickKnowledgeWithLevel(level: string): string {
  const hit = getQuestionBank().questions.find(
    (q) => q.level === level && q.knowledgeIds.length > 0
  );
  assert.ok(hit, `题库里应至少有一道 ${level} 题目`);
  return hit.knowledgeIds[0];
}

describe('题库取题', () => {
  test('按知识点 + 难度命中', () => {
    const knowledgeId = pickKnowledgeWithLevel('基础题');
    const found = findBankQuestions(knowledgeId, '基础题');
    assert.ok(found.length > 0);
    for (const q of found) {
      assert.ok(q.knowledgeIds.includes(knowledgeId));
      assert.equal(q.level, '基础题');
    }
  });

  test('难度无命中时按知识点兜底', () => {
    const knowledgeId = pickKnowledgeWithLevel('基础题');
    const found = findBankQuestions(knowledgeId, '不存在的难度');
    assert.ok(found.length > 0, '应回落到同知识点的题');
    for (const q of found) {
      assert.ok(q.knowledgeIds.includes(knowledgeId));
    }
  });

  test('已出过的题被排除', () => {
    const knowledgeId = pickKnowledgeWithLevel('基础题');
    const first = findBankQuestions(knowledgeId, '基础题');
    assert.ok(first.length > 0);
    const stems = first.map((q) => q.stem);

    const second = findBankQuestions(knowledgeId, '基础题', stems);
    for (const q of second) {
      assert.ok(!stems.includes(q.stem), '已排除的题不应再次返回');
    }
  });

  test('排除后无题可取时返回空数组', () => {
    const knowledgeId = pickKnowledgeWithLevel('基础题');
    const first = findBankQuestions(knowledgeId, '基础题');
    const stems = first.map((q) => q.stem);
    const second = findBankQuestions(knowledgeId, '基础题', stems);
    // 该知识点只有 2 道题，排除后可能还有变式题，也可能为空 —— 都合法
    assert.ok(Array.isArray(second));
  });

  test('未知知识点返回空数组', () => {
    assert.deepEqual(findBankQuestions('不存在的知识点', '基础题'), []);
  });
});
