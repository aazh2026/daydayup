import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  extractChoiceOption,
  parseNumericValue,
  judgeAnswerDeterministically,
} from '../src/engines/judge-engine.ts';

describe('JudgeEngine 纯函数判题层', () => {
  test('文本规范化与全角转半角', () => {
    assert.equal(normalizeText('　Ａ． 选项一。 '), 'A. 选项一');
    assert.equal(normalizeText('２＋３＝５！'), '2+3=5');
    assert.equal(normalizeText('“hello, world。”'), 'hello, world');
  });

  test('提取选择题选项', () => {
    assert.equal(extractChoiceOption('A'), 'A');
    assert.equal(extractChoiceOption('A. 选项内容'), 'A');
    assert.equal(extractChoiceOption('【B】'), 'B');
    assert.equal(extractChoiceOption('(C) 对称轴'), 'C');
    assert.equal(extractChoiceOption('选D项'), 'D');
    assert.equal(extractChoiceOption('不知道'), null);
  });

  test('解析数值与分数', () => {
    assert.equal(parseNumericValue('42'), 42);
    assert.equal(parseNumericValue('-3.14'), -3.14);
    assert.equal(parseNumericValue('1/2'), 0.5);
    assert.equal(parseNumericValue('-3/4'), -0.75);
    assert.equal(parseNumericValue('abc'), null);
  });

  test('选择题作答一致时直接秒级判对', () => {
    const res = judgeAnswerDeterministically('题干', 'A. 顶点坐标为(2,1)', 'A');
    assert.equal(res.isDeterministic, true);
    assert.equal(res.isCorrect, true);
    assert.equal(res.errorType, '无');
  });

  test('数值与等价分数秒级判对', () => {
    const res1 = judgeAnswerDeterministically('计算', '0.5', '1/2');
    assert.equal(res1.isDeterministic, true);
    assert.equal(res1.isCorrect, true);

    const res2 = judgeAnswerDeterministically('解方程', '5', ' 5 ');
    assert.equal(res2.isDeterministic, true);
    assert.equal(res2.isCorrect, true);
  });

  test('空作答判错', () => {
    const res = judgeAnswerDeterministically('题干', 'A', '');
    assert.equal(res.isDeterministic, true);
    assert.equal(res.isCorrect, false);
    assert.equal(res.errorType, '审题问题');
  });

  test('答错或复杂非确定题目回退大模型', () => {
    // 选项不同（需要分析错因）
    const res1 = judgeAnswerDeterministically('题干', 'A', 'B');
    assert.equal(res1.isDeterministic, false);

    // 复杂解答叙述
    const res2 = judgeAnswerDeterministically('简答题', '因为三角形内角和为180度', '角A加角B等于180减角C');
    assert.equal(res2.isDeterministic, false);
  });
});
