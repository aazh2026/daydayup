/**
 * AI 输出 schema 校验测试。
 *
 * Gemini 的 responseSchema 是**软约束** —— 模型仍可能返回不符合结构的内容。
 * 这个校验器是 AI 输出进入业务逻辑前的最后一道关卡：
 * 它放行的结构，会直接写进掌握度、错题记录、计划。
 *
 * 因此必须锁死：
 * - 缺必填字段 → 拒绝
 * - 类型不符 → 拒绝
 * - 嵌套结构 → 逐层校验
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema } from '../src/infrastructure/ai/schema-validator.ts';
import type { AIJsonSchema } from '../src/infrastructure/ai/provider.ts';

describe('基础类型校验', () => {
  test('STRING 只接受字符串', () => {
    const schema: AIJsonSchema = { type: 'STRING' };
    assert.equal(validateAgainstSchema('x', schema), true);
    assert.equal(validateAgainstSchema('', schema), true);
    assert.equal(validateAgainstSchema(123, schema), false);
    assert.equal(validateAgainstSchema(null, schema), false);
    assert.equal(validateAgainstSchema(undefined, schema), false);
  });

  test('NUMBER 只接受有限数字', () => {
    const schema: AIJsonSchema = { type: 'NUMBER' };
    assert.equal(validateAgainstSchema(1, schema), true);
    assert.equal(validateAgainstSchema(0, schema), true);
    assert.equal(validateAgainstSchema(-1.5, schema), true);
    assert.equal(validateAgainstSchema(NaN, schema), false, 'NaN 应被拒绝');
    assert.equal(validateAgainstSchema(Infinity, schema), false, 'Infinity 应被拒绝');
    assert.equal(validateAgainstSchema('1', schema), false);
    assert.equal(validateAgainstSchema(null, schema), false);
  });

  test('BOOLEAN 只接受布尔', () => {
    const schema: AIJsonSchema = { type: 'BOOLEAN' };
    assert.equal(validateAgainstSchema(true, schema), true);
    assert.equal(validateAgainstSchema(false, schema), true);
    assert.equal(validateAgainstSchema('true', schema), false);
    assert.equal(validateAgainstSchema(0, schema), false);
  });
});

describe('对象校验', () => {
  const schema: AIJsonSchema = {
    type: 'OBJECT',
    required: ['title', 'score'],
    properties: {
      title: { type: 'STRING' },
      score: { type: 'NUMBER' },
      note: { type: 'STRING' },
    },
  };

  test('合法对象通过', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: 88 }, schema),
      true
    );
  });

  test('缺少必填字段被拒绝', () => {
    assert.equal(validateAgainstSchema({ title: '期中' }, schema), false);
    assert.equal(validateAgainstSchema({}, schema), false);
  });

  test('必填字段为 undefined 被拒绝', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: undefined }, schema),
      false
    );
  });

  test('必填字段类型不符被拒绝', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: '88' }, schema),
      false
    );
    assert.equal(
      validateAgainstSchema({ title: 123, score: 88 }, schema),
      false
    );
  });

  test('可选字段类型不符被拒绝', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: 88, note: 42 }, schema),
      false
    );
  });

  test('可选字段缺失不拒绝', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: 88 }, schema),
      true
    );
  });

  test('额外字段不影响校验', () => {
    assert.equal(
      validateAgainstSchema({ title: '期中', score: 88, extra: true }, schema),
      true
    );
  });

  test('数组不是对象', () => {
    assert.equal(validateAgainstSchema([], schema), false);
  });

  test('null 不是对象', () => {
    assert.equal(validateAgainstSchema(null, schema), false);
  });
});

describe('数组校验', () => {
  const schema: AIJsonSchema = {
    type: 'ARRAY',
    items: { type: 'STRING' },
  };

  test('元素全部合法时通过', () => {
    assert.equal(validateAgainstSchema(['a', 'b'], schema), true);
  });

  test('空数组通过', () => {
    assert.equal(validateAgainstSchema([], schema), true);
  });

  test('任一元素非法则整体拒绝', () => {
    assert.equal(validateAgainstSchema(['a', 5], schema), false);
    assert.equal(validateAgainstSchema([null], schema), false);
  });

  test('没有 items 定义时只校验是数组', () => {
    const loose: AIJsonSchema = { type: 'ARRAY' };
    assert.equal(validateAgainstSchema([1, 2, 3], loose), true);
    assert.equal(validateAgainstSchema('not array', loose), false);
  });
});

describe('嵌套结构校验', () => {
  const schema: AIJsonSchema = {
    type: 'OBJECT',
    required: ['meta', 'items'],
    properties: {
      meta: {
        type: 'OBJECT',
        required: ['version'],
        properties: { version: { type: 'STRING' } },
      },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['id', 'value'],
          properties: {
            id: { type: 'STRING' },
            value: { type: 'NUMBER' },
          },
        },
      },
    },
  };

  test('深层结构合法时通过', () => {
    assert.equal(
      validateAgainstSchema(
        {
          meta: { version: 'v1' },
          items: [{ id: 'a', value: 1 }],
        },
        schema
      ),
      true
    );
  });

  test('嵌套对象缺必填字段被拒绝', () => {
    assert.equal(
      validateAgainstSchema({ meta: {}, items: [] }, schema),
      false
    );
  });

  test('数组元素对象缺必填字段被拒绝', () => {
    assert.equal(
      validateAgainstSchema(
        { meta: { version: 'v1' }, items: [{ id: 'a' }] },
        schema
      ),
      false
    );
  });
});

describe('异常输入', () => {
  test('schema 为 null 时拒绝一切', () => {
    assert.equal(validateAgainstSchema({ a: 1 }, null as never), false);
    assert.equal(validateAgainstSchema(null, null as never), false);
  });

  test('schema 非对象时拒绝一切', () => {
    assert.equal(validateAgainstSchema({ a: 1 }, 'x' as never), false);
    assert.equal(validateAgainstSchema({ a: 1 }, 42 as never), false);
  });

  /**
   * 未知类型当前是「放行」（fail-open）。
   *
   * 这是刻意保留的：Gemini 后续新增 schema 类型时，
   * 老版本校验器不应把合法输出全拒了。
   *
   * 但它意味着**拼错的类型名会静默放行**——
   * 所以这条行为必须被测试锁住，改动时要有意识地决定。
   */
  test('未知类型放行（fail-open，刻意保留）', () => {
    assert.equal(
      validateAgainstSchema({ anything: true }, { type: 'WHATEVER' as never }),
      true
    );
  });
});
