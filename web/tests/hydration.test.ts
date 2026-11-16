/**
 * 服务端水合核心逻辑测试。
 *
 * 水合是「服务端是唯一真相源」这条原则的落地环节 ——
 * 它错了，前端就会展示错误的学习数据。
 *
 * 覆盖：
 * - 7 类数据全部加载
 * - **空列表不中断后续加载**（历史缺陷：错题为空则后续全不加载）
 * - 单类失败不影响其它类别
 * - 合并语义（掌握度是合并而非替换）
 * - 取消后不再写入状态
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers/local-storage.ts';
import type { AppState } from '@daydayup/contracts';
import { INITIAL_APP_STATE } from '../src/data/initialStore.ts';
import { createLocalSkeleton } from '../src/store/local-state.ts';

let restoreStorage: () => void;
let requestedPaths: string[] = [];

/** 骨架（无业务数据） */
function skeleton(): AppState {
  return createLocalSkeleton(INITIAL_APP_STATE);
}

/** 追踪状态更新 */
function stateTracker() {
  let state = skeleton();
  const setter = (updater: React.SetStateAction<AppState>) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return {
    setter,
    get: () => state,
  };
}

/**
 * 安装 fetch 打桩。
 * @param responses 路径后缀 → 响应体；未命中则 404
 */
function stubFetch(
  responses: Record<string, unknown>,
  failingPaths: string[] = []
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedPaths.push(url);

    for (const failPath of failingPaths) {
      if (url.endsWith(failPath)) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x' } }),
        } as unknown as Response;
      }
    }

    for (const [suffix, body] of Object.entries(responses)) {
      if (url.endsWith(suffix)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      }
    }

    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }),
    } as unknown as Response;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  requestedPaths = [];
  const installed = installLocalStorage();
  restoreStorage = installed.restore;
});

afterEach(() => {
  restoreStorage();
});

describe('水合加载全部数据类型', () => {
  test('7 类数据全部被请求并写入状态', async () => {
    const restore = stubFetch({
      '/mastery/history': { history: [{ id: 'h1' }] },
      '/mastery': { records: { 'math-alg-rational': { knowledgeId: 'math-alg-rational', state: '学习中' } } },
      '/error-records': { records: [{ id: 'e1', knowledgeId: 'math-alg-rational' }] },
      '/attempts': { attempts: [{ id: 'a1' }] },
      '/exams': { exams: [{ id: 'x1', title: '期中' }] },
      '/papers': { papers: [{ id: 'p1', title: '试卷' }] },
      '/exam-results': { results: [{ id: 'r1', score: 80 }] },
    });

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();
      const result = await hydrateFromServer('stu-1', tracker.setter);

      assert.equal(result.failed.length, 0, `不应有失败: ${result.failed.join(',')}`);
      assert.equal(result.loaded.length, 7, `应加载 7 类数据，实际 ${result.loaded.length}`);

      const state = tracker.get();
      assert.equal(state.masteryRecords['math-alg-rational'].state, '学习中');
      assert.equal(state.masteryHistory.length, 1);
      assert.equal(state.errorRecords.length, 1);
      assert.equal(state.learningAttempts.length, 1);
      assert.equal(state.exams.length, 1);
      assert.equal(state.examPapers.length, 1);
      assert.equal(state.examResults.length, 1);
    } finally {
      restore();
    }
  });
});

describe('空列表不中断后续加载（回归）', () => {
  /**
   * 历史缺陷：错题记录为空时 `return` 退出了整个水合流程，
   * 导致作答流水、考试场次、试卷存档库、考试成绩**全都不再加载**。
   *
   * 症状：没有错题的学生，试卷存档库（TC-08）恒为空。
   */
  test('错题为空时，其余 6 类数据仍会加载', async () => {
    const restore = stubFetch({
      '/mastery/history': { history: [] },
      '/mastery': { records: {} },
      '/error-records': { records: [] }, // ← 触发历史缺陷的空列表
      '/attempts': { attempts: [{ id: 'a1' }] },
      '/exams': { exams: [{ id: 'x1' }] },
      '/papers': { papers: [{ id: 'p1' }] },
      '/exam-results': { results: [{ id: 'r1' }] },
    });

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();
      const result = await hydrateFromServer('stu-1', tracker.setter);

      assert.equal(result.loaded.length, 7, `应加载 7 类数据，实际 ${result.loaded.length}`);
      assert.ok(result.loaded.includes('examPapers'), '试卷存档库必须被加载');

      const state = tracker.get();
      assert.equal(state.errorRecords.length, 0);
      assert.equal(state.examPapers.length, 1, '试卷存档库不应因错题为空而丢失');
      assert.equal(state.examResults.length, 1);
      assert.equal(state.learningAttempts.length, 1);
    } finally {
      restore();
    }
  });

  test('每类接口返回空列表时都能继续', async () => {
    const restore = stubFetch({
      '/mastery/history': { history: [] },
      '/mastery': { records: {} },
      '/error-records': { records: [] },
      '/attempts': { attempts: [] },
      '/exams': { exams: [] },
      '/papers': { papers: [] },
      '/exam-results': { results: [] },
    });

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();
      const result = await hydrateFromServer('stu-1', tracker.setter);

      assert.equal(result.loaded.length, 7);
      assert.equal(result.failed.length, 0);
    } finally {
      restore();
    }
  });
});

describe('单类失败不影响其它类别', () => {
  test('一个接口 500 时，其余 6 类仍加载成功', async () => {
    const restore = stubFetch(
      {
        '/mastery/history': { history: [] },
        '/mastery': { records: {} },
        '/error-records': { records: [] },
        '/attempts': { attempts: [{ id: 'a1' }] },
        '/exams': { exams: [{ id: 'x1' }] },
        '/papers': { papers: [{ id: 'p1' }] },
        '/exam-results': { results: [{ id: 'r1' }] },
      },
      ['/error-records']
    );

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();
      const result = await hydrateFromServer('stu-1', tracker.setter);

      assert.deepEqual(result.failed, ['errorRecords']);
      assert.equal(result.loaded.length, 6);

      const state = tracker.get();
      // 失败的那类保留骨架原值
      assert.equal(state.errorRecords.length, 0);
      // 其余照常写入
      assert.equal(state.examPapers.length, 1);
    } finally {
      restore();
    }
  });

  test('全部接口失败时状态保持骨架（不崩溃）', async () => {
    const restore = stubFetch({}, [
      '/mastery/history', '/mastery', '/error-records',
      '/attempts', '/exams', '/papers', '/exam-results',
    ]);

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();
      const result = await hydrateFromServer('stu-1', tracker.setter);

      assert.equal(result.failed.length, 7);
      assert.equal(result.loaded.length, 0);

      const state = tracker.get();
      assert.equal(state.examPapers.length, 0);
      assert.equal(state.errorRecords.length, 0);
      // 骨架本身完好
      assert.ok(state.student.id);
    } finally {
      restore();
    }
  });
});

describe('合并语义', () => {
  test('掌握度是合并而非替换（保留已有条目）', async () => {
    const restore = stubFetch({
      '/mastery': { records: { 'new-kp': { knowledgeId: 'new-kp', state: '学习中' } } },
      '/mastery/history': { history: [] },
      '/error-records': { records: [] },
      '/attempts': { attempts: [] },
      '/exams': { exams: [] },
      '/papers': { papers: [] },
      '/exam-results': { results: [] },
    });

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');

      // 先放一条本地已有的掌握度
      let state = skeleton();
      state = {
        ...state,
        masteryRecords: {
          'old-kp': { knowledgeId: 'old-kp', state: '未学习' } as never,
        },
      };
      const setter = (u: React.SetStateAction<AppState>) => {
        state = typeof u === 'function' ? u(state) : u;
      };

      await hydrateFromServer('stu-1', setter);

      assert.ok(state.masteryRecords['old-kp'], '原有掌握度条目应保留');
      assert.ok(state.masteryRecords['new-kp'], '新条目应被合并进来');
    } finally {
      restore();
    }
  });
});

describe('取消处理', () => {
  test('取消后不再写入状态', async () => {
    const restore = stubFetch({
      '/mastery': { records: { k: { knowledgeId: 'k', state: '学习中' } } },
      '/mastery/history': { history: [] },
      '/error-records': { records: [] },
      '/attempts': { attempts: [] },
      '/exams': { exams: [] },
      '/papers': { papers: [] },
      '/exam-results': { results: [] },
    });

    try {
      const { hydrateFromServer } = await import('../src/store/hydration-core.ts');
      const tracker = stateTracker();

      // 一开始就视为已取消
      await hydrateFromServer('stu-1', tracker.setter, {}, () => true);

      const state = tracker.get();
      assert.equal(Object.keys(state.masteryRecords).length, 0, '取消后不应写入任何数据');
    } finally {
      restore();
    }
  });
});
