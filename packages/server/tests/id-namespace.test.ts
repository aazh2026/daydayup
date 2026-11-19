/**
 * id 命名空间与别名解析测试。
 *
 * 守护的是一条**红线**：外部 id 绝不能成为主键。
 * 一旦外部 id 写进学生掌握度/错因/题目外键，排课会静默查不到知识点 ——
 * 没有报错，只是「这个孩子怎么什么都学不出来」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NAMESPACE_SUBJECT,
  classifyExternalId,
  isExternalId,
  isNativeKnowledgeId,
  subjectOfNativeId,
} from '../src/infrastructure/knowledge/id-namespace.ts';
import {
  getAliasMap,
  resetAliasCache,
  resolveKnowledgeId,
  resolveKnowledgeIds,
} from '../src/infrastructure/knowledge/id-aliases.ts';

test('命名空间：项目原生 id 形态识别', () => {
  assert.ok(isNativeKnowledgeId('cnm_p001'));
  assert.ok(isNativeKnowledgeId('cne_001'));
  assert.ok(isNativeKnowledgeId('cne_wb_0102030101'));
  assert.ok(!isNativeKnowledgeId('mt_num-10-recognition'));
  assert.ok(!isNativeKnowledgeId('m1-00-03-number-line-opposite-absolute'));
  assert.ok(!isNativeKnowledgeId('01.01.01.01'));
  assert.ok(!isNativeKnowledgeId(''));
});

test('命名空间：cnm_ext_* 不算原生 id', () => {
  // 关键回归：cnm_ext_002 形状上能通过原生正则，
  // 若不单独排除，历史外节点会被当成正式知识点。
  assert.ok(!isNativeKnowledgeId('cnm_ext_002'));
  assert.equal(classifyExternalId('cnm_ext_002'), 'cnm-ext');
  assert.ok(isExternalId('cnm_ext_002'));
});

test('命名空间：外部 id 分类', () => {
  assert.equal(classifyExternalId('mt_num-10-recognition'), 'mt');
  assert.equal(classifyExternalId('m1-00-03-number-line-opposite-absolute'), 'atlas');
  assert.equal(classifyExternalId('01.01.01.01'), 'workbuddy');
  assert.equal(classifyExternalId('cnm_p001'), 'unknown');
  assert.ok(!isExternalId('cnm_p001'));
});

test('命名空间：原生 id 可反推学科', () => {
  assert.equal(subjectOfNativeId('cnm_p001'), '数学');
  assert.equal(subjectOfNativeId('cne_p001'), '英语');
  assert.equal(subjectOfNativeId('cnc_p001'), '语文');
  assert.equal(subjectOfNativeId('cnp_p001'), '物理');
  assert.equal(subjectOfNativeId('cnk_p001'), '化学');
  assert.equal(subjectOfNativeId('xxx_p001'), null);
  assert.deepEqual(
    Object.values(NAMESPACE_SUBJECT).sort(),
    ['化学', '数学', '物理', '英语', '语文'].sort()
  );
});

test('别名：仓库内 ACTIVE 别名表可加载且目标全部是原生 id', () => {
  const map = getAliasMap();
  assert.ok(map.size >= 18, `应至少 18 条外部 id 别名，实际 ${map.size}`);
  for (const [externalId, targets] of map) {
    assert.ok(isExternalId(externalId), `别名键应是外部 id：${externalId}`);
    assert.ok(targets.length > 0, `别名目标不应为空：${externalId}`);
    for (const t of targets) {
      assert.ok(isNativeKnowledgeId(t), `别名目标必须是原生 id：${externalId} → ${t}`);
    }
  }
});

test('别名：解析外部 id 命中多个原生知识点', () => {
  const targets = resolveKnowledgeId('cnm_ext_002');
  assert.ok(targets.length >= 3, `cnm_ext_002 应映射到多个知识点，实际 ${targets.length}`);
  assert.ok(targets.every(isNativeKnowledgeId));
  assert.ok(targets.includes('cnm_p165'));
});

test('别名：原生 id 原样返回，未知外部 id 返回空（不猜）', () => {
  assert.deepEqual(resolveKnowledgeId('cnm_p001'), ['cnm_p001']);
  assert.deepEqual(resolveKnowledgeId('mt_not-a-real-topic'), []);
  assert.deepEqual(resolveKnowledgeId(''), []);
});

test('别名：批量解析去重并保留未解项', () => {
  const { resolved, unresolved } = resolveKnowledgeIds([
    'cnm_p001',
    'cnm_ext_002',
    'mt_not-a-real-topic',
    'cnm_p001',
  ]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0], 'mt_not-a-real-topic');
  assert.equal(new Set(resolved).size, resolved.length, '解析结果不应重复');
  assert.ok(resolved.includes('cnm_p001'));
});

test('别名：只加载 ACTIVE，DRAFT 不生效', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-alias-'));
  const dir = path.join(tmp, 'ids');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(dir, 'id-aliases.json'),
      JSON.stringify({
        version: 'test-draft',
        publishedAt: '2026-11-19T00:00:00.000Z',
        status: 'DRAFT',
        source: { repo: 'test', path: 'x', license: 'CC0' },
        aliases: { cnm_ext_999: { targets: ['cnm_p001'] } },
      }),
      'utf8'
    );
    process.env.DATA_DIR = tmp;
    resetAliasCache();
    const mod = await import(
      `../src/infrastructure/knowledge/id-aliases.ts?fresh=${Date.now()}`
    );
    assert.equal(mod.getAliasMap().size, 0, 'DRAFT 别名不应生效');
    assert.deepEqual(mod.resolveKnowledgeId('cnm_ext_999'), []);
  } finally {
    delete process.env.DATA_DIR;
    resetAliasCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('资产：打包数据里的所有 knowledgeId 都是项目原生 id', () => {
  const dataDir = path.resolve(process.cwd(), 'data');
  const offenders: string[] = [];

  const scan = (dir: string, pick: (json: any) => string[]) => {
    const full = path.join(dataDir, dir);
    if (!fs.existsSync(full)) return;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.json')) continue;
      const json = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
      for (const id of pick(json)) {
        if (!id) continue;
        if (!isNativeKnowledgeId(id)) {
          offenders.push(`${dir}/${file}: ${id}`);
        }
      }
    }
  };

  scan('knowledge', (j) =>
    (j.knowledgePoints ?? []).flatMap((kp: any) => [kp.id, ...(kp.prerequisites ?? [])])
  );
  scan('questions', (j) =>
    (j.questions ?? []).flatMap((q: any) => q.knowledgeIds ?? [])
  );
  scan('traps', (j) => (j.entries ?? []).map((e: any) => e.knowledgeId));
  scan('overlays', (j) =>
    (j.entries ?? []).flatMap((e: any) => [
      e.id,
      ...(e.prerequisites ?? []),
      ...(e.relatedKnowledgeIds ?? []),
    ])
  );

  assert.deepEqual(
    offenders,
    [],
    `以下 knowledgeId 不是项目原生 id：\n${offenders.slice(0, 20).join('\n')}`
  );
});
