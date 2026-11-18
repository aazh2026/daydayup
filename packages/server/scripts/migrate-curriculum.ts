#!/usr/bin/env tsx
/**
 * 课程资产换版迁移：把学生数据里引用的旧知识点 id 改写到新资产 id。
 *
 * 背景
 * ----
 * 2026.02 版知识体系从 `cn-math-taxonomy` 导入，知识点从 18 个粗粒度
 * （`math-alg-rational` 这类人工 id）变成 2760 个细粒度（`cnm_165` 这类课程 id）。
 * 换版后，存量学生数据里的旧 id 会全部变成悬空引用：
 *
 *   - 掌握度记录查不到对应知识点 → 报告页静默丢弃
 *   - 错题/变式题的 knowledgeId 指向不存在的点 → 建议练不到题
 *   - 计划项引用旧 id → 排期空转
 *
 * 这些都不会抛异常，只会让功能**静默失效** —— 所以换版必须配套迁移。
 *
 * 映射原则
 * ----
 * 旧 id 是人为定义的**主题标签**（"有理数及其运算"），新 id 是**教材小节**。
 * 二者不是一一对应，这里按「存量数据记录的实际内容」挑选语义最近的节点，
 * 而不是按字面名称 —— 例如旧 `math-alg-rational` 字面是"有理数"，
 * 但种子数据里它的错题是**分式化简/分式方程**，故映射到 `cnm_165`。
 *
 * ⚠ 这是**迁移用的近似映射，不是等价关系**。
 *   迁移后请让教师抽样核对，尤其是高频考点。
 *
 * 用法
 * ----
 *   npx tsx scripts/migrate-curriculum.ts            # 预演，只打印不写盘
 *   npx tsx scripts/migrate-curriculum.ts --apply    # 真正写盘（先自动备份）
 *   npx tsx scripts/migrate-curriculum.ts --apply --include-seed
 *
 * 安全性
 * ----
 *   - 默认 dry-run，必须显式 `--apply`
 *   - 写盘前把原文件备份到 `DATA_DIR/backup/curriculum-migration-<时间戳>/`
 *   - 幂等：重复执行不会二次改写（旧 id 已不存在）
 *   - 迁移后校验：目标 id 必须全部存在于当前生效资产，否则退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCurriculum } from '../src/infrastructure/knowledge/curriculum.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data');

/**
 * 旧 id → 新 id。
 *
 * 第二列写的是「为什么是这个节点」，依据是存量数据里该 id 名下的真实内容，
 * 不是旧名字的字面意思。改动此表请同步更新 docs/taxonomy-import.md。
 */
export const LEGACY_ID_MAP: Record<string, string> = {
  // —— 数学 ——
  // 旧数据的错题是「分式化简求值」「分式方程增根未验」
  'math-alg-rational': 'cnm_165',
  // 旧数据的证据是「应用题列式正确但方程计算跳步」
  'math-eq-ineq': 'cnm_045',
  // 旧数据的错题是「一次函数图像求 k,b，平移符号混淆」
  'math-func-linear': 'cnm_204',
  // 旧数据的证据是「压轴最后一问未作答」
  'math-func-quadratic': 'cnm_236',
  // 旧数据的证据是「缺乏角平分线辅助线构造思路」
  'math-geo-triangle': 'cnm_130',
  // 旧数据的错题是「不放回摸球求概率」
  'math-stat-prob': 'cnm_286',

  // —— 英语 ——
  // 旧数据的错题是「It is ____ (polite)」词性/词形转换
  'eng-vocab-core': 'cne_j064',
  // 旧数据的错题是「Could you tell me when ____」宾语从句语序
  'eng-grammar-tense': 'cne_j197',
  // 旧数据的证据是「首字母填空得分率 57%」（完形/语篇填空）
  'eng-read-cloze': 'cne_j240',

  // —— 物理 ——
  // 旧数据的证据是「柱体切割 + 液体底部压力」
  'phys-mech-pressure': 'cnp_037',
  // 旧数据的错题是「串联电路滑动变阻器动态分析」
  'phys-elec-ohm': 'cnp_073',
  // 旧数据的证据是「电学实验最后一问未写全」
  'phys-elec-power': 'cnp_075',

  // —— 化学 ——
  // 旧数据的错题是「二氧化碳通入澄清石灰水的方程式」，缺的是**方程式书写**能力
  'chem-concept-symbols': 'cnk_j018',
  // 旧数据的证据是「溶解度曲线正确，降温析晶计算待验证」
  'chem-solution-calc': 'cnk_j034',
  // 旧数据的证据是「氧气制取装置正确，除杂与干燥顺序易混」
  'chem-exp-gas': 'cnk_j008',

  // —— 语文 ——
  // 旧数据的证据是「课外文言文直译关键词遗漏」
  'chi-classical-read': 'cnc_j024',
  // 旧数据的错题是「散文结尾段作用」（《春》即朱自清散文）
  'chi-modern-read': 'cnc_j001',
  // 旧数据的证据是「作文 49/60，高潮细节展开不足」
  'chi-writing-struct': 'cnc_j021',
};

interface MigrationStats {
  /** 相对路径 → 该文件被改写的次数 */
  files: Map<string, number>;
  /** 旧 id → 改写次数 */
  perId: Map<string, number>;
  /** 旧名称 → 改写次数（计划/错题里烘焙的展示文案） */
  perName: Map<string, number>;
  /** 迁移后仍残留的悬空新 id（理论上应为空） */
  dangling: Set<string>;
  /** 迁移后仍残留的旧 id（应为空；非空说明映射表有漏项） */
  leftovers: Set<string>;
  /** 需要（或已经）重命名的文件：[原相对路径, 新相对路径] */
  renames: Array<[string, string]>;
}

function collectJsonFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonFiles(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * 递归改写一个 JSON 值里的知识点引用。
 *
 * 不改写对象**键**：掌握度记录以 knowledgeId 为键存成
 * `Record<knowledgeId, MasteryRecord>`，键和值都要改。
 * 所以这里对字典的键也做一次映射（仅当键命中旧 id）。
 */
function rewriteValue(
  value: unknown,
  stats: MigrationStats,
  relPath: string,
  namePairs: Array<[string, string]> = []
): unknown {
  if (typeof value === 'string') {
    const mapped = LEGACY_ID_MAP[value];
    if (mapped) {
      stats.perId.set(value, (stats.perId.get(value) ?? 0) + 1);
      stats.files.set(relPath, (stats.files.get(relPath) ?? 0) + 1);
      return mapped;
    }
    /**
     * 旧**名称**也要改写。
     *
     * 计划、错题、变式题里存的是生成时烘焙的展示文案
     * （`knowledgeName`、`title`、`description`）。
     * 只改 id 会留下「化学符号、化合价与方程式配平」配
     * `cnk_j021 二氧化碳的性质` 这种自相矛盾的展示。
     * 按名称做子串替换，能一次修好字段值与内嵌文案。
     */
    let out = value;
    for (const [from, to] of namePairs) {
      if (!out.includes(from)) continue;
      out = out.split(from).join(to);
      stats.perName.set(from, (stats.perName.get(from) ?? 0) + 1);
      stats.files.set(relPath, (stats.files.get(relPath) ?? 0) + 1);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteValue(v, stats, relPath, namePairs));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const mappedKey = LEGACY_ID_MAP[k] ?? k;
      if (mappedKey !== k) {
        stats.perId.set(k, (stats.perId.get(k) ?? 0) + 1);
        stats.files.set(relPath, (stats.files.get(relPath) ?? 0) + 1);
      }
      out[mappedKey] = rewriteValue(v, stats, relPath, namePairs);
    }
    return out;
  }
  return value;
}

/** 递归扫描残留的旧 id / 悬空 id */
function audit(value: unknown, known: Set<string>, stats: MigrationStats): void {
  if (typeof value === 'string') {
    if (LEGACY_ID_MAP[value]) stats.leftovers.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) audit(v, known, stats);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (LEGACY_ID_MAP[k]) stats.leftovers.add(k);
      audit(v, known, stats);
    }
  }
}


/**
 * 从旧资产里读出「旧名称 → 新名称」对照表。
 *
 * @returns 按旧名称长度降序排列 —— 长名优先替换，
 *          避免短名先命中导致长名被切碎（如"分式"与"分式方程"）。
 */
function loadNamePairs(
  argv: string[],
  newNameById: Map<string, string>
): Array<[string, string]> {
  const explicitIdx = argv.indexOf('--legacy-asset');
  let legacyPath: string | null = null;

  if (explicitIdx >= 0 && argv[explicitIdx + 1]) {
    legacyPath = path.resolve(argv[explicitIdx + 1]);
  } else {
    // 自动在 staging/archived/ 里找：命中映射表 id 最多的那个文件
    const archiveDir = path.join(DATA_DIR, 'staging', 'archived');
    if (fs.existsSync(archiveDir)) {
      let best: { file: string; hits: number } | null = null;
      for (const file of fs.readdirSync(archiveDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(archiveDir, file), 'utf8')
          ) as { knowledgePoints?: Array<{ id: string; name: string }> };
          const hits = (parsed.knowledgePoints ?? []).filter(
            (kp) => kp.id in LEGACY_ID_MAP
          ).length;
          if (hits > 0 && (!best || hits > best.hits)) {
            best = { file: path.join(archiveDir, file), hits };
          }
        } catch {
          // 损坏的归档文件跳过
        }
      }
      legacyPath = best?.file ?? null;
    }
  }

  if (!legacyPath || !fs.existsSync(legacyPath)) {
    console.log('  ⚠ 未找到旧资产归档，跳过展示文案改写');
    console.log('     （只改 id 时，计划/错题里的旧知识点名称会与新点不符）');
    return [];
  }

  const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as {
    knowledgePoints?: Array<{ id: string; name: string }>;
  };
  const pairs: Array<[string, string]> = [];
  for (const kp of legacy.knowledgePoints ?? []) {
    const targetId = LEGACY_ID_MAP[kp.id];
    if (!targetId) continue;
    const newName = newNameById.get(targetId);
    if (!newName || newName === kp.name) continue;
    pairs.push([kp.name, newName]);
  }
  console.log(`  旧资产      ${path.relative(DATA_DIR, legacyPath)}`);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

function main(): number {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const includeSeed = argv.includes('--include-seed');

  const curriculum = getCurriculum();
  const known = new Set(curriculum.knowledgePoints.map((kp) => kp.id));
  const newNameById = new Map(
    curriculum.knowledgePoints.map((kp) => [kp.id, kp.name])
  );

  /**
   * 旧名称 → 新名称。
   *
   * 旧名称只能从**归档的旧资产**里读（新资产当然没有旧名字）。
   * `--promote` 会把旧版本移到 `staging/archived/`，包含我们映射表里
   * 那些 id 的那个文件就是它。也可以用 `--legacy-asset <path>` 显式指定。
   */
  const namePairs = loadNamePairs(argv, newNameById);

  // 1. 先校验映射表本身：目标 id 必须都在当前资产里
  const missingTargets = Object.entries(LEGACY_ID_MAP)
    .filter(([, target]) => !known.has(target))
    .map(([from, target]) => `${from} → ${target}`);

  console.log('═'.repeat(60));
  console.log('课程资产迁移');
  console.log('═'.repeat(60));
  console.log(`  数据目录    ${DATA_DIR}`);
  console.log(`  当前资产    ${curriculum.version}（${known.size} 个知识点）`);
  console.log(`  映射条目    ${Object.keys(LEGACY_ID_MAP).length}`);
  console.log(`  模式        ${apply ? '写盘' : '预演（加 --apply 才写盘）'}`);

  if (missingTargets.length > 0) {
    console.error('\n✗ 映射表里有目标 id 不在当前资产中：');
    for (const m of missingTargets) console.error(`    ${m}`);
    console.error('\n请先确认知识资产版本，再修正 LEGACY_ID_MAP。');
    return 1;
  }

  // 2. 收集目标文件
  const targets = collectJsonFiles(path.join(DATA_DIR, 'db'));
  if (includeSeed) {
    const seed = path.join(DATA_DIR, 'seed', 'demo-student.json');
    if (fs.existsSync(seed)) targets.push(seed);
  }

  if (targets.length === 0) {
    console.log('\n没有找到需要迁移的数据文件（db/ 为空？）。');
    return 0;
  }

  // 3. 逐个文件改写
  const stats: MigrationStats = {
    files: new Map(),
    perId: new Map(),
    perName: new Map(),
    dangling: new Set(),
    leftovers: new Set(),
    renames: [],
  };
  const backupDir = path.join(
    DATA_DIR,
    'backup',
    `curriculum-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );

  for (const file0 of targets) {
    let file = file0;
    const rel = path.relative(DATA_DIR, file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    /**
     * 文件名里也可能带知识点 id。
     *
     * 例如辅导历史按 `db/coaching/<studentId>/<knowledgeId>.json` 落盘 ——
     * 只改内容不改文件名，换版后按新 id 去读就**永远读不到历史**，
     * 旧文件还会一直躺在目录里。
     */
    const base = path.basename(file, '.json');
    const mappedBase = LEGACY_ID_MAP[base];
    if (mappedBase) {
      const newFile = path.join(path.dirname(file), `${mappedBase}.json`);
      const newRel = path.relative(DATA_DIR, newFile);
      if (fs.existsSync(newFile)) {
        console.warn(
          `\n  ⚠ 目标文件已存在，保留原文件不覆盖：${rel}（应为 ${newRel}）`
        );
      } else {
        stats.renames.push([rel, newRel]);
        if (apply) {
          const backupPath = path.join(backupDir, rel);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          fs.copyFileSync(file, backupPath);
          fs.renameSync(file, newFile);
          file = newFile;
        }
      }
    }

    const before = stats.files.get(rel) ?? 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const rewritten = rewriteValue(parsed, stats, rel, namePairs);
    const changed = (stats.files.get(rel) ?? 0) !== before;
    if (!changed) continue;

    audit(rewritten, known, stats);

    if (apply) {
      const backupPath = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(file, backupPath);
      fs.writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
    }
  }

  // 4. 报告
  console.log(
    `\n  待改写文件  ${stats.files.size} 个 / 共扫描 ${targets.length} 个`
  );
  if (stats.files.size > 0) {
    console.log('\n  改写明细：');
    for (const [file, count] of [...stats.files].sort()) {
      console.log(`    ${count.toString().padStart(5)}  ${file}`);
    }
    if (stats.perName.size > 0) {
      console.log('\n  展示文案改写（旧名称 → 新名称）：');
      for (const [name, count] of [...stats.perName].sort()) {
        console.log(`    ${count.toString().padStart(5)}  ${name}`);
      }
    }
    console.log('\n  按旧 id 统计：');
    for (const [id, count] of [...stats.perId].sort()) {
      console.log(
        `    ${count.toString().padStart(5)}  ${id.padEnd(22)} → ${LEGACY_ID_MAP[id]}`
      );
    }
  }

  if (stats.renames.length > 0) {
    console.log('\n  文件重命名（文件名里带旧知识点 id）：');
    for (const [from, to] of stats.renames) {
      console.log(`    ${from}\n      → ${to}`);
    }
  }

  // 5. 一致性校验
  let failed = false;
  if (stats.leftovers.size > 0) {
    console.error('\n✗ 仍残留旧 id（映射表有漏项）：');
    for (const id of stats.leftovers) console.error(`    ${id}`);
    failed = true;
  }
  if (stats.dangling.size > 0) {
    console.error('\n✗ 迁移后出现悬空 id（目标资产里没有）：');
    for (const id of stats.dangling) console.error(`    ${id}`);
    failed = true;
  }
  if (failed) return 1;

  if (!apply && stats.files.size > 0) {
    console.log('\n  以上为预演结果，未写入任何文件。');
    console.log('  确认无误后执行：npx tsx scripts/migrate-curriculum.ts --apply');
  } else if (apply && stats.files.size > 0) {
    console.log(`\n  ✓ 已改写，原文件备份在 ${path.relative(process.cwd(), backupDir)}/`);
  }
  console.log('═'.repeat(60));
  return 0;
}

/**
 * 只在**直接执行**时跑 main()。
 *
 * 本文件同时被 `tests/curriculum-migration.test.ts` 导入
 * （要用其中的 LEGACY_ID_MAP 校验映射表）。
 * 若无条件 `process.exit(main())`，一旦被 import 就会真的去迁移数据、
 * 然后退出进程 —— 测试连断言都跑不到。
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
