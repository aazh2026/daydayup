/**
 * 错因形态分布前端层测试。
 *
 * 覆盖两条边界：
 *
 * 1. **取数层**（`src/api/trap-distribution.ts`）—— 请求路径拼装、错误透出。
 *    这一层是前后端契约的边界：路径写错就是 404，前端拿不到分布。
 *
 * 2. **权威边界**——分类规则只允许存在于服务端。前端若自行实现分类，
 *    两端口径必然漂移（同一条错因在报告页和服务端对不上号）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers/local-storage.ts';
import { saveSession, clearSession } from '../src/store/auth.ts';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: FetchCall[] = [];
let restoreStorage: () => void;
const realFetch = globalThis.fetch;

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
  } as unknown as Response;
}

const DISTRIBUTION_PAYLOAD = {
  totalErrors: 3,
  attributedErrors: 2,
  unattributedErrors: 1,
  attributedLost: 8,
  unattributedLost: 2,
  buckets: [
    {
      type: '概念混淆',
      label: '把两个概念搞混',
      count: 2,
      lost: 8,
      pct: 80,
      topKnowledge: [
        {
          knowledgeId: 'cnm_p009',
          knowledgeName: '第几',
          count: 2,
          lost: 8,
        },
      ],
    },
  ],
  samples: [],
};

beforeEach(() => {
  calls = [];
  const installed = installLocalStorage();
  restoreStorage = installed.restore;
  clearSession();
  saveSession({ token: 'tok_test', studentId: 'stu-1', role: 'student' });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return jsonResponse(200, DISTRIBUTION_PAYLOAD);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreStorage();
});

describe('错因形态分布取数层（trap-distribution）', () => {
  test('请求学生维度的 trap-distribution 路径', async () => {
    const { fetchTrapDistribution } = await import('../src/api/trap-distribution.ts');
    const result = await fetchTrapDistribution('stu-sh-zhangwei');

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      '/api/v1/students/stu-sh-zhangwei/trap-distribution'
    );
    assert.equal(calls[0].method, 'GET');

    assert.equal(result.totalErrors, 3);
    assert.equal(result.attributedErrors, 2);
    assert.equal(result.unattributedErrors, 1);
    assert.equal(result.buckets[0].type, '概念混淆');
    assert.equal(result.buckets[0].topKnowledge[0].knowledgeName, '第几');
  });

  test('服务端错误原样透出（前端不吞错误）', async () => {
    globalThis.fetch = (async () => {
      throw new Error('错因形态分布加载失败');
    }) as typeof fetch;

    const { fetchTrapDistribution } = await import('../src/api/trap-distribution.ts');
    await assert.rejects(
      () => fetchTrapDistribution('stu-sh-zhangwei'),
      /错因形态分布加载失败/
    );
  });

  test('前端不自带分类规则（分类权威在服务端）', async () => {
    // 前端只消费服务端返回的 type/label，不得在客户端重新推导形态
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../src/api/trap-distribution.ts', import.meta.url),
        'utf-8'
      )
    );
    assert.ok(!/classify|RegExp|\/把/.test(source), '前端不应实现分类规则');
  });
});
