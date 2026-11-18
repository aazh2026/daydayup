/**
 * 确定性纯函数判题引擎（JudgeEngine）。
 *
 * 作为练习评测的第一道关卡：
 * - 纯函数、无 IO、零网络开销、毫秒级执行；
 * - 针对客观选择题、纯数值/分数填空、规范化化学式及大小写/标点容错场景，提供 100% 确定的正误裁决；
 * - 仅当判定不一致或无法确定（需要细分五维错因、或者属于非标准简答题）时，才回落给第二道 LLM 评测。
 */

import type { ErrorType, ConfidenceLevel } from '@daydayup/contracts';

export interface DeterministicJudgeResult {
  /** 是否能够给出确定性裁决 */
  isDeterministic: boolean;
  /** 判定正误 */
  isCorrect?: boolean;
  /** 反馈语 */
  feedback?: string;
  /** 错因归类 */
  errorType?: ErrorType | '无';
  /** 置信度 */
  confidence?: ConfidenceLevel;
  /** 改进建议 */
  guidance?: string;
}

/**
 * 字符规范化：全角转半角、统一符号、修剪空格与末尾标点
 */
export function normalizeText(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    // 全角字母/数字转半角
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 全角空格转半角
    .replace(/\u3000/g, ' ')
    // 统一中英文标点为英文
    .replace(/，/g, ',')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/[。！？\?!]/g, '')
    // 移除两端引号
    .replace(/^["'“”‘']+|["'“”‘']+$/g, '')
    // 压缩连续空白
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从文本中提取单选选项字母（A/B/C/D）
 */
export function extractChoiceOption(text: string): string | null {
  const cleaned = normalizeText(text).toUpperCase();
  // 匹配类似 "A", "A.", "A、", "(A)", "【A】", "选A", "A项"
  const match = /^(?:\(|\[|【|选)?([A-D])(?:\.|\)|\]|】|项|、|\s|$)/i.exec(cleaned);
  if (match) return match[1].toUpperCase();

  // 若只有单一有效字符且为 A-D
  if (/^[A-D]$/i.test(cleaned)) return cleaned;
  return null;
}

/**
 * 解析数值（支持带符号、小数、分数形如 1/2, -3/4）
 */
export function parseNumericValue(text: string): number | null {
  const s = normalizeText(text).replace(/\s+/g, '');
  // 普通小数或整数
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) {
    const val = Number.parseFloat(s);
    return Number.isFinite(val) ? val : null;
  }
  // 分数 a/b
  const fracMatch = /^([+-]?\d+)\/(\d+)$/.exec(s);
  if (fracMatch) {
    const num = Number.parseInt(fracMatch[1], 10);
    const den = Number.parseInt(fracMatch[2], 10);
    if (den !== 0) return num / den;
  }
  return null;
}

/**
 * 确定性判题函数。
 */
export function judgeAnswerDeterministically(
  _stem: string,
  standardAnswer: string,
  studentAnswer: string
): DeterministicJudgeResult {
  const normStd = normalizeText(standardAnswer);
  const normStu = normalizeText(studentAnswer);

  if (!normStu) {
    return {
      isDeterministic: true,
      isCorrect: false,
      feedback: '未作答或回答为空。',
      errorType: '审题问题',
      confidence: '确定',
      guidance: '请先尝试写出解题的关键公式或已知量。',
    };
  }

  // 1. 尝试作为选择题判定（选项字母）
  const stdOpt = extractChoiceOption(standardAnswer);
  const stuOpt = extractChoiceOption(studentAnswer);

  if (stdOpt && stuOpt) {
    if (stdOpt === stuOpt) {
      return {
        isDeterministic: true,
        isCorrect: true,
        feedback: `回答正确！选项 ${stuOpt} 准确无误。`,
        errorType: '无',
        confidence: '确定',
        guidance: '已完全掌握该题考查的核心模型与辨析要点。',
      };
    }
    // 选择题答错：返回不确定，以便大模型分析错选了哪一项并归因
    return {
      isDeterministic: false,
    };
  }

  // 2. 数值或分数等价判定
  const stdNum = parseNumericValue(standardAnswer);
  const stuNum = parseNumericValue(studentAnswer);

  if (stdNum !== null && stuNum !== null) {
    // 浮点容差 1e-6
    if (Math.abs(stdNum - stuNum) < 1e-6) {
      return {
        isDeterministic: true,
        isCorrect: true,
        feedback: '运算正确！数值结果完全一致。',
        errorType: '无',
        confidence: '确定',
        guidance: '数值计算与符号推导规范准确。',
      };
    }
  }

  // 3. 忽略大小写的严格文本等价（如化学式、英文单词、简易代数式）
  if (normStd.toLowerCase() === normStu.toLowerCase()) {
    return {
      isDeterministic: true,
      isCorrect: true,
      feedback: '回答正确！表达式与规范答案完全一致。',
      errorType: '无',
      confidence: '确定',
      guidance: '表达精准，书写符合规范。',
    };
  }

  // 无法确定，回退到 LLM 评测
  return {
    isDeterministic: false,
  };
}
