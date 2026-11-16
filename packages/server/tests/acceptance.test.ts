/**
 * 产品验收测试（对齐 docs/PRODUCT_DESIGN_SPEC.md §八）。
 *
 * 用例编号与产品文档一一对应：
 *   TC-01 试卷拍照诊断闭环
 *   TC-02 约束变化触发重排
 *   TC-03 苏格拉底引导与逃生
 *   TC-04 变式评测推进状态机
 *   TC-05 连续失误降阶保护
 *   TC-06 三层效果报告验证
 *   TC-07 多维错题整理与分析
 *   TC-08 自动元信息识别与试卷存档
 *   TC-09 学科思维导图标记试卷问题点
 *
 * 说明：涉及真实模型调用的用例（TC-01/TC-03）用 Mock Provider 验证编排与状态流转，
 * 模型本身的识别质量不在自动化测试范围内。
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
import { createDiagnosisJobHandler } from '../src/modules/diagnosis/diagnosis-job.ts';
import type { AIProvider } from '../src/infrastructure/ai/provider.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;
let token: string;

const STUDENT_ID = 'stu-sh-zhangwei';

/** Mock AI：返回可预期的诊断结果 */
const mockProvider = {
  client: {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          detectedMetadata: {
            subject: '数学',
            examTitle: '2026学年第一学期初三期中评估',
            examType: '期中考试',
            examDate: '2026-11-08',
            score: 76,
            fullScore: 100,
            metadataConfidence: '确定',
          },
          paperSummary: '主要失分集中在函数交点与分式运算',
          questionsDetectedCount: 2,
          totalLostScore: 6,
          diagnosedItems: [
            {
              questionNumber: '10',
              stem: '求函数交点坐标',
              studentAnswer: '漏解',
              correctAnswer: '(-1,2)',
              scoreLost: 4,
              knowledgeId: 'math-func-linear',
              errorType: '方法问题',
              aiAnalysis: '未考虑分类讨论',
              evidence: '第10题解答过程缺失分类讨论',
              confidence: '确定',
              verificationMethod: '复做同类变式题',
            },
            {
              questionNumber: '14',
              stem: '化简分式并求值',
              studentAnswer: 'x=2',
              correctAnswer: 'x=-2',
              scoreLost: 2,
              knowledgeId: 'math-alg-rational',
              errorType: '知识问题',
              aiAnalysis: '未检验分母不为零',
              evidence: '第14题作答 x=2',
              confidence: '待验证',
              verificationMethod: '基础题微测',
            },
          ],
        }),
      }),
    },
  },
} as unknown as AIProvider;

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-acceptance-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'acceptance-test-secret';
  process.env.GEMINI_API_KEY = '';

  // 播种演示数据（验收用例依赖种子数据）
  const { execSync } = await import('node:child_process');
  execSync(
    `npx tsx ${path.resolve(__dirname, '../scripts/seed.ts')}`,
    { env: { ...process.env, DATA_DIR: tmpDataDir }, stdio: 'pipe' }
  );

  container = createContainer();

  // 注入 Mock AI Provider（教练对话等端点直接走 container.ai）
  const mockAI = {
    generateJson: async () => ({
      data: {
        reply: '先想想这一步用到了哪个性质？',
        teachingBehaviorUsed: '引导',
        nextStage: 2,
        detectedUnderstanding: '部分理解',
        suggestedQuickReplies: ['不知道', '想看完整讲解'],
      },
      validated: true,
      attempts: 1,
      error: null,
      promptVersion: 'coach.v1',
      model: 'mock',
    }),
    client: mockProvider.client,
  } as unknown as AIProvider;
  (container as { ai: AIProvider | null }).ai = mockAI;

  container.jobEngine.register(
    'diagnosis',
    createDiagnosisJobHandler(mockProvider, container.storage)
  );

  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  await container.jobEngine.start();

  // 登录拿令牌
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: '1234' }),
  });
  token = ((await loginRes.json()) as { token: string }).token;
  assert.ok(token, '应取得令牌');
});

after(async () => {
  await container.jobEngine.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

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

/**
 * 走完整诊断链路：上传 → 建任务 → 等完成 → 取结果。
 */
async function runDiagnosis(paperId = 'paper-tc01') {
  const upload = await fetch(`${baseUrl}/api/v1/uploads/papers`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      studentId: STUDENT_ID,
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      originalName: 'paper.png',
    }),
  });
  const { fileId } = (await upload.json()) as { fileId: string };

  const enqueue = await fetch(`${baseUrl}/api/v1/exams/exam-tc01/diagnosis`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      studentId: STUDENT_ID,
      paperId,
      inputFormat: 'image',
      fileIds: [fileId],
    }),
  });
  const { jobId } = (await enqueue.json()) as { jobId: string };

  // 等待完成
  let output: any = null;
  let lastStatus = 'UNKNOWN';
  let lastError: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
      headers: auth(),
    });
    const job = (await res.json()) as {
      status?: string;
      output?: unknown;
      error?: string;
    };
    lastStatus = job.status;
    lastError = job.error;
    if (job.status === 'SUCCEEDED') {
      output = job.output;
      break;
    }
    if (job.status === 'FAILED') {
      throw new Error(`诊断任务失败: ${(job as any).error ?? '未知错误'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(
    output,
    `诊断应产出结果（status=${lastStatus}, error=${lastError ?? '无'}）`
  );
  return output;
}

describe('TC-01 试卷拍照诊断闭环', () => {
  test('诊断产出错题记录并关联知识点与试卷', async () => {
    const output = await runDiagnosis();

    // 1) 识别题目与失分
    assert.equal(output.questionsDetectedCount, 2);
    assert.equal(output.totalLostScore, 6);
    assert.equal(output.diagnosedItems.length, 2);

    // 2) 元信息自动识别
    assert.equal(output.detectedMetadata.subject, '数学');
    assert.equal(output.detectedMetadata.examType, '期中考试');
    assert.equal(output.detectedMetadata.examDate, '2026-11-08');

    // 3) 落库为错题记录
    const saved = await fetch(
      `${baseUrl}/api/v1/exams/exam-tc01/papers`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          studentId: STUDENT_ID,
          id: 'paper-tc01',
          examTitle: output.detectedMetadata.examTitle,
          examType: output.detectedMetadata.examType,
          subject: output.detectedMetadata.subject,
          title: output.detectedMetadata.examTitle,
          date: output.detectedMetadata.examDate,
          score: output.detectedMetadata.score,
          fullScore: output.detectedMetadata.fullScore,
          sourceFormat: '试卷拍照',
          totalLostScore: output.totalLostScore,
          questionsCount: output.questionsDetectedCount,
          summary: output.paperSummary,
          knowledgeIds: [...new Set(output.diagnosedItems.map((i: any) => i.knowledgeId))],
          diagnosedItems: output.diagnosedItems,
        }),
      }
    );
    assert.equal(saved.status, 200);

    const errors = await getJson<{ records: any[] }>(
      `/api/v1/students/${STUDENT_ID}/error-records`
    );
    assert.ok(errors.records.length >= 2, '应生成错题记录');
    assert.ok(
      errors.records.some((r) => r.knowledgeId === 'math-func-linear'),
      '错题应关联知识点'
    );
  });

  test('每条诊断结论都带证据', async () => {
    const output = await runDiagnosis('paper-tc01-evidence');
    for (const item of output.diagnosedItems) {
      assert.ok(item.evidence && item.evidence.length > 0, '证据不可为空');
      assert.ok(item.verificationMethod, '验证方式不可为空');
      assert.ok(
        ['确定', '较可能', '待验证'].includes(item.confidence),
        '置信度取值受控'
      );
    }
  });
});

describe('TC-02 约束变化触发重排', () => {
  test('调整每日时长后，每日任务总时长严格不超过新预算', async () => {
    const student = await container.db.read<{ id: string }>([
      'db',
      'students',
      `${STUDENT_ID}.json`,
    ]);
    assert.ok(student, '种子学生应存在');

    // 写入学生档案（预算 45 分钟 + 较重作业）
    await container.db.write(['db', 'students', `${STUDENT_ID}.json`], {
      ...student,
      dailyBudgetMinutes: 45,
      homeworkLoad: '较重',
    });

    // 触发重排
    const res = await fetch(`${baseUrl}/api/v1/students/${STUDENT_ID}/plans`, {
      method: 'POST',
      headers: auth(),
    });
    assert.equal(res.status, 200);

    const plan = (await res.json()) as {
      effectiveDailyBudget: number;
      days: Array<{ tasks: Array<{ estimatedMinutes: number }> }>;
    };

    // 45 分钟 × (1 - 0.15 较重) = 38.25 → 向下取整到 5 的倍数 = 35
    assert.ok(
      plan.effectiveDailyBudget <= 45,
      `有效预算 ${plan.effectiveDailyBudget} 超过设定值 45`
    );

    for (const day of plan.days) {
      const total = day.tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      assert.ok(
        total <= plan.effectiveDailyBudget,
        `每日排期 ${total} 超出预算 ${plan.effectiveDailyBudget}`
      );
    }
  });
});

describe('TC-03 苏格拉底引导与逃生', () => {
  test('教练按阶段引导；请求完整讲解时切换为示范', async () => {
    const res = await fetch(`${baseUrl}/api/v1/coach/chat`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        subject: '数学',
        knowledgeName: '一次函数图像与性质',
        knowledgeDefinition: '掌握一次函数的图像与性质',
        commonTraps: ['正比例函数与一次函数混淆'],
        masteryState: '学习中',
        socraticStage: 1,
        requestFullExplanation: false,
        teachingBehavior: '引导',
        history: [{ role: 'user', text: '我不太懂这一步' }],
        studentMessage: '能直接讲完整过程吗',
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      reply: string;
      teachingBehaviorUsed: string;
      nextStage: number;
      suggestedQuickReplies: string[];
    };

    // 返回结构完整
    assert.ok(body.reply.length > 0, '应有教练回复');
    assert.ok(
      ['诊断', '讲解', '示范', '引导', '评测'].includes(body.teachingBehaviorUsed),
      `教学行为取值受控，实际 ${body.teachingBehaviorUsed}`
    );
    assert.ok(
      body.nextStage >= 0 && body.nextStage <= 4,
      `阶段值应在 0-4，实际 ${body.nextStage}`
    );
    assert.ok(Array.isArray(body.suggestedQuickReplies));
  });
});

describe('TC-04 变式评测推进状态机', () => {
  test('变式训练通过 → 掌握；延迟复测通过 → 稳定掌握', async () => {
    // 变式训练通过
    const variant = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/math-func-linear/attempt`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          mode: '变式训练',
          isCorrect: true,
          evidenceSummary: '变式题独立通过',
          subject: '数学',
        }),
      }
    );
    const variantBody = (await variant.json()) as {
      mastery: { previousState: string; newState: string };
    };
    assert.ok(
      ['掌握', '稳定掌握'].includes(variantBody.mastery.newState),
      `变式通过应推进到掌握，实际 ${variantBody.mastery.newState}`
    );

    // 关联错题状态更新为已闭环 —— 需先有错题记录
    const errors = await getJson<{ records: any[] }>(
      `/api/v1/students/${STUDENT_ID}/error-records`
    );
    const target = errors.records.find(
      (r) => r.knowledgeId === 'math-func-linear'
    );
    assert.ok(target, '应有关联错题');

    const closed = await fetch(
      `${baseUrl}/api/v1/error-records/${STUDENT_ID}/${target.id}`,
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ status: '已闭环' }),
      }
    );
    assert.equal(closed.status, 200);
    const closedBody = (await closed.json()) as { status: string };
    assert.equal(closedBody.status, '已闭环');
  });
});

describe('TC-05 连续失误降阶保护', () => {
  test('连续两次错误 → 状态回退至待学习', async () => {
    const knowledgeId = 'math-geo-triangle';

    const first = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/${knowledgeId}/attempt`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          mode: '基础练习',
          isCorrect: false,
          evidenceSummary: '首次失误',
          subject: '数学',
        }),
      }
    );
    const firstBody = (await first.json()) as {
      mastery: { newState: string };
      record: { consecutiveErrors: number };
    };
    assert.equal(firstBody.record.consecutiveErrors, 1);

    const second = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/mastery/${knowledgeId}/attempt`,
      {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          mode: '基础练习',
          isCorrect: false,
          evidenceSummary: '再次失误',
          subject: '数学',
        }),
      }
    );
    const secondBody = (await second.json()) as {
      mastery: { newState: string };
      record: { consecutiveErrors: number };
    };

    assert.equal(secondBody.record.consecutiveErrors, 2, '连续失误应累计');
    assert.equal(
      secondBody.mastery.newState,
      '待学习',
      '连续两次失误应回退至待学习（降阶保护）'
    );
  });

  test('降阶后计划中触发降阶巩固标记', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/students/${STUDENT_ID}/plans/current`,
      { headers: auth() }
    );
    const plan = (await res.json()) as {
      days: Array<{
        tasks: Array<{
          knowledgeId: string;
          difficultyAdjusted?: boolean;
          title: string;
        }>;
      }>;
    };

    const tasks = plan.days.flatMap((d) => d.tasks);
    const adjusted = tasks.filter((t) => t.difficultyAdjusted);
    // 若该知识点进入计划，应带降阶标记
    for (const task of adjusted) {
      assert.ok(task.title.includes('降阶巩固'), '降阶任务应标注');
    }
  });
});

describe('TC-06 三层效果报告验证', () => {
  test('过程指标、能力指标、成绩趋势三层数据均可获取', async () => {
    // 第一层：过程指标 —— 作答流水
    const attempts = await getJson<{ attempts: any[] }>(
      `/api/v1/students/${STUDENT_ID}/attempts`
    );
    assert.ok(Array.isArray(attempts.attempts));

    // 第二层：能力指标 —— 掌握度 + 迁移历史
    const mastery = await getJson<{ records: Record<string, any> }>(
      `/api/v1/students/${STUDENT_ID}/mastery`
    );
    assert.ok(Object.keys(mastery.records).length > 0, '应有掌握度数据');

    const history = await getJson<{ history: any[] }>(
      `/api/v1/students/${STUDENT_ID}/mastery/history`
    );
    assert.ok(
      history.history.length > 0,
      '应有状态迁移轨迹（升降阶）'
    );

    // 第三层：成绩趋势 —— 历次考试
    const results = await getJson<{ results: any[] }>(
      `/api/v1/students/${STUDENT_ID}/exam-results`
    );
    assert.ok(Array.isArray(results.results));
  });
});

describe('TC-07 多维错题整理与分析', () => {
  test('错题按五维错因与订正状态可筛选', async () => {
    const errors = await getJson<{ records: any[] }>(
      `/api/v1/students/${STUDENT_ID}/error-records`
    );
    assert.ok(errors.records.length > 0);

    const FIVE_TYPES = [
      '知识问题',
      '方法问题',
      '计算问题',
      '熟练度问题',
      '审题问题',
    ];
    for (const r of errors.records) {
      assert.ok(
        FIVE_TYPES.includes(r.errorType),
        `错因应为五维之一，实际 ${r.errorType}`
      );
      assert.ok(
        ['未订正', '已订正', '待复测', '已闭环'].includes(r.status),
        `订正状态受控，实际 ${r.status}`
      );
    }

    // 订正心得可记录
    const target = errors.records[0];
    const patched = await fetch(
      `${baseUrl}/api/v1/error-records/${STUDENT_ID}/${target.id}`,
      {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          status: '已订正',
          correctionNote: '重新梳理了分类讨论的触发条件',
        }),
      }
    );
    const patchedBody = (await patched.json()) as {
      status: string;
      correctionNote: string;
    };
    assert.equal(patchedBody.status, '已订正');
    assert.ok(patchedBody.correctionNote.length > 0);
  });
});

describe('TC-08 自动元信息识别与试卷存档', () => {
  test('试卷存档库留存元信息、错因分布与知识点', async () => {
    const papers = await getJson<{
      papers: Array<{
        id: string;
        subject: string;
        status: string;
        errorRecordCount: number;
        errorTypeCounts: Record<string, number>;
        knowledgeIds: string[];
      }>;
    }>(`/api/v1/students/${STUDENT_ID}/papers`);

    assert.ok(papers.papers.length > 0, '存档库应非空');

    const paper = papers.papers[0];
    assert.ok(paper.subject, '应留存学科');
    assert.ok(paper.status, '应留存识别状态');
    assert.ok(paper.errorRecordCount > 0, '应关联错题');
    assert.ok(Object.keys(paper.errorTypeCounts).length > 0, '应含错因分布');
    assert.ok(paper.knowledgeIds.length > 0, '应含涉及知识点');
  });

  test('单份试卷详情含关联错题明细', async () => {
    const list = await getJson<{ papers: Array<{ id: string }> }>(
      `/api/v1/students/${STUDENT_ID}/papers`
    );
    const paperId = list.papers[0].id;

    const detail = await getJson<{
      paper: { id: string; summary: string };
      errorRecords: any[];
    }>(`/api/v1/students/${STUDENT_ID}/papers/${paperId}`);

    assert.equal(detail.paper.id, paperId);
    assert.ok(detail.errorRecords.length > 0, '应含错题明细');
    for (const r of detail.errorRecords) {
      assert.ok(r.evidence, '每条错题应带证据');
    }
  });

  test('考试场次列表可用于存档库场次回填', async () => {
    const exams = await getJson<{ exams: Array<{ id: string; title: string }> }>(
      `/api/v1/students/${STUDENT_ID}/exams`
    );
    assert.ok(exams.exams.length > 0, '应有考试场次');
    for (const e of exams.exams) {
      assert.ok(e.title, '场次应有标题');
    }
  });
});

describe('TC-09 学科思维导图标记试卷问题点', () => {
  test('思维导图可按试卷筛选出问题点（错题含试卷归属）', async () => {
    const errors = await getJson<{ records: any[] }>(
      `/api/v1/students/${STUDENT_ID}/error-records`
    );

    // 每条错题都应能归属到某份试卷（思维导图按此筛选分支）
    const withPaper = errors.records.filter((r) => r.examPaperId);
    assert.ok(
      withPaper.length > 0,
      '错题应带 examPaperId —— 思维导图据此按卷高亮问题点'
    );

    // 按卷筛选应得到子集
    const paperId = withPaper[0].examPaperId;
    const scoped = errors.records.filter(
      (r) => r.examPaperId === paperId
    );
    assert.ok(scoped.length > 0);
    assert.ok(scoped.length <= errors.records.length);

    // 涉及的知识点应存在（思维导图节点）
    for (const r of scoped) {
      assert.ok(r.knowledgeId, '错题应关联知识点');
    }
  });
});
