/**
 * LaTeX 片段切分器。
 *
 * 服务端与模型产出的正文用 `$...$`（行内）和 `$$...$$`（行间）包裹数学式，
 * 前端需要把这些片段交给 KaTeX 渲染，其余部分按普通文本输出。
 *
 * 这里的切分规则是**保守**的：宁可漏判为普通文本，也不要把
 * 「5 元和 10 元」这类货币写法误判成公式。
 */

export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; display: boolean };

/** 行内公式：`$` 开头不跟空白，结尾 `$` 前面不跟空白，且内容不含换行。 */
const INLINE_MATH = /^\$([^$\n]+?)\$/;

/**
 * 把一段文本切成普通文本与数学片段。
 *
 * 支持的写法：
 * - `$x^2$` 行内公式
 * - `$$x^2$$` 行间公式
 * - `\(x^2\)` / `\[x^2\]` 行内 / 行间公式
 * - `\$` 转义美元符号
 */
export function parseMathSegments(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text) {
      segments.push({ kind: 'text', value: text });
      text = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // 转义美元符号：\$ 按字面量输出
    if (ch === '\\' && input[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }

    // LaTeX 风格的行内 / 行间定界符
    if (ch === '\\' && (input[i + 1] === '(' || input[i + 1] === '[')) {
      const isDisplay = input[i + 1] === '[';
      const closer = isDisplay ? '\\]' : '\\)';
      const end = input.indexOf(closer, i + 2);
      if (end !== -1) {
        flushText();
        segments.push({ kind: 'math', value: input.slice(i + 2, end).trim(), display: isDisplay });
        i = end + 2;
        continue;
      }
    }

    if (ch === '$') {
      // 行间公式：$$...$$
      if (input[i + 1] === '$') {
        const end = input.indexOf('$$', i + 2);
        if (end !== -1) {
          flushText();
          segments.push({ kind: 'math', value: input.slice(i + 2, end).trim(), display: true });
          i = end + 2;
          continue;
        }
      }

      // 行内公式：$...$
      const matched = INLINE_MATH.exec(input.slice(i));
      if (matched) {
        const body = matched[1];
        const leadingSpace = /^\s/.test(body);
        const trailingSpace = /\s$/.test(body);
        if (!leadingSpace && !trailingSpace) {
          flushText();
          segments.push({ kind: 'math', value: body, display: false });
          i += matched[0].length;
          continue;
        }
      }

      // 不成公式的 $ 按字面量输出
      text += ch;
      i += 1;
      continue;
    }

    text += ch;
    i += 1;
  }

  flushText();
  return segments;
}

/** 文本里是否含有可渲染的数学片段。 */
export function hasMath(input: string): boolean {
  return parseMathSegments(input).some((segment) => segment.kind === 'math');
}
