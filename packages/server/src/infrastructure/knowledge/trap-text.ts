/**
 * 错因匹配用的中文文本工具（纯函数，无 IO）。
 *
 * 存在的原因：中文没有空格，标题匹配不能只做「字符串相等」也不能做
 * bigram/Jaccard 相似度（短标题上几乎无效）。可行的做法是
 * **按语义连接词切分 + 保留原短语**，让「有理数的分类」这类标题
 * 既能整体匹配（name==title），也能拆成「有理数 / 分类」做部分匹配。
 *
 * 三条经验（来自实测，勿轻易推翻）：
 *   1. 切分结果必须与原短语**取并集** —— 只切不保留会把覆盖率拉低约 10%；
 *   2. 不能按「的」直接切（会误杀「相反数」「绝对值」这类核心词）；
 *   3. STOP 词表只能用于**弱证据**（正文/软证据），不能用于资产名本身。
 */

/** 归一化：去空白与标点、全角转半角、小写 */
export function normalizeText(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s·・．.,;:!?'"()（）\[\]【】《》「」『』、\-_/\\]/g, '')
    .toLowerCase();
}

/** 只保留中日韩汉字、字母与数字（用于去掉公式符号与标点） */
export function cjkOnly(text: string): string {
  return text.replace(/[^一-龥a-z0-9]/g, '');
}

/**
 * 通用词表：这些词在任何数学标题里都高频出现，
 * 出现在**正文弱证据**里不能说明「这篇讲的就是这个点」。
 *
 * ⚠️ 不得用于资产名本身的匹配（否则「相反数」「绝对值」会被误杀）。
 */
export const STOP_TERMS: ReadonlySet<string> = new Set([
  '数学', '数', '式', '量', '值', '点', '线', '面', '角', '比', '和', '差', '积', '商',
  '大小', '相等', '常见', '错误', '注意', '易错', '解答', '解法', '基本', '平面', '图形',
  '立体', '简单', '一般', '初步', '继续', '深入', '问题', '分析', '应用', '综合', '性质',
  '意义', '概念', '法则', '计算', '表示', '认识', '探究', '方法', '技巧', '过程', '步骤',
  '形式', '定义', '原理', '规律', '判定', '定理', '公式', '模型', '关系', '要点', '类型',
  '分类', '举例', '例题', '等式', '不等式', '方程', '方程组', '函数', '几何', '统计',
  '概率', '坐标系', '三角形', '四边形', '圆', '平行线', '垂线', '绝对值', '相反数',
  '倒数', '有理数', '实数', '整式', '分式', '因式分解', '二次根式', '勾股定理', '方差',
  '频数', '频率', '数轴', '图', '线段', '射线', '直线', '轴对称', '中心对称', '旋转',
  '平移', '全等', '相似', '算术平方根', '平方根', '同类项', '合并', '代入', '去括号',
  '单项式', '多项式', '通分', '约分', '幂', '指数', '科学记数法', '有效数字', '近似数',
  '象限', '一次函数', '二次函数', '反比例函数', '正比例', '样本', '总体', '个体',
  '中位数', '平均数', '众数', '扇形', '弧长', '圆锥', '柱体', '球', '投影', '视图',
  '命题', '证明', '尺规', '作图', '余角', '补角', '邻补角', '对顶角', '平行',
  '多边形', '菱形', '矩形', '正方形', '梯形', '弧', '弦', '半径', '直径', '圆心',
  '树状图', '列表', '画图', '统计图', '条形', '折线', '扇形图',
]);

/**
 * 通用尾词：标题结尾的这些词不携带区分度，
 * 切分时应去掉（「有理数的分类」→ 短语「有理数」+「分类」）。
 */
export const GENERIC_TAIL =
  /(概念|法则|性质|意义|计算|表示|认识|探究|应用|综合|方法|技巧|过程|步骤|形式|定义|原理|规律|判定|定理|公式|模型|关系|要点|类型|分类|问题|分析|举例|例题|常见|错误|注意|易错|解答|解法|基础|初步|继续|深入|特征|要素|标准|要求|内容|作用|价值|思想|应用题|解答题)$/;

/** 标题里的并列分隔符 */
const SEGMENT_SPLIT = /[、，,;；（）()\/]/;

/** 可以在短语内部断开的语义连接词 */
const BREAK_CHARS = '的与和及用在上下';

/** 按并列分隔符切段 */
export function splitSegments(text: string): string[] {
  return text
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 长句按语义连接词断开（「有理数的加减混合运算」→「有理数」「加减混合运算」） */
export function splitLong(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of [...text]) {
    if (BREAK_CHARS.includes(ch)) {
      if (buf.length >= 2) out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

/** 去掉通用尾词与尾部连接词 */
export function trimGenericTail(text: string): string {
  let out = cjkOnly(text).replace(GENERIC_TAIL, '').trim();
  out = out.replace(/[的与和及]$/, '');
  return out;
}

/**
 * 以「的」开头的短语一定是碎片。
 *
 * 「频率（相对频数）的计算与意义」按括号切段后得到「的计算与意义」，
 * 去掉通用尾词后剩下「的计算」—— 这三个字在几乎任何正文里都出现，
 * 进 `name-in-body`（88 分）就是纯噪声。
 */
function startsWithParticle(text: string): boolean {
  return text.startsWith('的');
}

/**
 * 把一段中文切成候选短语。
 *
 * @param text 原始文本
 * @param dropStop 是否丢弃 STOP 词（只对弱证据文本开启）
 */
export function phrases(text: string, dropStop = false): string[] {
  const out: string[] = [];
  for (const seg of splitSegments(text)) {
    // 原段落与断开结果取并集 —— 只切不保留会显著掉覆盖率
    for (const part of [seg, ...splitLong(seg)]) {
      const trimmed = trimGenericTail(part);
      if (trimmed.length < 2) continue;
      if (dropStop && STOP_TERMS.has(trimmed)) continue;
      out.push(trimmed);
      // 原段落本身也要保留：去掉通用尾词会把「勾股定理」削成「勾股」，
      // 于是同名主题只能拿到弱证据分（实测：初中数学 high 覆盖率损失约 8%）。
      if (part === seg && part !== trimmed && part.length >= 3) {
        if (!(dropStop && STOP_TERMS.has(part))) out.push(part);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * 知识点名的候选短语 —— **只取完整并列段**，不取按连接词断开的碎片。
 *
 * 与 `phrases()` 的区别：断开的碎片（「加法运算律与简便运算」→「简便运算」）
 * 在正文里到处都是，会把 `name-in-body`（88 分，high）变成噪声 ——
 * 实测会让「加法运算律」误挂到八上「整式的乘法与乘法公式」上。
 * 碎片仍可通过 `nameTerms()` 参与**标题/关键词**弱匹配（term-in-title 85）。
 */
export function namePhrases(name: string): string[] {
  const out: string[] = [];
  for (const seg of splitSegments(name)) {
    const trimmed = trimGenericTail(seg);
    if (trimmed.length >= 2 && !startsWithParticle(trimmed)) out.push(trimmed);
    if (seg !== trimmed && seg.length >= 3 && !startsWithParticle(seg)) out.push(seg);
  }
  return [...new Set(out)];
}

/** 短语再按连接词拆成更小的「词」 */
export function phraseParts(phrase: string): string[] {
  const out: string[] = [];
  for (const part of phrase.split(/[的与和及]/)) {
    if (part.length >= 2) out.push(part);
  }
  return out;
}

/** 知识点名的候选短语 + 更细的词 */
export function nameTerms(name: string): string[] {
  const out: string[] = [];
  for (const p of namePhrases(name)) out.push(p, ...phraseParts(p));
  return [...new Set(out)];
}

/** 弱证据文本（子技能、定义）的候选短语（过滤 STOP） */
export function softPhrases(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    out.push(...phrases(t, true), ...phraseParts(t).filter((p) => !STOP_TERMS.has(p)));
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 教材册次 / 章 / 节
// ---------------------------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → 阿拉伯数字（支持 一 ~ 九十九 的常用写法） */
export function cnToNumber(text: string | undefined | null): number | null {
  if (!text) return null;
  if (text === '十') return 10;
  if (text.length === 2 && text[1] === '十') return (CN_DIGITS[text[0]] ?? 0) * 10;
  if (text.length === 2 && text[0] === '十') return 10 + (CN_DIGITS[text[1]] ?? 0);
  if (text.length === 3 && text[1] === '十') {
    return (CN_DIGITS[text[0]] ?? 0) * 10 + (CN_DIGITS[text[2]] ?? 0);
  }
  if (text.length === 1) return CN_DIGITS[text] ?? null;
  return null;
}

/** 教材册次（人教版初中：七上/七下/八上/八下/九上/九下） */
export type Volume = '七上' | '七下' | '八上' | '八下' | '九上' | '九下';

/** 知识点在教材里的位置 */
export interface KnowledgeScope {
  /** 册次，如「七上」 */
  volume?: string;
  /** 章号（阿拉伯数字字符串），如「1」 */
  chapter?: string;
  /** 节号，如「1.1」「3.2.1」 */
  section?: string;
}

/** 来源主题在教材里的位置（可能只覆盖若干节） */
export interface TrapScope {
  volume?: string;
  /** 一个主题可能横跨多个册次（如「数与式」既在七上也在八上） */
  volumes?: string[];
  chapter?: string;
  sections?: string[];
}

const VOLUME_RE = /^(七上|七下|八上|八下|九上|九下)/;
const CHAPTER_RE = /第([一二三四五六七八九十]+)章/;
const SECTION_RE = /(\d+(?:\.\d+)*)\s*$/;

/**
 * 从知识资产的 `chapter` 字段解析教材位置。
 *
 * 形如 `七上 第一章 有理数 1.1` → { volume: '七上', chapter: '1', section: '1.1' }
 */
export function parseChapterScope(chapter: string | undefined | null): KnowledgeScope {
  if (!chapter) return {};
  const scope: KnowledgeScope = {};

  const vol = chapter.match(VOLUME_RE);
  if (vol) scope.volume = vol[1];

  const chap = chapter.match(CHAPTER_RE);
  if (chap) {
    const num = cnToNumber(chap[1]);
    if (num != null) scope.chapter = String(num);
  }

  const sec = chapter.match(SECTION_RE);
  if (sec) scope.section = sec[1];

  return scope;
}

/** 节号是否相交（`1.1` 与 `1.1.1` 视为同节） */
export function sectionOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * 知识点位置与来源主题位置是否相容。
 *
 * 册次/章号必须一致（硬门槛）；节号相交即可
 * （来源主题常覆盖整章，知识点只落在其中一节）。
 */
export function scopeHit(knowledge: KnowledgeScope, source: TrapScope): boolean {
  if (knowledge.volume && source.volume && knowledge.volume !== source.volume) return false;
  if (knowledge.chapter && source.chapter && knowledge.chapter !== source.chapter) return false;
  if (knowledge.section && source.sections?.length) {
    return source.sections.some((s) => sectionOverlap(knowledge.section!, s));
  }
  return true;
}

/**
 * 知识点与来源主题的**册次冲突**（软判定）。
 *
 * 与 `scopeHit` 的区别：`scopeHit` 是硬门槛（不参与打分），
 * 这里只用于把已经匹配上的证据**降级为 medium** ——
 * 「这篇确实讲了类似的东西，但不是这一册」不应该直接丢掉，
 * 但也绝不能算作 high（否则运行时 `commonTraps` 会挂错册次的坑）。
 *
 * 来源主题的册次信息缺失时（`volumes` 为空）不判冲突 —— 宁可不降级，
 * 也不误伤。
 */
export function volumeConflict(knowledge: KnowledgeScope, source: TrapScope): boolean {
  if (!knowledge.volume) return false;
  const known = source.volumes?.length ? source.volumes : source.volume ? [source.volume] : [];
  if (!known.length) return false;
  return !known.includes(knowledge.volume);
}
