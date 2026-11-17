/**
 * 知识体系快照缓存测试。
 *
 * 分离后知识体系是服务端资产，前端通过 API 拉取 + 本地快照兜底。
 * 快照是「断网仍可浏览知识体系」这条产品承诺的实现，
 * 降级行为（数据损坏 → 当作没有 → 回落到服务端）必须可靠。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, type MemoryStorage } from './helpers/local-storage.ts';
import {
  loadSnapshot,
  saveSnapshot,
  buildCurriculumData,
} from '../src/store/curriculum.tsx';

const CACHE_KEY = 'daydayup.curriculum.snapshot';

let storage: MemoryStorage;
let restore: () => void;

const KP = {
  id: 'math-alg-rational',
  name: '有理数运算',
  subject: '数学',
  prerequisites: [],
} as never;

beforeEach(() => {
  const installed = installLocalStorage();
  storage = installed.storage;
  restore = installed.restore;
});

afterEach(() => {
  restore();
});

describe('快照读写', () => {
  test('保存后能读回版本与知识点', () => {
    saveSnapshot('shanghai-junior-2026.1', [KP]);

    const snap = loadSnapshot();
    assert.ok(snap);
    assert.equal(snap.version, 'shanghai-junior-2026.1');
    assert.equal(snap.knowledgePoints.length, 1);
    assert.equal(snap.knowledgePoints[0].id, 'math-alg-rational');
  });

  test('无快照时返回 null', () => {
    assert.equal(loadSnapshot(), null);
  });

  test('空知识点列表视为无快照', () => {
    storage.setItem(CACHE_KEY, JSON.stringify({ version: 'v1', knowledgePoints: [] }));
    assert.equal(loadSnapshot(), null, '空列表不是有效快照');
  });

  test('内容非法时返回 null（不抛错）', () => {
    storage.setItem(CACHE_KEY, '{broken');
    assert.equal(loadSnapshot(), null);
  });

  test('knowledgePoints 不是数组时返回 null', () => {
    storage.setItem(CACHE_KEY, JSON.stringify({ version: 'v1', knowledgePoints: 'x' }));
    assert.equal(loadSnapshot(), null);
  });

  test('写入失败（配额超限）不抛错', () => {
    restore();
    const failing = installLocalStorage({ failOnWrite: true });
    try {
      assert.doesNotThrow(() => saveSnapshot('v1', [KP]));
    } finally {
      failing.restore();
    }
  });

  test('读取时存储异常安全返回 null', () => {
    restore();
    const globalRef = globalThis as unknown as { localStorage?: unknown };
    globalRef.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    assert.equal(loadSnapshot(), null);

    delete globalRef.localStorage;
  });
});

describe('畸形快照的容错（回归）', () => {
  /**
   * 历史缺陷：快照只校验「是数组且非空」，
   * 数组里混进 null / 缺字段的元素时，
   * `buildCurriculumData` 的 `kp.id` 会抛 TypeError ——
   * 而它发生在 React 的 `useState` 初始化器里，**整个应用白屏**。
   *
   * 快照的现实来源：写入被中断、旧版本应用、缓存被外部改过。
   */
  test('含 null 元素的快照被过滤，不抛错', () => {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: 'v1',
        knowledgePoints: [KP, null] as never,
      })
    );

    assert.doesNotThrow(() => loadSnapshot());
    const snap = loadSnapshot();
    assert.ok(snap);
    assert.equal(snap.knowledgePoints.length, 1, '畸形元素应被过滤');
  });

  test('元素缺少 id 的快照被过滤', () => {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: 'v1',
        knowledgePoints: [{ name: '无 id' }, KP] as never,
      })
    );

    const snap = loadSnapshot();
    assert.ok(snap);
    assert.equal(snap.knowledgePoints.length, 1);
    assert.equal(snap.knowledgePoints[0].id, 'math-alg-rational');
  });

  test('元素缺少 name 的快照被过滤', () => {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: 'v1',
        knowledgePoints: [{ id: 'kp-x' }, KP] as never,
      })
    );

    const snap = loadSnapshot();
    assert.ok(snap);
    assert.equal(snap.knowledgePoints.length, 1);
  });

  test('全部元素都畸形时视为无快照', () => {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({ version: 'v1', knowledgePoints: [null, {}] as never })
    );
    assert.equal(loadSnapshot(), null);
  });

  test('buildCurriculumData 对畸形数据不抛错', () => {
    assert.doesNotThrow(() =>
      buildCurriculumData('v1', [KP, null, {}] as never)
    );
    const data = buildCurriculumData('v1', [KP, null, {}] as never);
    assert.equal(data.knowledgePoints.length, 1, '畸形元素应被过滤');
    assert.equal(Object.keys(data.knowledgeMap).length, 1);
  });

  test('buildCurriculumData 对非数组输入不抛错', () => {
    assert.doesNotThrow(() =>
      buildCurriculumData('v1', undefined as never)
    );
    const data = buildCurriculumData('v1', undefined as never);
    assert.deepEqual(data.knowledgePoints, []);
    assert.deepEqual(data.knowledgeMap, {});
  });
});

describe('知识体系索引构建', () => {
  test('knowledgeMap 按 id 建立索引', () => {
    const data = buildCurriculumData('v1', [KP]);
    assert.equal(data.version, 'v1');
    assert.equal(data.knowledgePoints.length, 1);
    assert.equal(data.knowledgeMap['math-alg-rational'].name, '有理数运算');
  });

  test('空列表得到空索引', () => {
    const data = buildCurriculumData('v1', []);
    assert.deepEqual(data.knowledgeMap, {});
    assert.deepEqual(data.knowledgePoints, []);
  });
  test('多个知识点都能索引到', () => {
    const kp2 = { ...(KP as object), id: 'math-func-linear', name: '一次函数' } as never;
    const data = buildCurriculumData('v1', [KP, kp2]);
    assert.equal(Object.keys(data.knowledgeMap).length, 2);
    assert.ok(data.knowledgeMap['math-func-linear']);
  });

  test('相同 id 后者覆盖前者（与 Object.fromEntries 语义一致）', () => {
    const dup = { ...(KP as object), name: '另一个名字' } as never;
    const data = buildCurriculumData('v1', [KP, dup]);
    assert.equal(data.knowledgeMap['math-alg-rational'].name, '另一个名字');
    assert.equal(data.knowledgePoints.length, 2);
  });
});
