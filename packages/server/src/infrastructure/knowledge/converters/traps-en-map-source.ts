/**
 * workbuddy 上海中考英语资源 → 错因候选（IO 层）。
 *
 * 本模块只做「读资源 → 结构化条目」，匹配与写盘在脚本层完成。
 *
 * 数据源（`resources/workbuddy-research/`）：
 *   - `上海中考英语完整知识地图.xlsx` → 工作表「知识地图」：338 条，每条一个易错警示
 *   - `上海中考英语核心知识点详解表.xlsx` → 工作表「知识点总表」：169 条，每条一个易错点
 *   - `上海中考英语提分实战手册.xlsx` → 工作表「抢分动作」：19 条真实失分描述（按板块组织，
 *     没有知识点 id → 进待审池）
 *
 * 为什么不直接读 html：html 与 xlsx 内容逐字一致（338/338），xlsx 更好解析也更稳。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  EnActionEntry,
  EnDetailEntry,
  EnMapEntry,
} from './traps-en-map.ts';

const require_ = createRequire(import.meta.url);
const XLSX = require_('xlsx') as {
  readFile: (path: string) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: (
      sheet: unknown,
      opts: { header: 1; defval: null; raw: boolean }
    ) => unknown[][];
  };
};

/** 工作表首行是大标题、次行是列名 → 跳过两行 */
function readSheet(file: string, sheetName: string): unknown[][] {
  if (!fs.existsSync(file)) {
    throw new Error(`源文件不存在：${file}`);
  }
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`工作表不存在：${sheetName}（${file}）`);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });
  return rows.slice(2);
}

function str(row: unknown[], i: number): string {
  const v = row[i];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 读「上海中考英语完整知识地图.xlsx」的「知识地图」工作表 */
export function loadEnMapEntries(file: string): EnMapEntry[] {
  const rows = readSheet(file, '知识地图');
  const out: EnMapEntry[] = [];
  for (const row of rows) {
    const code = str(row, 0);
    const name = str(row, 4);
    if (!code || !name) continue;
    out.push({
      code,
      name,
      explain: str(row, 5),
      example: str(row, 6),
      answer: str(row, 7),
      mistake: str(row, 8),
      related: str(row, 9),
    });
  }
  return out;
}

/** 读「上海中考英语核心知识点详解表.xlsx」的「知识点总表」工作表 */
export function loadEnDetailEntries(file: string): EnDetailEntry[] {
  const rows = readSheet(file, '知识点总表');
  const out: EnDetailEntry[] = [];
  for (const row of rows) {
    const name = str(row, 3);
    if (!name) continue;
    out.push({
      no: str(row, 0),
      module: str(row, 1),
      topic: str(row, 2),
      name,
      explain: str(row, 4),
      example: str(row, 5),
      answer: str(row, 6),
      mistake: str(row, 7),
    });
  }
  return out;
}

/** 读「上海中考英语提分实战手册.xlsx」的「抢分动作」工作表 */
export function loadEnActionEntries(file: string): EnActionEntry[] {
  const rows = readSheet(file, '抢分动作');
  const out: EnActionEntry[] = [];
  for (const row of rows) {
    const loss = str(row, 2);
    if (!loss) continue;
    out.push({
      priority: str(row, 0),
      area: str(row, 1),
      loss,
      score: str(row, 3),
      action: str(row, 4),
      acceptance: str(row, 5),
      failure: str(row, 6),
    });
  }
  return out;
}

/** 源资源目录（仓库内相对路径） */
export const EN_MAP_SOURCE_DIR = 'resources/workbuddy-research';
export const EN_MAP_FILES = {
  map: path.join(EN_MAP_SOURCE_DIR, '上海中考英语完整知识地图.xlsx'),
  detail: path.join(EN_MAP_SOURCE_DIR, '上海中考英语核心知识点详解表.xlsx'),
  action: path.join(EN_MAP_SOURCE_DIR, '上海中考英语提分实战手册.xlsx'),
};
