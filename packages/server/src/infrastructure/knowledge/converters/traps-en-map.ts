/**
 * workbuddy 上海中考英语知识地图 → 错因候选（纯函数）。
 *
 * 源资源（`resources/workbuddy-research/`）：
 *   - `上海中考英语完整知识地图.html`（= 同名 .xlsx 的「知识地图」工作表）
 *     338 条知识点，字段：code / name / explain / example / answer / mistake / related
 *   - `上海中考英语核心知识点详解表.xlsx`（工作表「知识点总表」）
 *     169 条知识点，字段：序号 / 一级模块 / 二级专题 / 知识点 / 核心解读 /
 *     真题与典型例题 / 答案解析 / **易错点** / …
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────────
 *
 * 这份资源与数学侧的三个来源有三个本质差别：
 *
 * 1. **落点是 overlay 命名空间**：地图条目的 code `01.01.01.01` 在项目里
 *    对应的是叠加层知识点 `cne_wb_01_01_01_01`（见 import-workbuddy-english.ts），
 *    不是主资产 `cne_j*` 教材单元点。因此这里直接给 `sourceTopicId`，
 *    走 `source-topic` 精确命中 —— 不猜、不靠名称模糊匹配。
 *
 * 2. **错因是单句「易错警示」**：地图的 `mistake` / 详解表的「易错点」都是
 *    一句「学生常犯什么错」，没有「为什么错 / 怎么改」的两段结构。
 *    因此只填 `wrong`，`why` / `right` 留空 ——
 *    源数据没写的部分不补（红线：错因文本全部取自源项目原句）。
 *
 * 3. **主资产点只能高置信挂载**：地图是**语法/题型**视角（如「现在完成时」），
 *    主资产是**教材单元**视角（如「读懂周末日记」），两者大面积不重合。
 *    实测名称匹配天花板只有 51/791，证据匹配 66/257 且噪声明显。
 *    所以对主资产只做**名称精确 + 前后缀包含**（排除泛成分名），
 *    且限定为「地图名 ≥ 3 字」，避免「宾语/状语/主语」这类成分名大面积误挂。
 */

import type { TrapCandidate } from './traps.ts';

// ---------------------------------------------------------------------------
// 源数据结构
// ---------------------------------------------------------------------------

/** 知识地图条目（html / xlsx「知识地图」工作表的公共字段） */
export interface EnMapEntry {
  /** 地图编码，如 `03.01.01.02` */
  code: string;
  /** 知识点名 */
  name: string;
  /** 核心解读 */
  explain?: string;
  /** 典型例题 */
  example?: string;
  /** 答案解析 */
  answer?: string;
  /** 易错警示 */
  mistake?: string;
  /** 关联节点 */
  related?: string;
}

/** 核心知识点详解表条目（xlsx「知识点总表」工作表） */
export interface EnDetailEntry {
  /** 序号 */
  no: number | string;
  /** 一级模块 */
  module: string;
  /** 二级专题 */
  topic: string;
  /** 知识点名 */
  name: string;
  /** 核心解读 */
  explain?: string;
  /** 真题与典型例题 */
  example?: string;
  /** 答案解析 */
  answer?: string;
  /** 易错点 */
  mistake?: string;
}

// ---------------------------------------------------------------------------
// id 规则
// ---------------------------------------------------------------------------

/**
 * 地图编码 → 叠加层知识点 id。
 *
 * 与 `import-workbuddy-english.ts` 的 `codeToId` **必须一致** ——
 * 两处都产出 `cne_wb_<code 下划线化>`，否则错因挂不到对应知识点上。
 */
export function enMapCodeToId(code: string): string {
  const digits = code.replace(/\./g, '_').replace(/[^0-9a-zA-Z_]/g, '');
  return `cne_wb_${digits.toLowerCase()}`;
}

/**
 * 详解表序号 → 叠加层知识点 id。
 *
 * 与 `import-workbuddy-english.ts` 的「知识点总表」条目 id 规则一致
 * （`cne_wb_dNNN`，三位补零）。
 *
 * ⚠️ **同名覆盖**：叠加层里「知识地图」优先 —— 地图与详解表同名的 39 行，
 * 叠加层只保留地图条目（`cne_wb_<code>`），详解表自己的 `cne_wb_dNNN` id
 * **并不存在**。因此详解表条目的落点必须做一次「id → 实际存在的 id」回退，
 * 否则 39 条会变成悬空外键。
 */
export function enDetailNoToId(no: number | string): string {
  const n = typeof no === 'number' ? no : Number.parseInt(String(no), 10);
  if (!Number.isFinite(n)) return '';
  return `cne_wb_d${String(n).padStart(3, '0')}`;
}
// ---------------------------------------------------------------------------
// 名称匹配（主资产高置信挂载）
// ---------------------------------------------------------------------------

/**
 * 泛成分名：这些名字只描述「句子的一个成分」，不是具体知识点。
 *
 * 命中它们几乎必然误挂（「不定式作宾语」里的「宾语」不是一个可教的点），
 * 因此**一律排除**。
 */
export const EN_GENERIC_COMPONENTS = new Set([
  '宾语',
  '状语',
  '主语',
  '表语',
  '定语',
  '谓语',
  '宾语从句',
  '主语从句',
  '定语从句',
  '状语从句',
]);

/** 名称规范化：全角转半角、去标点空白、小写（与 trap-matcher 的 normalizeName 同口径） */
export function normalizeEnName(name: string): string {
  return name
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s·・．.,;:!?'"()（）\[\]【】《》「」『』、·\-_]/g, '')
    .toLowerCase();
}

/** 地图名参与主资产匹配的最小字数（太短的专名匹配噪声大） */
export const EN_NAME_MIN_LEN = 3;

export type EnNameMatchKind = 'exact' | 'prefix' | 'suffix';

export interface EnNameMatch {
  kind: EnNameMatchKind;
  /** 匹配上的地图名 */
  matched: string;
}

/**
 * 地图名 → 主资产知识点的名称匹配（纯函数）。
 *
 * 只认三种关系，且地图名必须 ≥ `EN_NAME_MIN_LEN` 字且不是泛成分名：
 *   - `exact`  地图名 == 知识点名
 *   - `prefix` 地图名是知识点名的**前缀**（「现在进行时的构成」←「现在进行时」）
 *   - `suffix` 地图名是知识点名的**后缀**（「不定式作目的状语」←「状语」被排除；
 *            「名词性物主代词」←「物主代词」是 suffix）
 *
 * **不做 infix 匹配**：地图名出现在知识点名中间（「that 引导宾语从句」←「宾语」）
 * 几乎全是泛成分名造成的误挂。
 */
export function matchEnName(
  knowledgeName: string,
  mapNames: string[]
): EnNameMatch | null {
  const kn = normalizeEnName(knowledgeName);
  if (!kn) return null;

  for (const raw of mapNames) {
    const mn = normalizeEnName(raw);
    if (mn.length < EN_NAME_MIN_LEN) continue;
    if (EN_GENERIC_COMPONENTS.has(mn)) continue;
    if (mn === kn) return { kind: 'exact', matched: raw };
  }

  for (const raw of mapNames) {
    const mn = normalizeEnName(raw);
    if (mn.length < EN_NAME_MIN_LEN) continue;
    if (EN_GENERIC_COMPONENTS.has(mn)) continue;
    if (kn.startsWith(mn)) return { kind: 'prefix', matched: raw };
  }

  for (const raw of mapNames) {
    const mn = normalizeEnName(raw);
    if (mn.length < EN_NAME_MIN_LEN) continue;
    if (EN_GENERIC_COMPONENTS.has(mn)) continue;
    if (kn.endsWith(mn)) return { kind: 'suffix', matched: raw };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

/** 知识地图 → 错因候选（落点 = 叠加层知识点，source-topic 精确命中） */
export function convertEnMapEntries(
  entries: EnMapEntry[]
): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const e of entries) {
    const mistake = (e.mistake ?? '').trim();
    if (!e.code || !e.name || !mistake) continue;

    out.push({
      id: `en-map:${e.code}#e1`,
      sourceRepo: 'workbuddy-english-map',
      sourceId: e.code,
      sourceTopicId: enMapCodeToId(e.code),
      topicName: e.name,
      subject: '英语',
      // 地图是上海中考资料 → 初中
      stage: '初中',
      wrong: mistake,
      why: '',
      right: '',
      sourceText: [e.name, e.explain, e.example, e.answer, mistake]
        .filter(Boolean)
        .join('\n'),
    });
  }

  return out;
}

/**
 * 详解表 → 错因候选（落点 = 叠加层知识点）。
 *
 * ⚠️ **同名条目会被叠加层顶掉**：叠加层里「知识地图」优先，
 * 地图与详解表同名的 39 行，详解表自己的 `cne_wb_dNNN` id 并不存在
 * （被地图条目的 `cne_wb_<code>` 顶掉），叠加层保留的是**地图那句**。
 * 因此这些行的易错点必须**另立一条**挂在同一个知识点上，
 * 否则「详解表说更细、地图说更泛」两条信息里会丢掉更细的那条。
 *
 * `resolveTargetId` 返回落点 id；返回空串表示该行没有可用落点（丢弃）。
 */
export function convertEnDetailEntries(
  entries: EnDetailEntry[],
  /**
   * 落点 id 解析器：把「详解表条目」映射到**实际存在的**叠加层知识点 id。
   *
   * 叠加层里「知识地图」优先：地图与详解表同名的 39 行，详解表自己的
   * `cne_wb_dNNN` id 不存在（被地图条目的 `cne_wb_<code>` 顶掉）。
   * 解析器需要按名字回退到地图条目的 id，否则这 39 条会变成悬空外键。
   */
  resolveTargetId?: (entry: EnDetailEntry, defaultId: string) => string
): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  for (const e of entries) {
    const mistake = (e.mistake ?? '').trim();
    if (!e.name || !mistake) continue;
    const defaultId = enDetailNoToId(e.no);
    if (!defaultId) continue;
    const targetId = resolveTargetId ? resolveTargetId(e, defaultId) : defaultId;
    if (!targetId) continue;

    out.push({
      id: `en-detail:${e.no}#e1`,
      sourceRepo: 'workbuddy-english-map',
      sourceId: String(e.no),
      sourceTopicId: targetId,
      topicName: e.name,
      subject: '英语',
      stage: '初中',
      wrong: mistake,
      why: '',
      right: '',
      sourceText: [e.name, e.explain, e.example, e.answer, mistake]
        .filter(Boolean)
        .join('\n'),
    });
  }

  return out;
}

/**
 * 「抢分动作」表 → 错因候选（落点 = 考点，无知识点 → 题目级/待审）。
 *
 * 这份表的「具体失分形式」是**真实失分描述**（「看到括号词就凭语感直接变形，
 * 忽略空格位置」），是英语侧最有价值的错因素材 —— 但它按「板块·痛点」组织，
 * 没有知识点 id，因此条目以 `knowledgeId = null` 进入待审池，
 * 教师确认考点后再补 `id-map.json`。
 */
export interface EnActionEntry {
  priority: string;
  /** 板块·痛点 */
  area: string;
  /** 具体失分形式 */
  loss: string;
  /** 涉及分值 */
  score?: string;
  /** 立刻照做的动作 */
  action?: string;
  /** 达标验收标准 */
  acceptance?: string;
  /** 常见失败原因 */
  failure?: string;
}

export function convertEnActionEntries(
  entries: EnActionEntry[]
): TrapCandidate[] {
  const out: TrapCandidate[] = [];

  entries.forEach((e, i) => {
    const loss = (e.loss ?? '').trim();
    if (!loss) return;
    const area = (e.area ?? '').trim();

    out.push({
      id: `en-action:${i + 1}#e1`,
      sourceRepo: 'workbuddy-english-map',
      sourceId: `action-${i + 1}`,
      topicName: area,
      subject: '英语',
      stage: '初中',
      wrong: loss,
      why: '',
      right: '',
      sourceText: [
        `优先级：${e.priority ?? ''}`,
        area,
        `涉及分值：${e.score ?? ''}`,
        `具体失分形式：${loss}`,
        `立刻照做的动作：${e.action ?? ''}`,
        `达标验收标准：${e.acceptance ?? ''}`,
        `常见失败原因：${e.failure ?? ''}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  });

  return out;
}
