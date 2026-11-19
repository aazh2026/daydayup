/**
 * 外部 id 别名表导入脚本。
 *
 * 运行：
 *   npm run import:aliases --workspace=@daydayup/server
 *   npm run import:aliases --workspace=@daydayup/server -- --promote
 *   npm run import:aliases --workspace=@daydayup/server -- --dry-run
 *
 * ── 作用 ──────────────────────────────────────────────────────────────
 *
 * 把外部命名空间的 id 映射到**项目原生 id**：
 *
 *   cnm_ext_002 → [cnm_p165, cnm_p173, cnm_p178, cnm_p183]
 *
 * 源数据来自 cn-math-taxonomy 的 `data/id-aliases.json`
 * （18 个已从 topics.json 删除的历史外节点）。
 *
 * ── 安全设计 ──────────────────────────────────────────────────────────
 *
 * 1. **默认 DRAFT**：别名映射一旦生效，旧链接会跳到具体知识点，
 *    跳错比不跳更误导，因此默认不生效，需显式 `--promote`。
 * 2. **外键校验**：映射目标必须存在于当前生效的知识资产里，
 *    指向不存在知识点的别名直接丢弃并报告。
 * 3. **只写原生 id**：目标 id 不符合原生命名空间形态 → 拒绝。
 * 4. **不覆盖现行 ACTIVE**：需要 `--force`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IdAliasSet } from '../src/infrastructure/knowledge/id-aliases.ts';
import { isNativeKnowledgeId } from '../src/infrastructure/knowledge/id-namespace.ts';
import { getKnowledgeMap } from '../src/infrastructure/knowledge/curriculum.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

const SOURCE_REPO = 'cn-math-taxonomy';
const SOURCE_REL = 'resources/cn-math-taxonomy/data/id-aliases.json';
const OUT_FILE = path.join(DATA_DIR, 'ids', 'id-aliases.json');

interface CliArgs {
  promote: boolean;
  force: boolean;
  dryRun: boolean;
  publishedAt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    promote: false,
    force: false,
    dryRun: false,
    publishedAt: new Date().toISOString(),
  };
  for (const raw of argv) {
    if (raw === '--promote') args.promote = true;
    else if (raw === '--force') args.force = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--published-at=')) args.publishedAt = raw.split('=')[1];
    else throw new Error(`未知参数：${raw}`);
  }
  return args;
}

interface RawAliasFile {
  description?: string;
  aliases: Record<string, { name?: string; targets: string[] }>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const srcPath = path.join(REPO_ROOT, SOURCE_REL);
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ 找不到源文件：${srcPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8')) as RawAliasFile;
  const knowledgeMap = getKnowledgeMap();

  const aliases: IdAliasSet['aliases'] = {};
  const rejected: Array<{ id: string; reason: string; targets: string[] }> = [];

  for (const [externalId, entry] of Object.entries(raw.aliases ?? {})) {
    const targets = entry.targets ?? [];
    const nativeTargets = targets.filter((t) => isNativeKnowledgeId(t));
    const missing = nativeTargets.filter((t) => !knowledgeMap[t]);
    const kept = nativeTargets.filter((t) => knowledgeMap[t]);

    if (nativeTargets.length !== targets.length) {
      rejected.push({
        id: externalId,
        reason: '目标不是项目原生 id',
        targets: targets.filter((t) => !isNativeKnowledgeId(t)),
      });
    }
    if (missing.length > 0) {
      rejected.push({ id: externalId, reason: '目标知识点不存在', targets: missing });
    }
    if (kept.length === 0) continue;

    aliases[externalId] = {
      ...(entry.name ? { name: entry.name } : {}),
      targets: kept,
    };
  }

  const set: IdAliasSet = {
    version: 'shanghai-junior-aliases-2026.11',
    publishedAt: args.publishedAt,
    status: args.promote ? 'ACTIVE' : 'DRAFT',
    source: {
      repo: SOURCE_REPO,
      path: SOURCE_REL,
      license: 'CC BY-NC 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      note: '别名仅作 id 映射；商用前须取得作者商业授权',
    },
    aliases,
  };

  console.log('│  外部 id 别名表');
  console.log(`│    源文件  ${SOURCE_REL}`);
  console.log(`│    条目    ${Object.keys(aliases).length} 条 → 映射 ${Object.values(aliases).reduce((n, a) => n + a.targets.length, 0)} 个原生 id`);
  console.log(`│    丢弃    ${rejected.length} 条`);
  for (const r of rejected.slice(0, 10)) {
    console.log(`│      ✗ ${r.id}：${r.reason}（${r.targets.join(', ')}）`);
  }

  if (args.dryRun) {
    console.log('\n└─ dry-run，未写盘');
    return;
  }

  if (
    fs.existsSync(OUT_FILE) &&
    !args.force &&
    JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).status === 'ACTIVE'
  ) {
    console.error(`\n✗ 已存在生效中的别名表：${OUT_FILE}（需 --force 覆盖）`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(set, null, 2), 'utf8');
  console.log(`\n✓ 已写入：${OUT_FILE}（${Object.keys(aliases).length} 条，${set.status}）`);
}

main();
