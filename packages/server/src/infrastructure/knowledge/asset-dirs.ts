/**
 * 资产目录解析（服务端唯一实现）。
 *
 * 规则：
 * 1. `DATA_DIR/<dir>` 里有 .json 文件 → 用它（部署时的数据卷资产）；
 * 2. 否则回落到打包目录 `packages/server/data/<dir>`；
 * 3. 都没有 → 返回 DATA_DIR 下的路径（由调用方决定如何降级）。
 *
 * 为什么回落：`DATA_DIR` 常被指向只含 `db/` 的空目录（测试、首次部署），
 * 只读 DATA_DIR 会让 seed 脚本直接 ENOENT 起不来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 打包的默认资产目录：packages/server/data */
export const PACKAGED_DATA_DIR = path.resolve(__dirname, '../../../data');

/**
 * 运行期数据目录（**每次调用时求解**，不缓存）。
 *
 * 支持 `DATA_DIR` 环境变量覆盖（与 seed.ts / backup.ts 等脚本保持一致）。
 *
 * 为什么不做成常量：测试会在 import 之前设置 `process.env.DATA_DIR`，
 * 模块级常量会在首次 import 时就固化路径，导致「改了环境变量仍读打包资产」。
 */
export function resolveDataDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : PACKAGED_DATA_DIR;
}

/** @deprecated 用 resolveDataDir()；保留导出仅为兼容既有引用点。 */
export const DATA_DIR = resolveDataDir();

/** 资产子目录名 → 解析后的绝对路径（惰性求值，构造时不做 IO） */
export type AssetDirName =
  | 'knowledge'
  | 'questions'
  | 'traps'
  | 'curriculum'
  | 'overlays'
  | 'diagnosis'
  | 'ids'
  | 'sprints';

const DIR_NAMES: AssetDirName[] = [
  'knowledge',
  'questions',
  'traps',
  'curriculum',
  'overlays',
  'diagnosis',
  'ids',
  'sprints',
];

function resolveOne(dirName: AssetDirName): string {
  const override = path.join(resolveDataDir(), dirName);
  if (
    fs.existsSync(override) &&
    fs.readdirSync(override).some((f) => f.endsWith('.json'))
  ) {
    return override;
  }
  const packaged = path.join(PACKAGED_DATA_DIR, dirName);
  if (fs.existsSync(packaged)) return packaged;
  return override;
}

/**
 * 惰性资产目录解析器。
 *
 * 用函数而不是常量对象：常量在模块加载时就会做 IO，
 * 测试里改 `DATA_DIR` 后再 import 模块会拿到旧路径。
 */
export const PACKAGED_ASSET_DIRS: Record<AssetDirName, () => string> =
  Object.fromEntries(
    DIR_NAMES.map((name) => [name, () => resolveOne(name)])
  ) as Record<AssetDirName, () => string>;
