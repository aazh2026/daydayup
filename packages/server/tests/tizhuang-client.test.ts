/**
 * 题庄（tizhuang）接入测试。
 *
 * 全程**不联网**：所有 HTTP 交互都通过 `opts.fetchImpl` 注入的假 fetch 完成。
 * 覆盖：
 * - 试用令牌流程（申请 → 复用 → 过期重取）与 license 优先级
 * - HTML 实体解码、options 顺序与标签
 * - 错误码映射（鉴权 / 配额 / 网络）
 * - 知识点名 → 项目原生 id 的三级命中
 * - 缓存去重与「缓存优先不联网」
 * - 路由在无映射 / 网络失败时的可降级响应
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe, before, after } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  decodeHtmlEntities,
  fetchTizhuangQuestions,
  htmlToText,
  normalizeOptions,
  TizhuangError,
  type FetchLike,
  type TizhuangResponseLike,
} from '../src/infrastructure/question-bank/tizhuang.ts';
import {
  mapTizhuangKnowledgeName,
  mapTizhuangKnowledgeNames,
  TIZHUANG_ALIAS_FALLBACK,
  TIZHUANG_KNOWLEDGE_ALIASES,
} from '../src/infrastructure/question-bank/knowledge-mapping.ts';
import {
  readCachedQuestions,
  selectCachedByKnowledge,
  upsertQuestions,
} from '../src/infrastructure/question-bank/tizhuang-cache.ts';
import { createTizhuangRoutes } from '../src/api/routes/tizhuang.routes.ts';
import { getCurriculum } from '../src/infrastructure/knowledge/curriculum.ts';
import type { Container } from '../src/bootstrap/container.ts';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface FakeResponse {
  status?: number;
  body?: unknown;
  /** 原始文本（用于测试非法 JSON） */
  text?: string;
}

function jsonResponse(body: unknown, status = 200): TizhuangResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function textResponse(text: string, status = 200): TizhuangResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

/** 记录调用并按路由规则回放的假 fetch */
function createFakeFetch(
  handler: (call: FakeCall) => FakeResponse | Promise<FakeResponse> | never
): { fetchImpl: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: FakeCall = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
    };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Error) throw result;
    if (typeof result.text === 'string') {
      return textResponse(result.text, result.status ?? 200);
    }
    return jsonResponse(result.body, result.status ?? 200);
  };
  return { fetchImpl, calls };
}

/** 一道题庄题目的原始 payload */
function rawTizhuangItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 2826735,
    title: '—Which&nbsp;is&nbsp;your&nbsp;favourite&nbsp;food?<br />—Noodles.',
    title_html: '<p>—Which&nbsp;is&nbsp;your&nbsp;favourite&nbsp;food?</p>',
    options: {
      A: 'Noodles&nbsp;is&nbsp;my&nbsp;favourite.',
      B: 'Potato',
      C: 'Sandwich',
      D: 'Rice',
    },
    options_html: '<ul><li>A</li></ul>',
    answer: 'A',
    answer_html: '<p>【解答】答案：A</p>',
    analysis: 'Because&nbsp;it&nbsp;is&nbsp;delicious.<br />解析完毕',
    analysis_html: '<p>Because&nbsp;it&nbsp;is&nbsp;delicious.</p>',
    question_type: '选择题',
    difficulty: 3.0,
    subject_id: 3,
    grade_id: 400,
    knowledges: '并列连词',
    area: '',
    year: 2014,
    paper_type: '32',
    source: '2014•仁寿县校级模拟',
    is_auto_gradable: true,
    content_hash: 'abc123',
    has_images: false,
    image_urls: [],
    subquestions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 试用令牌流程
// ---------------------------------------------------------------------------

describe('题庄客户端：鉴权', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tz-auth-'));
    delete process.env.QUESTION_SERVICE_LICENSE;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('无 license：先申请试用令牌，再带 X-Trial-Token 取题', async () => {
    const { fetchImpl, calls } = createFakeFetch((call) => {
      if (call.url.includes('/v1/trials')) {
        return {
          body: {
            trial_token: 'trial-abc',
            question_limit: 50,
            expires_at: '2099-01-01T00:00:00Z',
            register_url: 'https://example.invalid/register',
            registered_daily_limit: 150,
          },
        };
      }
      return {
        body: {
          items: [rawTizhuangItem()],
          count: 1,
          quota_used_today: 1,
          quota_remaining_today: 49,
        },
      };
    });

    const result = await fetchTizhuangQuestions(
      { subjectId: 3, limit: 5 },
      { fetchImpl, trialTokenFile: path.join(tmpDir, 'trial.json') }
    );

    assert.equal(result.mode, 'trial');
    assert.equal(result.quotaRemaining, 49);
    assert.equal(result.items.length, 1);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.includes('/v1/trials'));
    assert.ok(calls[0].headers['X-Anonymous-Client-ID']);
    assert.equal(calls[1].headers['X-Trial-Token'], 'trial-abc');
    assert.ok(calls[1].url.includes('/v1/trial/questions'));
    assert.ok(calls[1].url.includes('subject_id=3'));
  });

  test('试用令牌本地缓存：第二次调用不再申请', async () => {
    const { fetchImpl, calls } = createFakeFetch((call) => {
      if (call.url.includes('/v1/trials')) {
        return {
          body: {
            trial_token: 'trial-xyz',
            expires_at: '2099-01-01T00:00:00Z',
            question_limit: 50,
          },
        };
      }
      return {
        body: { items: [], count: 0, quota_remaining_today: 40 },
      };
    });

    const file = path.join(tmpDir, 'trial-reuse.json');
    const opts = { fetchImpl, trialTokenFile: file };

    await fetchTizhuangQuestions({ subjectId: 3 }, opts);
    await fetchTizhuangQuestions({ subjectId: 3 }, opts);

    const trialCalls = calls.filter((c) => c.url.includes('/v1/trials'));
    assert.equal(trialCalls.length, 1, '第二次调用应复用缓存里的令牌');

    // 缓存文件确实落盘，且带 expires_at
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cached.trial_token, 'trial-xyz');
    assert.ok(cached.expires_at);
  });

  test('试用令牌过期后重新申请', async () => {
    const file = path.join(tmpDir, 'trial-expire.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        base_url: 'https://tizhuang.qcscience.cc/api',
        trial_token: 'old-token',
        expires_at: '2020-01-01T00:00:00Z',
        anonymous_client_id: 'client-old',
      }),
      'utf8'
    );

    const { fetchImpl, calls } = createFakeFetch((call) => {
      if (call.url.includes('/v1/trials')) {
        return {
          body: {
            trial_token: 'new-token',
            expires_at: '2099-01-01T00:00:00Z',
            question_limit: 50,
          },
        };
      }
      return { body: { items: [], count: 0, quota_remaining_today: 10 } };
    });

    await fetchTizhuangQuestions(
      { subjectId: 3 },
      { fetchImpl, trialTokenFile: file }
    );

    const trialCall = calls.find((c) => c.url.includes('/v1/trials'));
    assert.ok(trialCall, '过期后应重新申请试用');
    assert.equal(trialCall.headers['X-Anonymous-Client-ID'], 'client-old');
    const questionCall = calls.find((c) => c.url.includes('/trial/questions'));
    assert.equal(questionCall?.headers['X-Trial-Token'], 'new-token');
  });

  test('有 license：只带 X-API-Key，不申请试用', async () => {
    const { fetchImpl, calls } = createFakeFetch(() => ({
      body: { items: [rawTizhuangItem()], count: 1, quota_remaining_today: 140 },
    }));

    const result = await fetchTizhuangQuestions(
      { subjectId: 3 },
      { fetchImpl, license: 'LIC-123' }
    );

    assert.equal(result.mode, 'license');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['X-API-Key'], 'LIC-123');
    assert.equal(calls[0].headers['X-Trial-Token'], undefined);
    assert.ok(calls[0].url.includes('/v1/questions'));
    assert.ok(!calls[0].url.includes('/v1/trial/questions'));
  });
});

// ---------------------------------------------------------------------------
// 2. HTML 处理与 options
// ---------------------------------------------------------------------------

describe('题庄客户端：HTML 与选项', () => {
  test('实体解码：命名实体 + 数字实体', () => {
    assert.equal(decodeHtmlEntities('a&nbsp;b'), 'a b');
    assert.equal(decodeHtmlEntities('a&amp;b'), 'a&b');
    assert.equal(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
    assert.equal(decodeHtmlEntities('it&#39;s'), "it's");
    assert.equal(decodeHtmlEntities('&#x4E2D;&#x6587;'), '中文');
    assert.equal(decodeHtmlEntities('&unknown;'), '&unknown;');
  });

  test('htmlToText：去标签 + 解实体 + 保留换行', () => {
    const text = htmlToText(
      '<p>Which&nbsp;is&nbsp;it?</p><p>Second&nbsp;line</p>'
    );
    assert.ok(!text.includes('&nbsp;'));
    assert.ok(!text.includes('<'));
    assert.ok(text.includes('Which is it?'));
  });

  test('options：按 A/B/C 排序并保留标签', () => {
    const options = normalizeOptions({
      C: 'Third',
      A: 'First&nbsp;one',
      D: 'Fourth',
      B: 'Second',
    });
    assert.deepEqual(options, [
      'A. First one',
      'B. Second',
      'C. Third',
      'D. Fourth',
    ]);
    assert.equal(normalizeOptions(undefined), undefined);
    assert.equal(normalizeOptions({}), undefined);
  });

  test('题目规整：题干/选项/知识点名都被清理', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: {
        items: [rawTizhuangItem()],
        count: 1,
        quota_remaining_today: 48,
      },
    }));
    const result = await fetchTizhuangQuestions(
      { subjectId: 3 },
      { fetchImpl, license: 'LIC' }
    );
    const item = result.items[0];
    assert.equal(item.externalId, 2826735);
    assert.ok(!item.stem.includes('&nbsp;'));
    assert.ok(item.stem.includes('Which is your favourite food?'));
    assert.deepEqual(item.options?.[0], 'A. Noodles is my favourite.');
    assert.deepEqual(item.knowledgeNames, ['并列连词']);
    assert.equal(item.questionType, '选择题');
    assert.equal(item.year, 2014);
    assert.equal(item.source, '2014•仁寿县校级模拟');
  });
});

// ---------------------------------------------------------------------------
// 3. 错误映射
// ---------------------------------------------------------------------------

describe('题庄客户端：错误码', () => {
  async function expectCode(
    handler: (call: FakeCall) => FakeResponse | Promise<FakeResponse> | never,
    expected: string
  ): Promise<TizhuangError> {
    const { fetchImpl } = createFakeFetch(handler);
    try {
      await fetchTizhuangQuestions(
        { subjectId: 3 },
        { fetchImpl, license: 'LIC' }
      );
    } catch (err) {
      assert.ok(err instanceof TizhuangError, '应抛 TizhuangError');
      assert.equal(err.code, expected);
      return err;
    }
    throw new Error(`期望抛错 ${expected}，但没有抛`);
  }

  test('401 → TIZHUANG_AUTH_FAILED', async () => {
    await expectCode(() => ({ status: 401, body: { detail: '未授权' } }), 'TIZHUANG_AUTH_FAILED');
  });

  test('403 → TIZHUANG_AUTH_FAILED', async () => {
    await expectCode(
      () => ({ status: 403, body: { detail: '令牌无效' } }),
      'TIZHUANG_AUTH_FAILED'
    );
  });

  test('detail 含「超出配额」→ TIZHUANG_QUOTA_EXCEEDED', async () => {
    await expectCode(
      () => ({ status: 400, body: { detail: '超出配额' } }),
      'TIZHUANG_QUOTA_EXCEEDED'
    );
  });

  test('quota_remaining_today <= 0 且无题 → TIZHUANG_QUOTA_EXCEEDED', async () => {
    await expectCode(
      () => ({
        body: { items: [], count: 0, quota_remaining_today: 0 },
      }),
      'TIZHUANG_QUOTA_EXCEEDED'
    );
  });

  test('网络异常 → TIZHUANG_UNAVAILABLE', async () => {
    await expectCode(() => new Error('socket hang up'), 'TIZHUANG_UNAVAILABLE');
  });

  test('500 → TIZHUANG_UNAVAILABLE；非法 JSON → TIZHUANG_BAD_RESPONSE', async () => {
    await expectCode(() => ({ status: 500, body: { detail: 'boom' } }), 'TIZHUANG_UNAVAILABLE');
    await expectCode(() => ({ text: 'not-json' }), 'TIZHUANG_BAD_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// 4. 知识点映射
// ---------------------------------------------------------------------------

describe('知识点映射：三级命中', () => {
  const points = [
    { id: 'cne_a1', name: '谓语' },
    { id: 'cne_a2', name: '非谓语动词' },
    { id: 'cne_b1', name: 'it 作形式宾语' },
    { id: 'cne_c1', name: '并列连词 and/but/or/so' },
    { id: 'cne_d1', name: '形容词位置' },
    { id: 'cne_e1', name: '记叙文' },
  ];

  test('exact：完全同名', () => {
    const hit = mapTizhuangKnowledgeName('谓语', points);
    assert.equal(hit.confidence, 'exact');
    assert.equal(hit.id, 'cne_a1');
    assert.equal(hit.matchedName, '谓语');
  });

  test('contains：前缀/后缀边界对齐，且取最短候选', () => {
    const hit = mapTizhuangKnowledgeName('非谓语动词', points);
    assert.equal(hit.confidence, 'exact');

    // '谓语' 不得匹配到 '非谓语动词'（内部包含但边界不对齐）
    const strict = mapTizhuangKnowledgeName('谓语', [
      { id: 'cne_a2', name: '非谓语动词' },
    ]);
    assert.equal(strict.confidence, 'none');
    assert.equal(strict.id, '');
  });

  test('alias：别名表命中', () => {
    // '形式宾语' 是 'it 作形式宾语' 的后缀 → ② contains 先命中（规则顺序：exact → contains → alias）
    const contains = mapTizhuangKnowledgeName('形式宾语', points);
    assert.equal(contains.confidence, 'contains');
    assert.equal(contains.id, 'cne_b1');

    // 名字与项目知识点完全不同构 → 落到 ③ alias
    const alias2 = mapTizhuangKnowledgeName('ing形容词和ed形容词', points);
    assert.equal(alias2.confidence, 'alias');
    assert.equal(alias2.id, 'cne_d1');

    // '人物故事类阅读' 与项目知识点名不同构 → 纯 alias 命中
    const alias3 = mapTizhuangKnowledgeName('人物故事类阅读', points);
    assert.equal(alias3.confidence, 'alias');
    assert.equal(alias3.id, 'cne_e1');
  });

  test('none：完全不匹配', () => {
    const hit = mapTizhuangKnowledgeName('完全无关的知识点名字', points);
    assert.equal(hit.confidence, 'none');
    assert.equal(hit.id, '');
    assert.equal(hit.matchedName, '');
  });

  test('批量映射：保持输入顺序', () => {
    const results = mapTizhuangKnowledgeNames(
      ['谓语', '形式宾语', '不存在的点'],
      points
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].id, 'cne_a1');
    assert.equal(results[1].id, 'cne_b1');
    assert.equal(results[2].confidence, 'none');
  });

  test('映射到的是运行时真实存在的原生 id', () => {
    const real = getCurriculum().knowledgePoints.map((p) => ({
      id: p.id,
      name: p.name,
      subject: p.subject,
    }));
    const hit = mapTizhuangKnowledgeName('并列连词', real);
    assert.ok(hit.id, '并列连词应命中真实知识点');
    assert.ok(real.some((p) => p.id === hit.id));
    assert.ok(/^(cnm|cne|cnc|cnp|cnk)(_[a-z0-9]+)+$/.test(hit.id));
  });

  test('别名表的所有候选名都存在于运行时课程资产', () => {
    const names = new Set(
      getCurriculum().knowledgePoints.map((p) => p.name)
    );
    const missing: string[] = [];
    for (const [, candidates] of Object.entries(TIZHUANG_KNOWLEDGE_ALIASES)) {
      for (const candidate of candidates) {
        if (!names.has(candidate)) missing.push(candidate);
      }
    }
    for (const [, candidates] of Object.entries(TIZHUANG_ALIAS_FALLBACK)) {
      for (const candidate of candidates) {
        if (!names.has(candidate)) missing.push(candidate);
      }
    }
    assert.deepEqual(missing, [], `别名目标不存在：${missing.join('、')}`);
  });
});

// ---------------------------------------------------------------------------
// 5. 缓存层
// ---------------------------------------------------------------------------

describe('缓存层', () => {
  let tmpDir: string;
  const previousDataDir = process.env.DATA_DIR;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tz-cache-'));
    process.env.DATA_DIR = tmpDir;
  });

  after(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('同一 externalId 二次抓取不重复入库', () => {
    const item = {
      externalId: 1001,
      stem: 'stem',
      answer: 'A',
      questionType: '选择题',
      difficulty: 3,
      knowledgeNames: ['谓语'],
      autoGradable: true,
      hasImages: false,
      imageUrls: [],
      knowledgeIds: ['cne_a1'],
      fetchedAt: new Date().toISOString(),
    };
    upsertQuestions('英语', [item]);
    upsertQuestions('英语', [{ ...item, stem: 'stem-updated' }]);

    const cache = readCachedQuestions('英语');
    assert.equal(cache.items.length, 1);
    assert.equal(cache.items[0].externalId, 1001);
    assert.equal(cache.items[0].stem, 'stem-updated');
  });

  test('缓存文件落在 data/tizhuang/ 且结构正确', () => {
    const file = path.join(tmpDir, 'tizhuang', 'questions-英语.json');
    assert.ok(fs.existsSync(file), '缓存文件应写入 <DATA_DIR>/tizhuang/');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.subject, '英语');
    assert.ok(Array.isArray(parsed.items));
    assert.ok(parsed.fetchedAt);
  });

  test('按知识点检索缓存', () => {
    const hits = selectCachedByKnowledge('英语', 'cne_a1', 0);
    assert.equal(hits.length, 1);
    assert.equal(selectCachedByKnowledge('英语', 'cne_zzz', 0).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. 路由
// ---------------------------------------------------------------------------

describe('路由：可降级响应', () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let fetchImpl: FetchLike;
  const previousDataDir = process.env.DATA_DIR;

  const englishPoints = getCurriculum().knowledgePoints.filter(
    (p) => p.subject === '英语'
  );
  const targetPoint = englishPoints.find((p) => p.name === '频度副词') ?? englishPoints[0];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddu-tz-route-'));
    // 缓存写盘必须落在临时目录，避免污染仓库 data/tizhuang
    process.env.DATA_DIR = tmpDir;

    // 假 fetch：知识点树 + 题目
    const fake = createFakeFetch((call) => {
      if (call.url.includes('/v1/meta/knowledge-points')) {
        return {
          body: [
            {
              id: 2031,
              knowledge_id: 94453,
              name: targetPoint.name,
              parent_id: 2030,
              level: 3,
              has_children: false,
            },
          ],
        };
      }
      return {
        body: {
          items: [
            rawTizhuangItem({
              id: 2826735,
              knowledges: targetPoint.name,
              question_type: '选择题',
            }),
          ],
          count: 1,
          quota_remaining_today: 47,
        },
      };
    });
    fetchImpl = fake.fetchImpl;

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createTizhuangRoutes({} as Container, {
        tizhuangConfig: { fetchImpl, license: 'TEST-LICENSE' },
      })
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('未映射的知识点 → found:false 且不报错', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/practice/external?knowledgeId=不存在的知识点`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.found, false);
    assert.equal(body.source, 'tizhuang');
    assert.deepEqual(body.questions, []);
    assert.equal(body.reason, 'NO_KNOWLEDGE_MAPPING');
  });

  test('在线命中 → 返回 contracts 形状的题目，id 为原生 id', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/practice/external?knowledgeId=${targetPoint.id}&limit=5`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      found: boolean;
      source: string;
      quotaRemaining: number | null;
      questions: {
        id: string;
        subject: string;
        region: string;
        grade: string;
        knowledgeIds: string[];
        options?: string[];
      }[];
    };
    assert.equal(body.found, true);
    assert.equal(body.source, 'tizhuang');
    assert.equal(body.quotaRemaining, 47);
    assert.equal(body.questions.length, 1);
    const q = body.questions[0];
    assert.equal(q.id, 'cne_tz_2826735');
    assert.ok(/^(cnm|cne|cnc|cnp|cnk)(_[a-z0-9]+)+$/.test(q.id));
    assert.equal(q.subject, '英语');
    assert.equal(q.region, '上海');
    assert.equal(q.grade, '初三');
    assert.ok(q.knowledgeIds.includes(targetPoint.id));
    assert.ok(Array.isArray(q.options));
  });

  test('缓存优先：再次请求不再触发网络', async () => {
    const calls: FakeCall[] = [];
    const counting: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} });
      throw new Error('网络不应被触发');
    };
    const app = express();
    app.use('/api/v1', createTizhuangRoutes({} as Container, {
      tizhuangConfig: { fetchImpl: counting, license: 'TEST-LICENSE' },
    }));
    const local = app.listen(0);
    await new Promise<void>((resolve) => local.once('listening', resolve));
    const addr = local.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/api/v1/practice/external?knowledgeId=${targetPoint.id}&limit=1`;

    const res = await fetch(url);
    const body = (await res.json()) as { found: boolean; questions: unknown[] };
    assert.equal(res.status, 200);
    assert.equal(body.found, true);
    assert.equal(body.questions.length, 1);
    assert.equal(calls.length, 0, '缓存足够时不应发起在线请求');
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  test('网络失败 → found:false 可降级（HTTP 200）', async () => {
    const failing: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    const app = express();
    app.use('/api/v1', createTizhuangRoutes({} as Container, {
      tizhuangConfig: { fetchImpl: failing, license: 'TEST-LICENSE' },
    }));
    const local = app.listen(0);
    await new Promise<void>((resolve) => local.once('listening', resolve));
    const addr = local.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/api/v1/practice/external?knowledgeId=${targetPoint.id}&limit=5`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { found: boolean; reason?: string };
    assert.equal(body.found, false);
    assert.equal(body.reason, 'TIZHUANG_UNAVAILABLE');
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  test('鉴权失败 → HTTP 503 + reason 可区分', async () => {
    const unauthorized: FetchLike = async () =>
      jsonResponse({ detail: '未授权' }, 401);
    const app = express();
    app.use('/api/v1', createTizhuangRoutes({} as Container, {
      tizhuangConfig: { fetchImpl: unauthorized, license: 'TEST-LICENSE' },
    }));
    const local = app.listen(0);
    await new Promise<void>((resolve) => local.once('listening', resolve));
    const addr = local.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/api/v1/practice/external?knowledgeId=${targetPoint.id}&limit=5`
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { found: boolean; reason?: string };
    assert.equal(body.found, false);
    assert.equal(body.reason, 'TIZHUANG_AUTH_FAILED');
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });
});
