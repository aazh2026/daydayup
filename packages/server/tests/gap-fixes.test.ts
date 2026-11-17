/**
 * 差距修复回归测试（对齐 docs/DESIGN_IMPLEMENTATION_GAP_ANALYSIS.md）。
 *
 * 覆盖此前「测试全绿」却依然存在的缺陷：
 *
 *   P0-1 诊断落库不更新服务端 MasteryRecord —— 诊断→提分闭环在服务端断开
 *   P0-2 ExamResult 无实体持久化 —— targetScore 恒等于 score
 *   P0-5 每日排期在 30/35 分钟档位超出预算
 *   P1-1 先修知识锁定漏判「未诊断」（前置知识点无 record）
 *   P1-3 LearningAttempt 运行时丢 questionStem/userAnswer/aiFeedback/taskId
 *
 * 这些用例的共同点：**都测的是规格文档写明的硬约束**，
 * 而不是「接口返回 200」这种弱断言。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';
import { buildSevenDayPlan, computePriorityOpportunities } from '../src/engines/planning-engine.ts';
import { evaluateMasteryTransition } from '../src/engines/mastery-engine.ts';
import { getCurriculum } from '../src/infrastructure/knowledge/curriculum.ts';
import { validateAgainstSchema } from '../src/infrastructure/ai/schema-validator.ts';
import { DIAGNOSIS_SCHEMA } from '../src/infrastructure/ai/schemas.ts';
import type {
  MasteryRecord,
  MasteryState,
  Student,
  Subject,
} from '@daydayup/contracts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;
let token: string;

const STUDENT_ID = 'stu-sh-zhangwei';

function auth() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: auth() });
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// 纯引擎部分（P0-5 / P1-1）—— 不需要 HTTP
// ---------------------------------------------------------------------------

const baseStudent: Student = {
  id: 'stu-x',
  name: '测试',
  grade: '初三',
  region: '上海',
  targetExamDate: '2026-06-20',
  targetSchool: '目标校',
  dailyBudgetMinutes: 60,
  homeworkLoad: '适中',
  fatigueLevel: '低',
};

/** 构造「全部知识点都有待学习记录」的掌握度快照 */
function allPendingMastery(): Record<string, MasteryRecord> {
  const recs: Record<string, MasteryRecord> = {};
  const now = new Date().toISOString();
  for (const kp of getCurriculum().knowledgePoints) {
    recs[kp.id] = {
      knowledgeId: kp.id,
      state: '待学习',
      confidence: '较可能',
      lostScoreEvidence: 8,
      recoveryProbability: 0.5,
      evidenceLogs: [],
      consecutiveErrors: 0,
      practiceCorrect: 0,
      practiceTotal: 0,
      variantPassed: false,
      delayedRetestPassed: false,
      updatedAt: now,
    };
  }
  return recs;
}

describe('P0-5 每日排期不得超出调节后预算', () => {
  test('30–120 分钟全档位：每日总时长 ≤ 有效预算，且每天 ≤ 3 项任务', () => {
    const mastery = allPendingMastery();
    const violations: string[] = [];

    for (let budget = 30; budget <= 120; budget += 5) {
      const plan = buildSevenDayPlan({
        student: { ...baseStudent, dailyBudgetMinutes: budget },
        masteryRecords: mastery,
        now: Date.UTC(2026, 0, 1),
      });

      for (const day of plan.days) {
        if (day.totalMinutes > plan.effectiveDailyBudget) {
          violations.push(
            `预算 ${budget} 分钟：第 ${day.dayIndex} 天排期 ${day.totalMinutes} 分钟 > 有效预算 ${plan.effectiveDailyBudget}`
          );
        }
        if (day.tasks.length > 3) {
          violations.push(
            `预算 ${budget} 分钟：第 ${day.dayIndex} 天任务数 ${day.tasks.length} > 3`
          );
        }
        // 任务时长之和必须与当日合计一致（分配逻辑自洽）
        const sum = day.tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
        if (sum !== day.totalMinutes) {
          violations.push(
            `预算 ${budget} 分钟：第 ${day.dayIndex} 天任务时长之和 ${sum} ≠ 合计 ${day.totalMinutes}`
          );
        }
      }
    }

    assert.deepEqual(violations, [], `存在预算超支：\n${violations.join('\n')}`);
  });

  test('边界档位 30 分钟：7 天全部不超支（此前 7/7 天超支）', () => {
    const plan = buildSevenDayPlan({
      student: { ...baseStudent, dailyBudgetMinutes: 30 },
      masteryRecords: allPendingMastery(),
      now: Date.UTC(2026, 0, 1),
    });

    assert.equal(plan.effectiveDailyBudget, 30);
    for (const day of plan.days) {
      assert.ok(
        day.totalMinutes <= plan.effectiveDailyBudget,
        `第 ${day.dayIndex} 天排期 ${day.totalMinutes} 分钟超出预算 30 分钟`
      );
    }
  });
});

describe('P1-1 先修知识锁定必须覆盖「未诊断」', () => {
  test('前置知识点无 MasteryRecord（= 未诊断）时，依赖它的知识点被降权锁定', () => {
    const now = new Date().toISOString();
    // 只有 math-eq-ineq 有记录；它的前置 math-alg-rational **没有**记录
    const records: Record<string, MasteryRecord> = {
      'math-eq-ineq': {
        knowledgeId: 'math-eq-ineq',
        state: '待学习',
        confidence: '较可能',
        lostScoreEvidence: 8,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: now,
      },
    };

    const opportunities = computePriorityOpportunities(
      records,
      Date.UTC(2026, 0, 1)
    );
    const eq = opportunities.find((o) => o.knowledgeId === 'math-eq-ineq');

    assert.ok(eq, '应产出 math-eq-ineq 的提分机会');
    assert.ok(
      eq!.blockedByPrerequisite,
      '前置知识点无记录（未诊断）时必须被锁定，而不是因 `preRec &&` 短路而跳过'
    );
    assert.equal(eq!.priorityTier, '低', '被锁定后优先级档位应降为「低」');
    assert.ok(
      eq!.rationale.includes('需先固牢前置知识'),
      '理由中应引导先修基础内容'
    );
  });

  test('前置知识点状态为「待学习」时同样被锁定', () => {
    const now = new Date().toISOString();
    const records: Record<string, MasteryRecord> = {
      'math-eq-ineq': {
        knowledgeId: 'math-eq-ineq',
        state: '待学习',
        confidence: '较可能',
        lostScoreEvidence: 8,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: now,
      },
      'math-alg-rational': {
        knowledgeId: 'math-alg-rational',
        state: '待学习',
        confidence: '较可能',
        lostScoreEvidence: 6,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: now,
      },
    };

    const opportunities = computePriorityOpportunities(
      records,
      Date.UTC(2026, 0, 1)
    );
    const eq = opportunities.find((o) => o.knowledgeId === 'math-eq-ineq');
    assert.ok(eq?.blockedByPrerequisite, '「待学习」的前置同样应触发锁定');
  });

  test('前置知识点已掌握时不锁定', () => {
    const now = new Date().toISOString();
    const records: Record<string, MasteryRecord> = {
      'math-eq-ineq': {
        knowledgeId: 'math-eq-ineq',
        state: '待学习',
        confidence: '较可能',
        lostScoreEvidence: 8,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: now,
      },
      'math-alg-rational': {
        knowledgeId: 'math-alg-rational',
        state: '掌握',
        confidence: '确定',
        lostScoreEvidence: 1,
        recoveryProbability: 0.9,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 3,
        practiceTotal: 3,
        variantPassed: true,
        delayedRetestPassed: false,
        updatedAt: now,
      },
    };

    const opportunities = computePriorityOpportunities(
      records,
      Date.UTC(2026, 0, 1)
    );
    const eq = opportunities.find((o) => o.knowledgeId === 'math-eq-ineq');
    assert.equal(
      eq?.blockedByPrerequisite,
      undefined,
      '前置已掌握时不应锁定'
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP 部分（P0-1 / P0-2 / P1-3）
// ---------------------------------------------------------------------------

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-gap-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'gap-test-secret';
  process.env.GEMINI_API_KEY = '';

  container = createContainer();

  // 创建学生档案
  await container.db.write(['db', 'students', `${STUDENT_ID}.json`], {
    ...baseStudent,
    id: STUDENT_ID,
  });

  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: '1234' }),
  });
  token = ((await loginRes.json()) as { token: string }).token;
  assert.ok(token, '应取得令牌');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('P0-1 诊断落库必须更新服务端 MasteryRecord', () => {
  test('诊断失分写入 MasteryRecord 并产生掌握轨迹', async () => {
    const examId = 'exam-gap-1';

    const post = await fetch(`${baseUrl}/api/v1/exams/${examId}/papers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        studentId: STUDENT_ID,
        id: 'paper-gap-1',
        examTitle: '差距修复测试卷',
        subject: '数学',
        title: '差距修复测试卷',
        date: '2026-11-17',
        score: 70,
        fullScore: 100,
        status: '已识别',
        totalLostScore: 6,
        questionsCount: 2,
        summary: '测试',
        knowledgeIds: ['math-func-linear'],
        diagnosedItems: [
          {
            questionNumber: '10',
            stem: '求函数交点',
            studentAnswer: '漏解',
            correctAnswer: '(-1,2)',
            scoreLost: 4,
            knowledgeId: 'math-func-linear',
            errorType: '方法问题',
            aiAnalysis: '未分类讨论',
            evidence: '第10题',
            confidence: '确定',
            verificationMethod: '复做变式题',
          },
          {
            questionNumber: '14',
            stem: '化简分式',
            studentAnswer: 'x=2',
            correctAnswer: 'x=-2',
            scoreLost: 2,
            knowledgeId: 'math-alg-rational',
            errorType: '知识问题',
            aiAnalysis: '未检验分母',
            evidence: '第14题',
            confidence: '待验证',
            verificationMethod: '基础题微测',
          },
        ],
      }),
    });
    assert.equal(post.status, 200);

    // 服务端掌握度必须已更新
    const mastery = await getJson<{
      records: Record<string, MasteryRecord>;
    }>(`/api/v1/students/${STUDENT_ID}/mastery`);

    const kp = mastery.records['math-func-linear'];
    assert.ok(
      kp,
      '诊断涉及的知识点必须在服务端掌握度聚合里出现（此前完全没有）'
    );
    assert.equal(kp!.state, '待学习', '诊断失分后状态应为「待学习」');
    assert.ok(
      kp!.lostScoreEvidence > 0,
      '失分证据必须累加到 lostScoreEvidence'
    );
    assert.ok(
      kp!.evidenceLogs.length > 0,
      '证据摘要必须写入 evidenceLogs'
    );

    // 掌握轨迹必须产生迁移事件
    const history = await getJson<{ history: Array<{ knowledgeId: string }> }>(
      `/api/v1/students/${STUDENT_ID}/mastery/history`
    );
    assert.ok(
      history.history.length > 0,
      '诊断必须产生掌握度迁移事件（否则报告页「掌握轨迹」为空）'
    );
    assert.ok(
      history.history.some((e) => e.knowledgeId === 'math-func-linear'),
      '迁移事件应包含诊断涉及的知识点'
    );

    // 置信度取诊断结论的值，而不是硬编码
    assert.equal(kp!.confidence, '确定');
  });

  test('诊断失分使服务端 7 天排序看到失分证据（闭环打通）', async () => {
    const opps = await getJson<{
      opportunities: Array<{
        knowledgeId: string;
        lostScore: number;
      }>;
    }>(`/api/v1/students/${STUDENT_ID}/opportunities`);

    const kp = opps.opportunities.find(
      (o) => o.knowledgeId === 'math-func-linear'
    );
    assert.ok(
      kp,
      '诊断产生的失分证据必须进入提分机会（此前服务端完全看不到）'
    );
    assert.ok(kp!.lostScore > 0, 'lostScore 必须反映诊断失分');
  });

  test('同一知识点多条失分被聚合为一次状态迁移（状态不跳变）', async () => {
    const studentId = STUDENT_ID;
    await container.db.write(['db', 'students', `${studentId}.json`], {
      ...baseStudent,
      id: studentId,
    });

    /**
     * 用与上一个用例**不同**的知识点，避免测试间互相干扰
     * （所有用例共用同一个演示学生，因为令牌只授权了这一个 studentId）。
     */
    const AGG_KP = 'math-geo-triangle';

    const post = await fetch(
      `${baseUrl}/api/v1/exams/exam-gap-agg/papers`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          studentId,
          id: 'paper-gap-agg',
          examTitle: '同知识点多条失分',
          subject: '数学',
          title: '同知识点多条失分',
          date: '2026-11-17',
          status: '已识别',
          totalLostScore: 9,
          questionsCount: 2,
          diagnosedItems: [
            {
              questionNumber: '1',
              stem: '题1',
              studentAnswer: 'a',
              correctAnswer: 'b',
              scoreLost: 4,
              knowledgeId: AGG_KP,
              errorType: '方法问题',
              aiAnalysis: 'x',
              evidence: '第1题',
              confidence: '确定',
              verificationMethod: 'v',
            },
            {
              questionNumber: '2',
              stem: '题2',
              studentAnswer: 'c',
              correctAnswer: 'd',
              scoreLost: 5,
              knowledgeId: AGG_KP,
              errorType: '计算问题',
              aiAnalysis: 'y',
              evidence: '第2题',
              confidence: '较可能',
              verificationMethod: 'v',
            },
          ],
        }),
      }
    );
    assert.equal(post.status, 200);

    const mastery = await getJson<{
      records: Record<string, MasteryRecord>;
    }>(`/api/v1/students/${studentId}/mastery`);
    const kp = mastery.records[AGG_KP];
    assert.ok(kp, '应产生掌握度记录');

    // 两条失分应合并为一次迁移（不是两次）
    const history = await getJson<{ history: Array<{ knowledgeId: string }> }>(
      `/api/v1/students/${studentId}/mastery/history`
    );
    const events = history.history.filter(
      (e) => e.knowledgeId === AGG_KP
    );
    assert.ok(
      events.length <= 1,
      `同一知识点在一次诊断里只应产生一次状态迁移，实际 ${events.length} 次`
    );
    // 两条失分的证据应合并进 evidenceLogs
    assert.ok(
      kp!.evidenceLogs.length >= 1,
      '失分证据应写入 evidenceLogs'
    );
  });
});

describe('P1-3 LearningAttempt 必须完整落库', () => {
  test('作答流水保留题干、学生作答与 AI 反馈', async () => {
    const studentId = STUDENT_ID;
    await container.db.write(['db', 'students', `${studentId}.json`], {
      ...baseStudent,
      id: studentId,
    });

    const post = await fetch(
      `${baseUrl}/api/v1/students/${studentId}/mastery/math-func-linear/attempt`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          mode: '变式训练',
          isCorrect: true,
          evidenceSummary: '变式题独立做对',
          subject: '数学',
          hintsUsed: 1,
          timeSpentSeconds: 120,
          independent: true,
          taskId: 'task-d0-math-func-linear',
          questionStem: '求函数交点坐标',
          userAnswer: '(-1,2)',
          aiFeedback: '分类讨论完整，继续保持',
        }),
      }
    );
    assert.equal(post.status, 200);

    const attempts = await getJson<{
      attempts: Array<Record<string, unknown>>;
    }>(`/api/v1/students/${studentId}/attempts`);

    assert.ok(attempts.attempts.length > 0, '应产生作答流水');
    const attempt = attempts.attempts[0];

    assert.equal(
      attempt.questionStem,
      '求函数交点坐标',
      '题干必须落库（此前完全丢失）'
    );
    assert.equal(
      attempt.userAnswer,
      '(-1,2)',
      '学生作答必须落库（此前完全丢失）'
    );
    assert.equal(
      attempt.aiFeedback,
      '分类讨论完整，继续保持',
      'AI 反馈必须落库（此前完全丢失）'
    );
    assert.equal(
      attempt.taskId,
      'task-d0-math-func-linear',
      '任务 ID 必须落库（此前完全丢失）'
    );
  });
});

describe('P0-2 ExamResult 必须可持久化且目标分独立', () => {
  test('目标分不再等于实际分（目标分差值有意义）', async () => {
    const studentId = STUDENT_ID;
    await container.db.write(['db', 'students', `${studentId}.json`], {
      ...baseStudent,
      id: studentId,
    });

    // 建立考试场次
    const examRes = await fetch(`${baseUrl}/api/v1/exams`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        id: 'exam-gap-result',
        title: '差距修复场次',
        type: '月考',
        date: '2026-11-17',
        studentId,
      }),
    });
    assert.equal(examRes.status, 200);

    // 录入成绩（含独立的目标分）
    const resultRes = await fetch(
      `${baseUrl}/api/v1/students/${studentId}/exam-results`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          studentId,
          examId: 'exam-gap-result',
          examTitle: '差距修复场次',
          subject: '数学',
          score: 70,
          fullScore: 100,
          targetScore: 90,
          date: '2026-11-17',
        }),
      }
    );
    assert.equal(resultRes.status, 200);

    // 读取时目标分必须仍然是 90，而不是被抄成 70
    const results = await getJson<{
      results: Array<{ targetScore: number; score: number }>;
    }>(`/api/v1/students/${studentId}/exam-results`);

    const record = results.results.find((r) => r.score === 70);
    assert.ok(record, '应能读回录入的成绩');
    assert.equal(
      record!.targetScore,
      90,
      '目标分必须独立存储，不能被抄成实际分（否则「距离目标分差值」恒为 0）'
    );
  });
});

describe('P1-2 诊断输出必须通过 schema 校验且受控词表受约束', () => {
  test('schema 校验拒绝缺少四结构化字段的诊断结果', () => {
    /**
     * 规格 §模块01 §2：每条诊断结论必须附带四个结构化字段
     * （证据 / 判断 / 置信度 / 验证方式）；
     * §7.1：「证据与置信度完整率 100%」。
     *
     * 此前多模态路径直接 JSON.parse 就返回，完全跳过校验。
     */
    const incomplete = {
      detectedMetadata: {
        subject: '数学',
        examTitle: 'x',
        examType: '月考',
        examDate: '2026-11-17',
        score: 70,
        fullScore: 100,
        metadataConfidence: '确定',
      },
      paperSummary: 's',
      questionsDetectedCount: 1,
      totalLostScore: 2,
      diagnosedItems: [
        {
          questionNumber: '1',
          stem: '题',
          studentAnswer: 'a',
          correctAnswer: 'b',
          scoreLost: 2,
          knowledgeId: 'math-func-linear',
          errorType: '方法问题',
          aiAnalysis: 'x',
          // 故意缺 evidence / confidence / verificationMethod
        },
      ],
    };

    assert.equal(
      validateAgainstSchema(incomplete, DIAGNOSIS_SCHEMA),
      false,
      '缺少证据/置信度/验证方式的诊断结果必须被拒绝'
    );
  });

  test('schema 校验接受完整的诊断结果', () => {
    const complete = {
      detectedMetadata: {
        subject: '数学',
        examTitle: 'x',
        examType: '月考',
        examDate: '2026-11-17',
        score: 70,
        fullScore: 100,
        metadataConfidence: '确定',
      },
      paperSummary: 's',
      questionsDetectedCount: 1,
      totalLostScore: 2,
      diagnosedItems: [
        {
          questionNumber: '1',
          stem: '题',
          studentAnswer: 'a',
          correctAnswer: 'b',
          scoreLost: 2,
          knowledgeId: 'math-func-linear',
          errorType: '方法问题',
          aiAnalysis: 'x',
          evidence: '第1题',
          confidence: '确定',
          verificationMethod: '复做变式题',
        },
      ],
    };

    assert.equal(
      validateAgainstSchema(complete, DIAGNOSIS_SCHEMA),
      true,
      '完整的诊断结果必须通过校验'
    );
  });

  test('受控词表：五维错因与置信度必须在枚举内', () => {
    const base = {
      detectedMetadata: {
        subject: '数学',
        examTitle: 'x',
        examType: '月考',
        examDate: '2026-11-17',
        score: 70,
        fullScore: 100,
        metadataConfidence: '确定',
      },
      paperSummary: 's',
      questionsDetectedCount: 1,
      totalLostScore: 2,
      diagnosedItems: [
        {
          questionNumber: '1',
          stem: '题',
          studentAnswer: 'a',
          correctAnswer: 'b',
          scoreLost: 2,
          knowledgeId: 'math-func-linear',
          errorType: '方法问题',
          aiAnalysis: 'x',
          evidence: '第1题',
          confidence: '确定',
          verificationMethod: 'v',
        },
      ],
    };

    // 规格外的错因必须被拒
    const badErrorType = structuredClone(base) as typeof base;
    badErrorType.diagnosedItems[0].errorType = '粗心大意';
    assert.equal(
      validateAgainstSchema(badErrorType, DIAGNOSIS_SCHEMA),
      false,
      '规格外的五维错因必须被拒绝'
    );

    // 规格外的置信度必须被拒
    const badConfidence = structuredClone(base) as typeof base;
    badConfidence.diagnosedItems[0].confidence = '非常确定';
    assert.equal(
      validateAgainstSchema(badConfidence, DIAGNOSIS_SCHEMA),
      false,
      '规格外的置信度必须被拒绝'
    );
  });

  test('诊断落库时受控词表被归一化（前端传任意字符串也不污染数据）', async () => {
    const studentId = STUDENT_ID;
    await container.db.write(['db', 'students', `${studentId}.json`], {
      ...baseStudent,
      id: studentId,
    });

    const post = await fetch(`${baseUrl}/api/v1/exams/exam-gap-norm/papers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        studentId,
        id: 'paper-gap-norm',
        examTitle: '归一化测试卷',
        subject: '数学',
        title: '归一化测试卷',
        date: '2026-11-17',
        status: '已识别',
        totalLostScore: 3,
        questionsCount: 1,
        diagnosedItems: [
          {
            questionNumber: '1',
            stem: '题',
            studentAnswer: 'a',
            correctAnswer: 'b',
            scoreLost: 3,
            knowledgeId: 'math-stat-prob',
            errorType: '粗心大意',
            aiAnalysis: 'x',
            evidence: '第1题',
            confidence: '非常确定',
            verificationMethod: 'v',
          },
        ],
      }),
    });
    assert.equal(post.status, 200);

    const errors = await getJson<{
      records: Array<{ errorType: string; confidence: string }>;
    }>(`/api/v1/students/${studentId}/error-records`);

    const record = errors.records.find((r) =>
      r.errorType === '知识问题' && r.confidence === '待验证'
    );
    assert.ok(
      record,
      '规格外的错因/置信度必须被归一化为合法枚举（不得落库为原值）'
    );
  });
});

describe('P1-6 置信度必须按证据强度分级', () => {
  test('作答错误 → 置信度回落到「待验证」', () => {
    const result = evaluateMasteryTransition({
      current: {
        knowledgeId: 'k',
        state: '初步掌握',
        confidence: '确定',
        lostScoreEvidence: 5,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 1,
        practiceTotal: 1,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: new Date().toISOString(),
      },
      mode: '基础练习',
      isCorrect: false,
      evidenceSummary: '作答错误',
    });

    assert.equal(
      result.record.confidence,
      '待验证',
      '作答错误意味着假设未被证实，置信度不应是「确定」'
    );
  });

  test('答对但用了提示 → 置信度为「较可能」', () => {
    const result = evaluateMasteryTransition({
      current: {
        knowledgeId: 'k',
        state: '学习中',
        confidence: '待验证',
        lostScoreEvidence: 5,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: new Date().toISOString(),
      },
      mode: '基础练习',
      isCorrect: true,
      hintsUsed: 2,
      evidenceSummary: '有提示作答正确',
    });

    assert.equal(
      result.record.confidence,
      '较可能',
      '有提示的答对不足以独立确认掌握，置信度应为「较可能」'
    );
  });

  test('完全独立答对 → 置信度为「确定」', () => {
    const result = evaluateMasteryTransition({
      current: {
        knowledgeId: 'k',
        state: '学习中',
        confidence: '待验证',
        lostScoreEvidence: 5,
        recoveryProbability: 0.5,
        evidenceLogs: [],
        consecutiveErrors: 0,
        practiceCorrect: 0,
        practiceTotal: 0,
        variantPassed: false,
        delayedRetestPassed: false,
        updatedAt: new Date().toISOString(),
      },
      mode: '基础练习',
      isCorrect: true,
      hintsUsed: 0,
      evidenceSummary: '独立作答正确',
    });

    assert.equal(
      result.record.confidence,
      '确定',
      '无提示独立答对应确认为「确定」'
    );
  });
});

describe('P1-7 错题状态白名单由服务端强制', () => {
  test('规格外的错题状态被拒绝', async () => {
    const studentId = STUDENT_ID;
    await container.db.write(['db', 'students', `${studentId}.json`], {
      ...baseStudent,
      id: studentId,
    });

    // 先产生一条错题
    await fetch(`${baseUrl}/api/v1/exams/exam-gap-status/papers`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        studentId,
        id: 'paper-gap-status',
        examTitle: '状态白名单测试卷',
        subject: '数学',
        title: '状态白名单测试卷',
        date: '2026-11-17',
        status: '已识别',
        totalLostScore: 2,
        questionsCount: 1,
        diagnosedItems: [
          {
            questionNumber: '1',
            stem: '题',
            studentAnswer: 'a',
            correctAnswer: 'b',
            scoreLost: 2,
            knowledgeId: 'math-geo-triangle',
            errorType: '知识问题',
            aiAnalysis: 'x',
            evidence: '第1题',
            confidence: '确定',
            verificationMethod: 'v',
          },
        ],
      }),
    });

    const errors = await getJson<{ records: Array<{ id: string }> }>(
      `/api/v1/students/${studentId}/error-records`
    );
    const record = errors.records.find(
      (r) => r.id.startsWith('err-') && !r.id.includes('gap-status')
    );
    assert.ok(record, '应有可更新的错题记录');

    const bad = await fetch(
      `${baseUrl}/api/v1/error-records/${studentId}/${record!.id}`,
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ status: '随便写的状态' }),
      }
    );
    assert.equal(bad.status, 400, '规格外的错题状态必须被服务端拒绝');

    const good = await fetch(
      `${baseUrl}/api/v1/error-records/${studentId}/${record!.id}`,
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ status: '待复测', correctionNote: '订正心得' }),
      }
    );
    assert.equal(good.status, 200, '「待复测」是合法状态，必须能写入');
  });
});
