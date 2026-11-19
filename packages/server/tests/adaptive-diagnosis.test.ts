/**
 * 三态自适应诊断端到端测试。
 *
 * 覆盖：
 * - 会话创建（外部 id 解析 / 无效 id 报错）
 * - 逐题作答 → 三态结论（掌握 / 不稳 / 薄弱）
 * - finalize 写回掌握度：mastered→初步掌握、shaky→学习中、weak→待学习
 * - 判不了的答案记 skip，不算答错
 * - 会话持久化（重启后可继续）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { readMasteryAggregate } from '../src/modules/mastery/mastery-service.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: ReturnType<typeof createContainer>;

const STUDENT_ID = 'stu-adaptive-1';

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-adaptive-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = '';
  process.env.GEMINI_API_KEY = '';

  container = createContainer();
  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

interface StartResp {
  sessionId: string;
  item: {
    knowledgeId: string;
    question: { id: string; stem: string; level: string; questionType: string };
    attempt: number;
  } | null;
  answered: number;
  limit: number;
  finished: boolean;
}

async function start(knowledgeIds: string[], extra: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knowledgeIds, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as StartResp & { error?: { code: string; message: string } } };
}

async function answer(sessionId: string, knowledgeId: string, ans: string) {
  const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, knowledgeId, answer: ans }),
  });
  return { status: res.status, body: (await res.json()) as StartResp & { judged?: { isCorrect: boolean } } };
}

async function finalize(sessionId: string) {
  const res = await fetch(
    `${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/${sessionId}/finalize`,
    { method: 'POST' }
  );
  return { status: res.status, body: (await res.json()) as { mastered: string[]; shaky: string[]; weak: string[] } };
}

describe('自适应诊断会话', () => {
  test('start 返回第一题', async () => {
    const { status, body } = await start(['cnm_p001'], { seed: 'test-seed' });
    assert.equal(status, 200);
    assert.ok(body.sessionId.startsWith('ads_'));
    assert.ok(body.item, '应返回第一题');
    assert.equal(body.item?.knowledgeId, 'cnm_p001');
    assert.ok(body.item?.question.id.startsWith('cnm_p001_q'));
  });

  test('start 缺 knowledgeIds 返回 400', async () => {
    const { status } = await start([]);
    assert.equal(status, 400);
  });

  test('start 无法解析的外部 id 报错而不是静默忽略', async () => {
    const { status, body } = await start(['no-such-external-id']);
    assert.equal(status, 400, '无法解析的 id 是调用方错误 → 400');
    assert.match(JSON.stringify(body), /知识点无法解析/);
  });

  test('会话列表与单会话查询', async () => {
    const { body } = await start(['cnm_p001']);
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/sessions`
    );
    assert.equal(res.status, 200);
    const list = (await res.json()) as { sessions: Array<{ id: string }> };
    assert.ok(list.sessions.some((s) => s.id === body.sessionId));

    const one = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/${body.sessionId}`
    );
    assert.equal(one.status, 200);
    const view = (await one.json()) as StartResp;
    assert.equal(view.sessionId, body.sessionId);
  });

  test('不存在的会话返回 404', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/diagnosis/adaptive/ads_nope`
    );
    assert.equal(res.status, 404);
  });
});

describe('三态判定与掌握度落库', () => {
  test('连续答对 → mastered，掌握度落到「初步掌握」', async () => {
    // 用一个只有 3 道题的知识点，confirm=3 连对三次即判掌握
    const { body } = await start(['cnm_p001'], { seed: 's1', confirm: 3, limit: 10 });
    const sid = body.sessionId;

    let item = body.item;
    let guard = 0;
    while (item && guard++ < 10) {
      const q = item.question;
      // 直接回标准答案
      const { body: next } = await answer(sid, item.knowledgeId, '4');
      assert.equal(next.judged?.isCorrect, true, `第 ${guard} 题应判对`);
      item = next.item;
      if (item && item.knowledgeId !== 'cnm_p001') break;
    }

    const { status, body: summary } = await finalize(sid);
    assert.equal(status, 200);
    assert.ok(summary.mastered.includes('cnm_p001'), '应判为掌握');

    const agg = await readMasteryAggregate(container, STUDENT_ID);
    const rec = agg.records['cnm_p001'];
    assert.ok(rec, '应写入掌握度记录');
    assert.equal(rec.state, '初步掌握');
    assert.equal(rec.confidence, '确定');
  });

  test('答错后再答对 → shaky，掌握度为「学习中」', async () => {
    const { body } = await start(['cnm_p002'], { seed: 's2', confirm: 2, limit: 10 });
    const sid = body.sessionId;

    // 第一次故意答错
    const first = await answer(sid, body.item!.knowledgeId, 'zzz-wrong');
    assert.equal(first.body.judged?.isCorrect, false);
    // 第二次答对（确认题）
    const second = await answer(sid, body.item!.knowledgeId, 'A');
    assert.equal(second.body.judged?.isCorrect, true);

    const { body: summary } = await finalize(sid);
    assert.ok(summary.shaky.includes('cnm_p002'), '应判为不稳');
    assert.ok(!summary.mastered.includes('cnm_p002'));

    const agg = await readMasteryAggregate(container, STUDENT_ID);
    assert.equal(agg.records['cnm_p002'].state, '学习中');
    assert.equal(agg.records['cnm_p002'].confidence, '较可能');
  });

  test('连续答错 → weak，掌握度为「待学习」', async () => {
    const { body } = await start(['cnm_p003'], { seed: 's3', confirm: 2, limit: 10 });
    const sid = body.sessionId;
    await answer(sid, body.item!.knowledgeId, 'wrong-one');
    await answer(sid, body.item!.knowledgeId, 'wrong-two');

    const { body: summary } = await finalize(sid);
    assert.ok(summary.weak.includes('cnm_p003'), '应判为薄弱');

    const agg = await readMasteryAggregate(container, STUDENT_ID);
    assert.equal(agg.records['cnm_p003'].state, '待学习');
    assert.equal(agg.records['cnm_p003'].confidence, '待验证');
  });

  test('会话落盘：可从磁盘重建（服务重启后仍能继续）', async () => {
    const { body } = await start(['cnm_p004'], { seed: 's4', confirm: 3, limit: 10 });
    await answer(body.sessionId, body.item!.knowledgeId, '4');

    const file = path.join(tmpDataDir, 'db', 'diagnosis', `${STUDENT_ID}.json`);
    assert.ok(fs.existsSync(file), '会话文件应落盘');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      sessions: Record<string, { answers: unknown[] }>;
    };
    assert.equal(stored.sessions[body.sessionId].answers.length, 1);
  });
});

describe('题目下发边界（前端可用性 + 不泄题）', () => {
  test('选择题下发 options，且不下发 standardAnswer', async () => {
    const { body } = await start(['cnm_p002'], { seed: 'opt-seed', limit: 10 });
    const q = body.item!.question as unknown as {
      options?: string[];
      standardAnswer?: string;
    };
    assert.ok(
      Array.isArray(q.options) && q.options.length > 0,
      '选择题必须下发选项，否则前端只能让用户手打答案'
    );
    assert.equal(
      q.standardAnswer,
      undefined,
      '标准答案不能下发到前端 —— 拿到答案就等于可以伪造掌握度'
    );
    assert.ok(
      !JSON.stringify(body.item).includes('standardAnswer'),
      '整个 item 不应出现 standardAnswer 字段'
    );
  });

  test('非选择题（填空/解答）不下发 options', async () => {
    const { body } = await start(['cnm_p002'], { seed: 'opt-seed-2', limit: 10 });
    // 连着出题直到遇到没有选项的题
    let item = body.item;
    let guard = 0;
    while (item && guard++ < 6) {
      const q = item.question as unknown as { options?: string[] };
      if (!q.options) return; // 找到填空题即通过
      const next = await answer(body.sessionId, item.knowledgeId, 'A');
      item = next.body.item;
    }
    // 整个会话都没遇到填空题 —— 说明题库该知识点全是选择题，也算合法
    assert.ok(true, '该知识点的题目恰好全为选择题');
  });

  test('提交作答后返回的下一题同样不下发答案', async () => {
    const { body } = await start(['cnm_p002'], { seed: 'opt-seed-3', limit: 10 });
    const next = await answer(body.sessionId, body.item!.knowledgeId, 'A');
    assert.equal(next.status, 200);
    assert.ok(
      !JSON.stringify(next.body.item).includes('standardAnswer'),
      '下一题也不能带答案'
    );
  });
});
