import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMathSegments, hasMath } from '../src/utils/math.ts';

/**
 * LaTeX 片段切分器的纯函数单测。
 *
 * 关注三件事：
 * 1. 行内 / 行间公式能被正确切出来；
 * 2. 货币、英文缩写等 `$` 不会被误判成公式；
 * 3. 转义与未闭合定界符不会破坏原文。
 */
describe('LaTeX 片段切分', () => {
  it('切出普通文本与行内公式', () => {
    const segments = parseMathSegments('用公式法解 $2x^{2}-3x+1=0$ 时');
    assert.deepEqual(segments, [
      { kind: 'text', value: '用公式法解 ' },
      { kind: 'math', value: '2x^{2}-3x+1=0', display: false },
      { kind: 'text', value: ' 时' },
    ]);
  });

  it('连续多个行内公式都能切出', () => {
    const segments = parseMathSegments('得 $x=2$ 或 $x=1$。');
    const math = segments.filter((s) => s.kind === 'math');
    assert.equal(math.length, 2);
    assert.deepEqual(
      math.map((s) => (s.kind === 'math' ? s.value : '')),
      ['x=2', 'x=1'],
    );
  });

  it('$$...$$ 识别为行间公式', () => {
    const segments = parseMathSegments('$$x=\\frac{1}{2}$$');
    assert.deepEqual(segments, [{ kind: 'math', value: 'x=\\frac{1}{2}', display: true }]);
  });

  it('LaTeX 风格定界符 \\( \\) 与 \\[ \\] 也能识别', () => {
    assert.deepEqual(parseMathSegments('\\(x^2\\)'), [
      { kind: 'math', value: 'x^2', display: false },
    ]);
    assert.deepEqual(parseMathSegments('\\[x^2\\]'), [
      { kind: 'math', value: 'x^2', display: true },
    ]);
  });

  it('货币写法不会被误判为公式', () => {
    const segments = parseMathSegments('本套卷满分 100 $5 元和 10 元 的补贴');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, 'text');
    assert.equal(hasMath('价格是 $5 元和 10 元'), false);
  });

  it('行内公式内容含空格时保持原样（不误判）', () => {
    const segments = parseMathSegments('价格 $5 元 到 $10 元');
    assert.equal(hasMath('价格 $5 元 到 $10 元'), false);
  });

  it('转义的美元符号按字面量输出', () => {
    const segments = parseMathSegments('价格 \\$5 元');
    assert.deepEqual(segments, [{ kind: 'text', value: '价格 $5 元' }]);
  });

  it('未闭合的定界符保持为普通文本', () => {
    const segments = parseMathSegments('写的是 $x^2 没有结尾');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, 'text');
  });

  it('纯文本不产生数学片段', () => {
    assert.equal(hasMath('完全没有任何公式的一段文字'), false);
    assert.deepEqual(parseMathSegments('普通文本'), [
      { kind: 'text', value: '普通文本' },
    ]);
  });

  it('易错陷阱原文可被完整解析', () => {
    const raw = '用公式法解 $2x^{2}-3x+1=0$ 时，写成 $x=\\dfrac{3\\pm\\sqrt{9-8}}{2}$，得 $x=2$ 或 $x=1$。';
    const math = parseMathSegments(raw).filter((s) => s.kind === 'math');
    assert.equal(math.length, 4);
    assert.equal(hasMath(raw), true);
  });
});
