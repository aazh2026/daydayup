/**
 * 英语错因资产（en-map 来源）单元测试。
 *
 * 覆盖重点：
 *  - 转换器：地图 code → 叠加层 id、详解表同名回退、抢分动作进待审池
 *  - 名称匹配：泛成分名必须排除、infix 不匹配
 *  - 匹配器：`matchConfidenceHint` 只在真的匹配到知识点时生效
 *  - 覆盖层：叠加层知识点（`cne_wb_*`）的错因能挂上
 *  - 兜底：服务端 mergeTraps 能补出知识点/题目级错因
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  convertEnActionEntries,
  convertEnDetailEntries,
  convertEnMapEntries,
  enDetailNoToId,
  enMapCodeToId,
  EN_GENERIC_COMPONENTS,
  matchEnName,
  normalizeEnName,
  type EnActionEntry,
  type EnDetailEntry,
  type EnMapEntry,
} from '../src/infrastructure/knowledge/converters/traps-en-map.ts';
import {
  buildKnowledgeIndex,
  matchTrapCandidates,
} from '../src/infrastructure/knowledge/trap-matcher.ts';
import {
  applyTrapSets,
  formatTrapText,
} from '../src/infrastructure/knowledge/converters/trap-overlay.ts';
import type { TrapSet } from '@daydayup/contracts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const MAP_ENTRY: EnMapEntry = {
  code: '03.01.01.02',
  name: '谓语',
  explain: '句子成分说明',
  example: '【填空】He ____ (finish) it.',
  answer: 'has finished。',
  mistake: '把 finished 单独当谓语。',
  related: '03.02 现在完成时',
};

const DETAIL_ENTRY: EnDetailEntry = {
  no: 3,
  module: '词汇',
  topic: '词形变化',
  name: '名词所有格',
  explain: '有生命用 ’s。',
  example: '【填空】This is ____ (Tom 和 Jack) room.',
  answer: "Tom and Jack's room。",
  mistake: '分别拥有与共同拥有混用。',
};

const ACTION_ENTRY: EnActionEntry = {
  priority: 'P0',
  area: '语法词汇 · 词形转换（8分）',
  loss: '看到括号词就凭语感直接变形，忽略空格位置',
  score: '8',
  action: '先标词性再填词',
  acceptance: '连续 3 套 8 题错 ≤1',
  failure: '填对词义但词性错',
};

// ---------------------------------------------------------------------------
// 转换器
// ---------------------------------------------------------------------------

test('en-map：地图 code → 叠加层知识点 id', () => {
  assert.equal(enMapCodeToId('03.01.01.02'), 'cne_wb_03_01_01_02');
  assert.equal(enMapCodeToId('01.01.01.01'), 'cne_wb_01_01_01_01');
});

test('en-map：详解表序号 → 叠加层知识点 id（三位补零）', () => {
  assert.equal(enDetailNoToId(3), 'cne_wb_d003');
  assert.equal(enDetailNoToId('169'), 'cne_wb_d169');
});

test('en-map：地图条目转候选，错因文本逐字取自源句', () => {
  const [c] = convertEnMapEntries([MAP_ENTRY]);
  assert.ok(c);
  assert.equal(c.id, 'en-map:03.01.01.02#e1');
  assert.equal(c.sourceRepo, 'workbuddy-english-map');
  assert.equal(c.sourceTopicId, 'cne_wb_03_01_01_02');
  assert.equal(c.subject, '英语');
  assert.equal(c.stage, '初中');
  // 红线：错因文本必须逐字取自源项目，不能改写
  assert.equal(c.wrong, '把 finished 单独当谓语。');
  // 源数据没写「为什么错 / 怎么改」→ 不补
  assert.equal(c.why, '');
  assert.equal(c.right, '');
});

test('en-map：地图条目缺 mistake 时不产出候选', () => {
  const out = convertEnMapEntries([{ ...MAP_ENTRY, mistake: '' }]);
  assert.equal(out.length, 0);
});

test('en-map：详解表同名条目落到指定 id（地图优先回退）', () => {
  const out = convertEnDetailEntries([DETAIL_ENTRY], () => 'cne_wb_02_02_02_05');
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceTopicId, 'cne_wb_02_02_02_05');
  assert.equal(out[0].wrong, '分别拥有与共同拥有混用。');
});

test('en-map：详解表落点解析器返回空串时丢弃该条', () => {
  const out = convertEnDetailEntries([DETAIL_ENTRY], () => '');
  assert.equal(out.length, 0);
});

test('en-map：抢分动作条目无知识点 id（进待审池）', () => {
  const out = convertEnActionEntries([ACTION_ENTRY]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'en-action:1#e1');
  assert.equal(out[0].sourceId, 'action-1');
  assert.equal(out[0].sourceTopicId, undefined);
  assert.equal(out[0].wrong, '看到括号词就凭语感直接变形，忽略空格位置');
});

// ---------------------------------------------------------------------------
// 名称匹配
// ---------------------------------------------------------------------------

test('en-map：泛成分名一律排除', () => {
  for (const generic of EN_GENERIC_COMPONENTS) {
    assert.equal(
      matchEnName(generic, ['宾语从句']),
      null,
      `泛成分名「${generic}」不应命中`
    );
  }
});

test('en-map：名称匹配只认 exact / prefix / suffix', () => {
  assert.equal(matchEnName('现在完成时', ['现在完成时'])?.kind, 'exact');
  assert.equal(matchEnName('现在完成时的构成', ['现在完成时'])?.kind, 'prefix');
  assert.equal(matchEnName('名词性物主代词', ['物主代词'])?.kind, 'suffix');
  // infix 不匹配（泛成分名夹在中间）
  assert.equal(matchEnName('that 引导宾语从句', ['宾语']), null);
});

test('en-map：过短的地图名不参与匹配', () => {
  assert.equal(matchEnName('名词复数规则', ['复数']), null);
});

test('en-map：名称规范化去标点与空白', () => {
  assert.equal(normalizeEnName('Do you like 一般疑问句？'), 'doyoulike一般疑问句');
});

// ---------------------------------------------------------------------------
// 匹配器
// ---------------------------------------------------------------------------

test('en-map：matchConfidenceHint 只在真的匹配到知识点时生效', () => {
  const index = buildKnowledgeIndex([
    { id: 'cne_j001', name: '现在完成时', subject: '英语', chapter: '八年级上册' },
  ]);

  // 命中 + 提示 → high
  const hit = matchTrapCandidates(
    [
      {
        id: 'en-map:x#e1',
        sourceRepo: 'workbuddy-english-map',
        sourceId: 'x',
        sourceTopicId: 'cne_j001',
        topicName: '现在完成时',
        subject: '英语',
        stage: '初中',
        wrong: '错法',
        why: '',
        right: '',
        matchConfidenceHint: 'exact',
      },
    ],
    index
  );
  assert.equal(hit.entries[0].matchConfidence, 'high');
  assert.equal(hit.entries[0].knowledgeId, 'cne_j001');

  // 未命中 + 提示 → 不能变 high（否则「提示 + 未匹配」自相矛盾）
  const miss = matchTrapCandidates(
    [
      {
        id: 'en-map:y#e1',
        sourceRepo: 'workbuddy-english-map',
        sourceId: 'y',
        topicName: '完全不相关的知识点名',
        subject: '英语',
        stage: '初中',
        wrong: '错法',
        why: '',
        right: '',
        matchConfidenceHint: 'exact',
      },
    ],
    index
  );
  assert.equal(miss.entries[0].matchConfidence, 'unmatched');
  assert.equal(miss.entries[0].knowledgeId, null);
});

// ---------------------------------------------------------------------------
// 覆盖层
// ---------------------------------------------------------------------------

test('en-map：叠加层知识点（cne_wb_*）的错因能挂上', () => {
  const kp = { id: 'cne_wb_03_01_01_02', commonTraps: [] as string[] };
  const set: TrapSet = {
    version: 'traps-test',
    publishedAt: '2026-11-19T00:00:00.000Z',
    status: 'ACTIVE',
    subject: '英语',
    source: { repo: 'workbuddy-english-map', path: 'resources/workbuddy-research', license: 'test' },
    entries: [
      {
        id: 'en-map:03.01.01.02#e1',
        knowledgeId: 'cne_wb_03_01_01_02',
        questionIds: [],
        subject: '英语',
        stage: '初中',
        matchConfidence: 'high',
        matchMethod: 'source-topic',
        wrong: '把 finished 单独当谓语。',
        why: '',
        right: '',
        sourceId: '03.01.01.02',
      },
    ],
  };

  const result = applyTrapSets([kp], [], [set]);
  assert.equal(result.knowledgeTraps, 1);
  assert.deepEqual(kp.commonTraps, ['把 finished 单独当谓语。']);
  // 单句错因 → 原样输出，不加任何前后缀
  assert.equal(formatTrapText({ wrong: '把 finished 单独当谓语。', why: '', right: '' }), '把 finished 单独当谓语。');
});

test('en-map：DRAFT 错因资产不生效', () => {
  const kp = { id: 'cne_wb_03_01_01_02', commonTraps: [] as string[] };
  const set: TrapSet = {
    version: 'traps-test',
    publishedAt: '2026-11-19T00:00:00.000Z',
    status: 'DRAFT',
    subject: '英语',
    source: { repo: 'workbuddy-english-map', path: 'resources/workbuddy-research', license: 'test' },
    entries: [
      {
        id: 'en-map:03.01.01.02#e1',
        knowledgeId: 'cne_wb_03_01_01_02',
        questionIds: [],
        subject: '英语',
        stage: '初中',
        matchConfidence: 'high',
        matchMethod: 'source-topic',
        wrong: '把 finished 单独当谓语。',
        why: '',
        right: '',
        sourceId: '03.01.01.02',
      },
    ],
  };
  const result = applyTrapSets([kp], [], [set]);
  assert.equal(result.knowledgeTraps, 0);
  assert.deepEqual(kp.commonTraps, []);
});

// ---------------------------------------------------------------------------
// 已发布资产（端到端）
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve('data');

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

test('en-map：已发布 ACTIVE 资产存在且挂的是叠加层/主资产真实知识点', () => {
  const set = readJson<TrapSet>(
    path.join(DATA_DIR, 'traps', 'traps-workbuddy-english-map-2026.12.json')
  );
  if (!set) return; // 未导入时跳过（CI 不带数据资产）

  assert.equal(set.status, 'ACTIVE');
  assert.equal(set.subject, '英语');
  assert.ok(set.entries.length >= 500, `条目数偏少：${set.entries.length}`);

  // 外键：落点必须是真实知识点 id
  const overlay = readJson<{ entries: Array<{ id: string }> }>(
    path.join(DATA_DIR, 'overlays', 'workbuddy-english-2026.11.json')
  );
  const overlayIds = new Set((overlay?.entries ?? []).map((e) => e.id));

  const curriculum = readJson<{
    knowledgePoints: Array<{ id: string }>;
  }>(path.join(DATA_DIR, 'knowledge', 'shanghai-junior-taxonomy-2026.02.json'));
  const mainIds = new Set((curriculum?.knowledgePoints ?? []).map((k) => k.id));

  for (const e of set.entries) {
    if (!e.knowledgeId) continue;
    assert.ok(
      overlayIds.has(e.knowledgeId) || mainIds.has(e.knowledgeId),
      `落点不存在：${e.knowledgeId}`
    );
  }

  // 所有条目都是 high 置信度（medium 不进 ACTIVE）
  for (const e of set.entries) {
    assert.notEqual(e.matchConfidence, 'medium');
    assert.notEqual(e.matchConfidence, 'unmatched');
  }
});
