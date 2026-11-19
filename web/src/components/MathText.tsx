/**
 * 数学正文渲染组件。
 *
 * 正文里的 `$...$` 片段交给 KaTeX 渲染成真正的数学排版（分数线、上下标、根号），
 * 其余文字按普通文本输出。KaTeX 解析失败时回退成原始字符串，不会让页面崩掉。
 */
import React, { useMemo } from 'react';
import katex from 'katex';
import { parseMathSegments } from '../utils/math.ts';

export interface MathTextProps {
  /** 含 LaTeX 的正文 */
  text: string;
  /** 附加在根节点上的类名 */
  className?: string;
  /** 根节点标签，默认 span；需要独占一行时传 div */
  as?: 'span' | 'div' | 'p' | 'li';
}

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  displayMode: false,
  strict: false,
  trust: false,
  output: 'htmlAndMathml',
};

/** 渲染单个公式；出错时返回原始 LaTeX 文本。 */
function renderMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, { ...KATEX_OPTIONS, displayMode: display });
  } catch {
    return source;
  }
}

export const MathText: React.FC<MathTextProps> = ({ text, className, as = 'span' }) => {
  const segments = useMemo(() => {
    if (!text) return [];
    return parseMathSegments(text).map((segment) =>
      segment.kind === 'math'
        ? { ...segment, html: renderMath(segment.value, segment.display) }
        : segment,
    );
  }, [text]);

  const Tag = as;

  if (!text) return null;

  return (
    <Tag className={className}>
      {segments.map((segment, index) =>
        segment.kind === 'math' ? (
          <span
            key={index}
            className={segment.display ? 'math-block' : 'math-inline'}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ) : (
          <React.Fragment key={index}>{segment.value}</React.Fragment>
        ),
      )}
    </Tag>
  );
};

export default MathText;
