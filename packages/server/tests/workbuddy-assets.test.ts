/**
 * workbuddy 上海中考英语资产（overlay + 题库增量）测试。
 *
 * 这批资产的特殊性：
 * - 知识点不是教材单元，而是**应试点型**（音标、听力技巧、题型策略、写作要点），
 *   所以走 overlay 层而不是主知识资产；
 * - 题目来自第三方整理的真题拆解，知识点指向 overlay 条目，
 *   所以外键自检必须覆盖「overlay id」而不仅是主资产 id。
 *
 * 失败模式都是静默的：overlay 挂了不报错只是英语题型排不出来；
 * 题目指向不存在的知识点则永远取不到题。所以这里把资产钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCurriculum,
  getKnowledgeMap,
  getQuestionBank,
} from '../src/infrastructure/knowledge/curriculum.ts';
import { NATIVE_ID_PATTERN } from '../src/infrastructure/knowledge/id-namespace.ts';
import type {
  KnowledgeOverlaySet,
  Question,
} from '@daydayup/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const OVERLAY_FILE = path.join(
  DATA_DIR,
  'overlays/workbuddy-english-2026.11.json'
);
const BANK_FILE = path.join(
  DATA_DIR,
  'questions/bank-workbuddy-english-2026.02.json'
);

const overlaySet = JSON.parse(
  fs.readFileSync(OVERLAY_FILE, 'utf8')
) as KnowledgeOverlaySet;
const workbuddyBank = JSON.parse(
  fs.readFileSync(BANK_FILE, 'utf8')
) as { version: string; questions: Question[] };

describe('workbuddy overlay 资产', () => {
  test('资产文件存在且状态为 ACTIVE', () => {
    assert.ok(fs.existsSync(OVERLAY_FILE), 'overlay 资产文件应存在');
    assert.equal(overlaySet.status, 'ACTIVE');
    assert.equal(overlaySet.version, 'workbuddy-english-2026.11');
    assert.ok(overlaySet.publishedAt.length > 0);
    assert.ok(overlaySet.source.repo.includes('workbuddy-research'));
  });

  test('条目数量充足', () => {
    assert.ok(
      overlaySet.entries.length >= 400,
      `overlay 条目应 ≥ 400，实际 ${overlaySet.entries.length}`
    );
  });

  test('entry id 唯一且是项目原生 id', () => {
    const seen = new Set<string>();
    for (const entry of overlaySet.entries) {
      assert.ok(
        NATIVE_ID_PATTERN.test(entry.id),
        `entry id 不符合原生 id 规则：${entry.id}`
      );
      assert.ok(!seen.has(entry.id), `entry id 重复：${entry.id}`);
      seen.add(entry.id);
    }
  });

  test('prerequisites / relatedKnowledgeIds 均为合法原生 id', () => {
    for (const entry of overlaySet.entries) {
      for (const id of entry.prerequisites) {
        assert.ok(
          NATIVE_ID_PATTERN.test(id),
          `prerequisite 不是原生 id：${id}`
        );
      }
      for (const id of entry.relatedKnowledgeIds) {
        assert.ok(
          NATIVE_ID_PATTERN.test(id),
          `relatedKnowledgeId 不是原生 id：${id}`
        );
      }
    }
  });

  test('条目必备字段齐备', () => {
    for (const entry of overlaySet.entries) {
      assert.equal(entry.subject, '英语');
      assert.ok(entry.name.length > 0, 'name 不得为空');
      assert.ok(entry.definition.length > 0, 'definition 不得为空');
      assert.ok(Array.isArray(entry.prerequisites));
      assert.equal(typeof entry.examWeight, 'number');
      assert.equal(typeof entry.learningCostHours, 'number');
    }
  });

  test('overlay 已合并进 curriculum，knowledgeMap 与之保持一致', () => {
    const curriculum = getCurriculum();
    const map = getKnowledgeMap();
    assert.equal(
      Object.keys(map).length,
      curriculum.knowledgePoints.length,
      'getKnowledgeMap() 长度必须等于 getCurriculum().knowledgePoints.length'
    );

    const overlayIds = overlaySet.entries.map((e) => e.id);
    const merged = new Set(curriculum.knowledgePoints.map((k) => k.id));
    for (const id of overlayIds) {
      assert.ok(merged.has(id), `overlay 条目未合并进 curriculum：${id}`);
      assert.ok(map[id], `overlay 条目未进入 knowledgeMap：${id}`);
    }
  });

  test('合并后的知识点满足 curriculum 契约（无悬空前置、无自环）', () => {
    const curriculum = getCurriculum();
    const ids = new Set(curriculum.knowledgePoints.map((k) => k.id));
    const subjects = new Set(curriculum.subjects);
    for (const kp of curriculum.knowledgePoints) {
      assert.ok(ids.has(kp.id));
      assert.ok(subjects.has(kp.subject), `subject 非法：${kp.subject}`);
      for (const pre of kp.prerequisites) {
        assert.ok(ids.has(pre), `前置知识点不存在：${pre}`);
        assert.notEqual(pre, kp.id, '前置知识点不能自环');
      }
    }
  });
});

describe('workbuddy 题库增量资产', () => {
  test('题库文件存在且版本与主题库配套', () => {
    assert.ok(fs.existsSync(BANK_FILE), '题库增量文件应存在');
    assert.equal(
      workbuddyBank.version,
      'shanghai-junior-taxonomy-2026.02+questions'
    );
    assert.ok(workbuddyBank.questions.length > 0);
  });

  test('题目 id 唯一', () => {
    const seen = new Set<string>();
    for (const q of workbuddyBank.questions) {
      assert.ok(!seen.has(q.id), `题目 id 重复：${q.id}`);
      seen.add(q.id);
    }
  });

  test('题目字段齐备：stem/standardAnswer/solutionSteps/difficulty', () => {
    for (const q of workbuddyBank.questions) {
      assert.ok(q.stem.length > 0, `题目 ${q.id} 缺 stem`);
      assert.ok(q.standardAnswer.length > 0, `题目 ${q.id} 缺 standardAnswer`);
      assert.ok(
        q.solutionSteps.length > 0,
        `题目 ${q.id} 缺 solutionSteps`
      );
      assert.ok(
        q.difficulty >= 1 && q.difficulty <= 5,
        `题目 ${q.id} difficulty 越界`
      );
      assert.equal(q.region, '上海');
      assert.equal(q.subject, '英语');
    }
  });

  test('题目 knowledgeIds 非空且全部落在知识点集合里', () => {
    const curriculum = getCurriculum();
    const ids = new Set(curriculum.knowledgePoints.map((k) => k.id));
    for (const q of workbuddyBank.questions) {
      assert.ok(
        q.knowledgeIds.length > 0,
        `题目 ${q.id} 的 knowledgeIds 为空`
      );
      for (const kid of q.knowledgeIds) {
        assert.ok(ids.has(kid), `题目 ${q.id} 指向不存在的知识点：${kid}`);
      }
    }
  });

  test('题库合并生效：getQuestionBank() 收进了增量题目', () => {
    const bank = getQuestionBank();
    assert.ok(
      bank.questions.length > 11187,
      `合并后题量应大于 11187，实际 ${bank.questions.length}`
    );
    const ids = new Set(bank.questions.map((q) => q.id));
    for (const q of workbuddyBank.questions) {
      assert.ok(ids.has(q.id), `合并后缺少题目：${q.id}`);
    }
    // 合并后 id 依然唯一
    const seen = new Set<string>();
    for (const q of bank.questions) {
      assert.ok(!seen.has(q.id), `合并后题目 id 重复：${q.id}`);
      seen.add(q.id);
    }
  });
});
