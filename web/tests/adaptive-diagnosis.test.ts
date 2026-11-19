/**
 * 三态自适应诊断前端层测试。
 *
 * 覆盖两条边界：
 *
 * 1. **取数层**（`src/api/adaptive-diagnosis.ts`）—— 请求路径、请求体形状、
 *    错误透传。这一层是前后端契约的边界，路径写错就是 404，
 *    body 字段名写错服务端就收不到知识点。
 *
 * 2. **面板纯函数**（`src/components/AdaptiveDiagnosisPanel.tsx`）——
 *    选项字母提取、选择题判定。选项字母提取错了就会把 'A. 4' 判成非选择题，
 *    学生只能手打答案。
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
    return jsonResponse(200, {
      sessionId: 'ads_1',
      item: null,
      answered: 0,
      limit: 12,
      finished: false,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreStorage();
  clearSession();
});

describe('自适应诊断取数层', () => {
  test('start：POST 到学生维度的 adaptive/start，body 带 knowledgeIds 与 mode', async () => {
    const { startAdaptiveDiagnosis } = await import('../src/api/adaptive-diagnosis.ts');
    await startAdaptiveDiagnosis('stu-1', {
      knowledgeIds: ['cnm_p002', 'cne_j243'],
      mode: 'screen',
      limit: 12,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.includes('/api/v1/students/stu-1/diagnosis/adaptive/start'));
    const body = JSON.parse(calls[0].body ?? '{}');
    assert.deepEqual(body.knowledgeIds, ['cnm_p002', 'cne_j243']);
    assert.equal(body.mode, 'screen');
    assert.equal(body.limit, 12);
  });

  test('answer：POST 到 adaptive/answer，body 带 sessionId / knowledgeId / answer / qid', async () => {
    const { submitAdaptiveAnswer } = await import('../src/api/adaptive-diagnosis.ts');
    await submitAdaptiveAnswer('stu-1', {
      sessionId: 'ads_1',
      knowledgeId: 'cnm_p002',
      answer: 'A',
      qid: 'cnm_p002_q3',
    });
    assert.ok(calls[0].url.includes('/api/v1/students/stu-1/diagnosis/adaptive/answer'));
    const body = JSON.parse(calls[0].body ?? '{}');
    assert.equal(body.sessionId, 'ads_1');
    assert.equal(body.knowledgeId, 'cnm_p002');
    assert.equal(body.answer, 'A');
    assert.equal(body.qid, 'cnm_p002_q3');
  });

  test('finalize：POST 到会话维度的 finalize', async () => {
    const { finalizeAdaptiveDiagnosis } = await import('../src/api/adaptive-diagnosis.ts');
    await finalizeAdaptiveDiagnosis('stu-1', 'ads_1');
    assert.ok(
      calls[0].url.includes('/api/v1/students/stu-1/diagnosis/adaptive/ads_1/finalize')
    );
    assert.equal(calls[0].method, 'POST');
  });

  test('fetch：GET 会话视图与列表', async () => {
    const { fetchAdaptiveSession, fetchAdaptiveSessions } = await import(
      '../src/api/adaptive-diagnosis.ts'
    );
    await fetchAdaptiveSession('stu-1', 'ads_1');
    await fetchAdaptiveSessions('stu-1');
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.includes('/api/v1/students/stu-1/diagnosis/adaptive/ads_1'));
    assert.ok(calls[1].url.includes('/api/v1/students/stu-1/diagnosis/adaptive/sessions'));
  });

  test('错误码透出：服务端 400 的 VALIDATION_FAILED 不能被吞掉', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, {
        error: { code: 'VALIDATION_FAILED', message: '知识点无法解析：m1-01-01-01-01' },
        requestId: 'req_x',
      })) as typeof fetch;

    const { startAdaptiveDiagnosis } = await import('../src/api/adaptive-diagnosis.ts');
    await assert.rejects(
      () => startAdaptiveDiagnosis('stu-1', { knowledgeIds: ['m1-01-01-01-01'] }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.match(err.message, /知识点无法解析/);
        return true;
      }
    );
  });
});

describe('自适应诊断面板纯函数', () => {
  test('选项字母提取：带前缀 / 带括号 / 纯字母都能取到', async () => {
    const { extractOptionLetter } = await import('../src/components/AdaptiveDiagnosisPanel.tsx');
    assert.equal(extractOptionLetter('A. 4'), 'A');
    assert.equal(extractOptionLetter('B. 2'), 'B');
    assert.equal(extractOptionLetter('（C）3'), 'C');
    assert.equal(extractOptionLetter('D'), 'D');
    assert.equal(extractOptionLetter('苹果多'), '');
  });

  test('选择题判定：空选项视为非选择题（走文本输入）', async () => {
    const { isChoiceQuestion } = await import('../src/components/AdaptiveDiagnosisPanel.tsx');
    assert.equal(isChoiceQuestion(['A. 4', 'B. 2']), true);
    assert.equal(isChoiceQuestion([]), false);
    assert.equal(isChoiceQuestion(undefined), false);
  });

  test('三态分组：按学科归类，未知学科归到「其他」', async () => {
    const { groupBySubject } = await import('../src/components/AdaptiveDiagnosisPanel.tsx');
    const grouped = groupBySubject(
      ['cnm_1', 'cnm_2', 'cne_1', 'unknown_1'],
      (id) =>
        id.startsWith('cnm') ? '数学' : id.startsWith('cne') ? '英语' : undefined
    );
    assert.deepEqual(grouped['数学'], ['cnm_1', 'cnm_2']);
    assert.deepEqual(grouped['英语'], ['cne_1']);
    assert.deepEqual(grouped['其他'], ['unknown_1']);
  });
});
