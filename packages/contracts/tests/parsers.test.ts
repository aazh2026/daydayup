/**
 * 契约校验函数测试。
 *
 * `packages/contracts` 是前后端**唯一事实源** —— 里面的
 * `parseXxx` 是运行时校验器：解析失败返回 null，
 * 前端据此显示「服务返回格式异常」而不是白屏。
 *
 * 因此这些函数的语义必须被锁死：
 * - 合法数据必须能通过（不能假阴性，把好数据当坏的）
 * - 非法数据必须被拒绝（不能假阳性，把坏数据放过去）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStudent,
  parseEffectiveBudget,
} from '../src/api/student.ts';
import {
  parseRetestStatus,
} from '../src/api/mastery.ts';
import {
  parseGeneratePracticeResponse,
  parseEvaluateResponse,
} from '../src/api/practice.ts';
import {
  parseCoachChatResponse,
} from '../src/api/coaching.ts';
import {
  parseKnowledgeList,
} from '../src/api/knowledge.ts';
import {
  parseJob,
} from '../src/api/job.ts';
import {
  parseDiagnoseExamResponse,
  parseMicroQuizResponse,
} from '../src/api/diagnosis.ts';
import {
  parseLearningPlan,
} from '../src/api/plan.ts';
import {
  isApiErrorResponse,
  buildApiError,
  API_ERROR_STATUS,
  API_ERROR_CODES,
} from '../src/api/errors.ts';

/** 所有解析器共有的非法输入 */
const INVALID_INPUTS: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['数字', 42],
  ['字符串', 'hello'],
  ['布尔', true],
  ['空数组', []],
  ['空对象', {}],
];

describe('学生档案解析', () => {
  const valid = {
    id: 'stu-1',
    name: '张伟',
    grade: '初三',
    region: '上海',
    targetExamDate: '2027-06-20',
    targetSchool: '上海市实验中学',
    dailyBudgetMinutes: 60,
    homeworkLoad: '适中',
    fatigueLevel: '低',
  };

  test('合法档案能解析', () => {
    const parsed = parseStudent(valid);
    assert.ok(parsed);
    assert.equal(parsed.id, 'stu-1');
    assert.equal(parsed.dailyBudgetMinutes, 60);
  });

  test('必填字段缺失时拒绝', () => {
    assert.equal(parseStudent({ ...valid, id: undefined }), null);
    assert.equal(parseStudent({ ...valid, name: 123 }), null);
    assert.equal(parseStudent({ ...valid, dailyBudgetMinutes: '60' }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseStudent(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('有效时长预算解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseEffectiveBudget({
      studentId: 'stu-1',
      effectiveDailyBudget: 45,
      baseMinutes: 60,
    });
    assert.ok(parsed);
    assert.equal(parsed.effectiveDailyBudget, 45);
  });

  test('缺少时长字段时拒绝', () => {
    assert.equal(parseEffectiveBudget({ studentId: 'stu-1' }), null);
    assert.equal(
      parseEffectiveBudget({ studentId: 'stu-1', effectiveDailyBudget: '45' }),
      null
    );
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseEffectiveBudget(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('复测状态解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseRetestStatus({
      unlocked: false,
      daysRemaining: 3,
      reason: '冷却期未结束',
    });
    assert.ok(parsed);
    assert.equal(parsed.unlocked, false);
    assert.equal(parsed.daysRemaining, 3);
  });

  test('字段类型错误时拒绝', () => {
    assert.equal(parseRetestStatus({ unlocked: 'no', daysRemaining: 3, reason: 'x' }), null);
    assert.equal(parseRetestStatus({ unlocked: true, daysRemaining: '3', reason: 'x' }), null);
    assert.equal(parseRetestStatus({ unlocked: true, daysRemaining: 3, reason: 5 }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseRetestStatus(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('练习题解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseGeneratePracticeResponse({
      stem: '题目',
      questionType: '选择题',
      options: ['A', 'B'],
      standardAnswer: 'A',
      solutionSteps: ['步骤1'],
      commonTrap: '易错点',
    });
    assert.ok(parsed);
    assert.equal(parsed.stem, '题目');
  });

  test('缺少关键字段时拒绝', () => {
    assert.equal(parseGeneratePracticeResponse({ standardAnswer: 'A', solutionSteps: [] }), null);
    assert.equal(parseGeneratePracticeResponse({ stem: 'x', solutionSteps: [] }), null);
    assert.equal(parseGeneratePracticeResponse({ stem: 'x', standardAnswer: 'A' }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(
        parseGeneratePracticeResponse(input),
        null,
        `应拒绝: ${label}`
      );
    }
  });
});

describe('评测结果解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseEvaluateResponse({
      isCorrect: true,
      errorType: '无',
      feedback: '很好',
      stepHint: '',
      nextRecommendation: '',
    });
    assert.ok(parsed);
    assert.equal(parsed.isCorrect, true);
  });

  test('isCorrect 非布尔时拒绝', () => {
    assert.equal(
      parseEvaluateResponse({ isCorrect: 'true', feedback: 'x' }),
      null
    );
    assert.equal(parseEvaluateResponse({ feedback: 'x' }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseEvaluateResponse(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('教练对话解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseCoachChatResponse({
      reply: '继续讲解',
      nextStage: 2,
      detectedUnderstanding: '理解了',
      suggestedQuickReplies: ['为什么'],
    });
    assert.ok(parsed);
    assert.equal(parsed.nextStage, 2);
  });

  test('字段缺失时拒绝', () => {
    assert.equal(parseCoachChatResponse({ nextStage: 2, suggestedQuickReplies: [] }), null);
    assert.equal(parseCoachChatResponse({ reply: 'x', suggestedQuickReplies: [] }), null);
    assert.equal(parseCoachChatResponse({ reply: 'x', nextStage: 2 }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseCoachChatResponse(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('知识体系解析', () => {
  const validKp = {
    id: 'math-alg-rational',
    name: '有理数运算',
    prerequisites: [],
  };

  test('合法数据能解析', () => {
    const parsed = parseKnowledgeList({
      version: 'shanghai-junior-2026.1',
      knowledgePoints: [validKp],
    });
    assert.ok(parsed);
    assert.equal(parsed.knowledgePoints.length, 1);
  });

  test('知识点缺字段时整份拒绝（不能部分放行）', () => {
    assert.equal(
      parseKnowledgeList({
        version: 'v1',
        knowledgePoints: [validKp, { id: 'x', name: 'X' }],
      }),
      null,
      '缺少 prerequisites 的知识点应导致整份拒绝'
    );
    assert.equal(
      parseKnowledgeList({
        version: 'v1',
        knowledgePoints: [{ id: 'x' }],
      }),
      null
    );
  });

  test('空知识点列表是合法的', () => {
    const parsed = parseKnowledgeList({ version: 'v1', knowledgePoints: [] });
    assert.ok(parsed);
    assert.equal(parsed.knowledgePoints.length, 0);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseKnowledgeList(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('任务解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseJob({
      id: 'job-1',
      type: 'diagnosis',
      status: 'SUCCEEDED',
      attempts: 1,
      maxAttempts: 3,
      createdAt: '2026-11-17T00:00:00.000Z',
    });
    assert.ok(parsed);
    assert.equal(parsed.status, 'SUCCEEDED');
  });

  test('id 或 status 缺失时拒绝', () => {
    assert.equal(parseJob({ status: 'PENDING' }), null);
    assert.equal(parseJob({ id: 'job-1' }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseJob(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('诊断响应解析', () => {
  const validItem = {
    questionNumber: '1',
    scoreLost: 5,
    knowledgeId: 'math-alg-rational',
  };

  test('合法数据能解析', () => {
    const parsed = parseDiagnoseExamResponse({
      paperSummary: '试卷摘要',
      questionsDetectedCount: 20,
      totalLostScore: 15,
      diagnosedItems: [validItem],
      detectedMetadata: { subject: '数学' },
    });
    assert.ok(parsed);
    assert.equal(parsed.diagnosedItems.length, 1);
  });

  test('诊断条目缺字段时拒绝', () => {
    assert.equal(
      parseDiagnoseExamResponse({
        paperSummary: 'x',
        questionsDetectedCount: 1,
        totalLostScore: 1,
        diagnosedItems: [{ questionNumber: '1' }],
        detectedMetadata: {},
      }),
      null
    );
  });

  test('detectedMetadata 缺失时拒绝', () => {
    assert.equal(
      parseDiagnoseExamResponse({
        paperSummary: 'x',
        questionsDetectedCount: 1,
        totalLostScore: 1,
        diagnosedItems: [],
      }),
      null
    );
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(
        parseDiagnoseExamResponse(input),
        null,
        `应拒绝: ${label}`
      );
    }
  });
});

describe('微测响应解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseMicroQuizResponse({
      items: [
        {
          knowledgeId: 'math-alg-rational',
          question: '1+1=?',
          options: ['1', '2'],
          correctIndex: 1,
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.items.length, 1);
  });

  test('条目缺字段时拒绝', () => {
    assert.equal(
      parseMicroQuizResponse({
        items: [{ knowledgeId: 'x', question: 'q', options: [] }],
      }),
      null
    );
  });

  test('空列表是合法的', () => {
    const parsed = parseMicroQuizResponse({ items: [] });
    assert.ok(parsed);
    assert.equal(parsed.items.length, 0);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseMicroQuizResponse(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('学习计划解析', () => {
  test('合法数据能解析', () => {
    const parsed = parseLearningPlan({
      id: 'plan-1',
      weekLabel: '第 1 周',
      effectiveDailyBudget: 60,
      generatedAt: '2026-11-17T00:00:00.000Z',
      engineVersion: 'v1',
      priorities: [],
      days: [],
      taskStates: {},
    });
    assert.ok(parsed);
    assert.equal(parsed.weekLabel, '第 1 周');
  });

  test('关键字段缺失时拒绝', () => {
    assert.equal(parseLearningPlan({ id: 'plan-1' }), null);
  });

  test('所有非法输入都被拒绝', () => {
    for (const [label, input] of INVALID_INPUTS) {
      assert.equal(parseLearningPlan(input), null, `应拒绝: ${label}`);
    }
  });
});

describe('错误响应工具', () => {
  test('buildApiError 产出标准结构', () => {
    const err = buildApiError('NOT_FOUND', '资源不存在', { id: 'x' }, 'req_1');
    assert.equal(err.error.code, 'NOT_FOUND');
    assert.equal(err.error.message, '资源不存在');
    assert.deepEqual(err.error.details, { id: 'x' });
    assert.equal(err.requestId, 'req_1');
  });

  test('未给消息时使用默认中文文案', () => {
    const err = buildApiError('QUOTA_EXCEEDED');
    assert.equal(err.error.message, '今日 AI 用量已达上限，请明天再试');
  });

  test('isApiErrorResponse 识别标准错误体', () => {
    assert.equal(isApiErrorResponse(buildApiError('FORBIDDEN')), true);
  });

  test('isApiErrorResponse 拒绝非错误体', () => {
    assert.equal(isApiErrorResponse(null), false);
    assert.equal(isApiErrorResponse({}), false);
    assert.equal(isApiErrorResponse({ error: 'string' }), false);
    assert.equal(isApiErrorResponse({ error: { code: 'UNKNOWN_CODE', message: 'x' } }), false);
    assert.equal(isApiErrorResponse({ error: { code: 'NOT_FOUND' } }), false);
  });

  test('每个错误码都有唯一且合理的 HTTP 状态映射', () => {
    const seen = new Map<number, string>();
    for (const code of API_ERROR_CODES) {
      const status = API_ERROR_STATUS[code];
      assert.equal(typeof status, 'number', `${code} 缺少状态映射`);

      // 语义检查
      if (code === 'UNAUTHORIZED') assert.equal(status, 401);
      if (code === 'FORBIDDEN') assert.equal(status, 403);
      if (code === 'NOT_FOUND') assert.equal(status, 404);
      if (code === 'VALIDATION_FAILED') assert.equal(status, 400);
      if (code === 'QUOTA_EXCEEDED') assert.equal(status, 429);

      // 4xx/5xx
      assert.ok(status >= 400 && status < 600, `${code} 的状态码应为 4xx/5xx`);

      const prev = seen.get(status);
      assert.equal(prev, undefined, `状态码 ${status} 被 ${prev} 与 ${code} 共用`);
      seen.set(status, code);
    }
  });
});
