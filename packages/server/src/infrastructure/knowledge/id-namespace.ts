/**
 * 知识点 id 命名空间（主键收敛的唯一事实源）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 *
 * 项目里同时存在四套外部 id 体系：
 *
 *   | 来源                        | id 形态              | 例                        |
 *   |-----------------------------|----------------------|---------------------------|
 *   | cn-math-taxonomy（旧节点）  | `cnm_ext_*`          | `cnm_ext_002`             |
 *   | china-skill-taxonomy        | `mt_*`               | `mt_num-10-recognition`   |
 *   | junior-math-atlas           | `m1-00-03-*`         | `m1-00-03-number-line-*`  |
 *   | workbuddy 英语知识地图       | `01.01.01.01`        | `01.02.03.07`             |
 *
 * 它们**只能做映射，绝不能当主键**：
 * 学生的掌握度记录、错因条目、题目外键、任务表都用 knowledgeId 做键。
 * 一旦某条数据把外部 id 当主键写进去，学生数据就会「静默失效」——
 * 排课查不到知识点、掌握度对不上、错因挂不上去，而且**不报错**。
 *
 * ── 收敛规则 ──────────────────────────────────────────────────────────
 *
 * 1. 项目原生 id 只有一种形态：`<学科前缀>_<段>_<序号>`（见 NATIVE_ID_PATTERN）。
 * 2. 学科前缀固定五类，且与 Subject 一一对应（见 NAMESPACE_SUBJECT）。
 * 3. 叠加层（overlay）用独立前缀 `cne_wb_*`，避免与主资产 id 冲突。
 * 4. 外部 id 一律通过 `resolveKnowledgeIds()` 解析成本原生 id；
 *    解析不到 → 保留为待审，绝不写进任何生效资产。
 */

/** 学科前缀 → 学科 */
export const NAMESPACE_SUBJECT = {
  cnm: '数学',
  cne: '英语',
  cnc: '语文',
  cnp: '物理',
  cnk: '化学',
} as const;

export type NativeNamespace = keyof typeof NAMESPACE_SUBJECT;

/** 叠加层前缀（英语缺口域，与主资产隔离） */
export const OVERLAY_PREFIX = 'cne_wb';

/**
 * 项目原生知识点 id 形态。
 *
 * 形如 `cnm_p001`、`cnm_017`、`cne_p001`、`cne_wb_0102030101`。
 * 要求：前缀合法 + 至少两段 + 段内只允许小写字母、数字、下划线。
 *
 * ⚠️ `cnm_ext_*` 必须在正则之外单独排除 ——
 * `cnm_ext_002` 的形状完全符合上面的正则（`ext` 段只含小写字母），
 * 若不排除，历史外节点会被当成正式知识点，让「主键收敛」这条红线形同虚设。
 */
export const NATIVE_ID_PATTERN = /^(cnm|cne|cnc|cnp|cnk)(_[a-z0-9]+)+$/;

/** 历史外节点前缀（cn-mt 已从 topics.json 删除的节点） */
export const LEGACY_EXT_PREFIX = 'cnm_ext_';

/** 是否为项目原生知识点 id */
export function isNativeKnowledgeId(id: string): boolean {
  if (id.startsWith(LEGACY_EXT_PREFIX)) return false;
  return NATIVE_ID_PATTERN.test(id);
}

/**
 * 从原生 id 推断学科。
 *
 * 无法推断时返回 null —— 调用方据此判定「这个 id 不该出现在数学数据里」。
 */
export function subjectOfNativeId(id: string): string | null {
  const prefix = id.split('_')[0] as NativeNamespace;
  return NAMESPACE_SUBJECT[prefix] ?? null;
}

/** 外部 id 的来源命名空间（用于映射表与审计） */
export type ExternalNamespace =
  | 'cnm-ext' // cn-math-taxonomy 的历史外节点
  | 'mt' // china-skill-taxonomy
  | 'atlas' // junior-math-atlas
  | 'workbuddy' // workbuddy 英语知识地图
  | 'unknown';

/**
 * 判断一个 id 属于哪套外部命名空间。
 *
 * 注意：`cnm_ext_002` 必须先于 `cnm_*` 判断，
 * 否则 `cnm_ext_002` 会被 `NATIVE_ID_PATTERN` 误判为原生 id
 * （`ext` 段只含小写字母，会通过校验）。
 */
export function classifyExternalId(id: string): ExternalNamespace {
  if (id.startsWith('cnm_ext_')) return 'cnm-ext';
  if (id.startsWith('mt_')) return 'mt';
  if (/^m[0-9]-[0-9]{2}-/.test(id)) return 'atlas';
  if (/^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$/.test(id)) return 'workbuddy';
  return 'unknown';
}

/**
 * 判断 id 是否是「外部命名空间的 id」。
 *
 * 外部 id 即使形状像原生 id（如 `cnm_ext_002`）也算外部。
 */
export function isExternalId(id: string): boolean {
  return classifyExternalId(id) !== 'unknown';
}
