/**
 * 本地状态边界测试。
 *
 * 分离后的核心约束：**localStorage 只保留客户端应持有的数据**。
 * 业务实体（掌握度 / 错题 / 计划 / 会话）一律由服务端水合，
 * 不得写入 localStorage —— 否则「服务端是唯一真相源」名存实亡。
 *
 * 覆盖：
 * - 遗留数据清理（分离前的老 key）
 * - 本地骨架构造（不得残留任何业务数据）
 * - UI 偏好读写
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, type MemoryStorage } from './helpers/local-storage.ts';
import {
  createLocalSkeleton,
  purgeLegacyState,
  loadUiPreferences,
  saveUiPreferences,
} from '../src/store/local-state.ts';
import { INITIAL_APP_STATE } from '../src/data/initialStore.ts';

const LEGACY_KEY = 'shanghai_ai_score_os_v5';

let storage: MemoryStorage;
let restore: () => void;

beforeEach(() => {
  const installed = installLocalStorage();
  storage = installed.storage;
  restore = installed.restore;
});

afterEach(() => {
  restore();
});

describe('遗留本地数据清理', () => {
  test('存在遗留 key 时清理并返回 true', () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({ student: { id: 'x' }, masteryRecords: {} })
    );

    assert.equal(purgeLegacyState(), true);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('不存在遗留 key 时返回 false（不重复清理）', () => {
    assert.equal(purgeLegacyState(), false);
  });

  test('清理不影响其他 key（token / 偏好 / 课程快照必须保留）', () => {
    storage.setItem(LEGACY_KEY, '{}');
    storage.setItem('daydayup.auth.token', 'tok-123');
    storage.setItem('daydayup.ui.prefs', '{"subject":"数学"}');
    storage.setItem('daydayup.curriculum.cache', '{"version":"v1"}');

    purgeLegacyState();

    assert.equal(storage.getItem('daydayup.auth.token'), 'tok-123');
    assert.equal(storage.getItem('daydayup.ui.prefs'), '{"subject":"数学"}');
    assert.equal(storage.getItem('daydayup.curriculum.cache'), '{"version":"v1"}');
  });

  test('遗留 key 内容非法（不是合法 JSON）也能清理', () => {
    storage.setItem(LEGACY_KEY, 'not-json{{{');
    assert.equal(purgeLegacyState(), true);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('存储异常时安全返回 false，不抛错', () => {
    // 模拟读取抛异常的环境
    const broken = installLocalStorage();
    broken.restore();
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

    assert.equal(purgeLegacyState(), false);

    delete globalRef.localStorage;
  });
});

describe('本地骨架构造', () => {
  test('清空所有业务数据字段', () => {
    const skeleton = createLocalSkeleton(INITIAL_APP_STATE);

    assert.deepEqual(skeleton.exams, []);
    assert.deepEqual(skeleton.examResults, []);
    assert.deepEqual(skeleton.examPapers, []);
    assert.deepEqual(skeleton.errorRecords, []);
    assert.deepEqual(skeleton.masteryRecords, {});
    assert.deepEqual(skeleton.masteryHistory, []);
    assert.deepEqual(skeleton.learningAttempts, []);
    assert.deepEqual(skeleton.variantQuestions, []);
    assert.deepEqual(skeleton.completedTaskIds, []);
    assert.deepEqual(skeleton.deferredKnowledgeIds, []);
    assert.deepEqual(skeleton.coachHistoryByKnowledge, {});
    assert.deepEqual(skeleton.taskProgressByKnowledge, {});
  });

  test('保留学生档案（骨架需要身份才能渲染）', () => {
    const skeleton = createLocalSkeleton(INITIAL_APP_STATE);
    assert.equal(skeleton.student.id, INITIAL_APP_STATE.student.id);
    assert.equal(skeleton.student.name, INITIAL_APP_STATE.student.name);
  });

  test('不修改传入的种子对象（不产生副作用）', () => {
    const before = JSON.stringify(INITIAL_APP_STATE);
    createLocalSkeleton(INITIAL_APP_STATE);
    assert.equal(JSON.stringify(INITIAL_APP_STATE), before);
  });

  test('骨架与种子是不同的对象引用', () => {
    const skeleton = createLocalSkeleton(INITIAL_APP_STATE);
    assert.notEqual(skeleton, INITIAL_APP_STATE);
    assert.notEqual(skeleton.masteryRecords, INITIAL_APP_STATE.masteryRecords);
  });
});

describe('UI 偏好', () => {
  test('读写往返', () => {
    saveUiPreferences({ subject: '数学', sidebarCollapsed: true });
    const prefs = loadUiPreferences();
    assert.equal(prefs.subject, '数学');
    assert.equal(prefs.sidebarCollapsed, true);
  });

  test('无数据时返回空对象', () => {
    assert.deepEqual(loadUiPreferences(), {});
  });

  test('内容非法时安全返回空对象', () => {
    storage.setItem('daydayup.ui.prefs', '{broken');
    assert.deepEqual(loadUiPreferences(), {});
  });

  test('写入失败（配额超限）不抛错', () => {
    restore();
    const failing = installLocalStorage({ failOnWrite: true });
    try {
      assert.doesNotThrow(() => saveUiPreferences({ subject: '英语' }));
    } finally {
      failing.restore();
    }
  });
});
