/**
 * 提示词注册表测试。
 *
 * 提示词版本化是**可追溯性**的基石：诊断结果记录 promptVersion，
 * 使得「上周和本周诊断结果为何变化」能被回答。
 * 若版本号缺失或错乱，历史结果就再也解释不清了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_VERSIONS,
  getPromptVersion,
  buildOntologySummary,
  buildDiagnosisPrompt,
  buildCoachPrompt,
  buildPracticeGeneratePrompt,
  buildPracticeVerifyPrompt,
  buildPracticeEvaluatePrompt,
  buildMicroQuizPrompt,
} from '../src/infrastructure/ai/prompts/registry.ts';
import type { AIPurpose } from '../src/infrastructure/ai/provider.ts';

const PURPOSES: AIPurpose[] = [
  'diagnosis',
  'practice-generate',
  'practice-verify',
  'practice-evaluate',
  'coach',
  'microquiz',
];

describe('提示词版本', () => {
  test('每种用途都有版本号', () => {
    for (const purpose of PURPOSES) {
      const version = getPromptVersion(purpose);
      assert.ok(version.length > 0, `${purpose} 缺少版本号`);
      assert.ok(version.includes('.'), `${purpose} 的版本号格式可疑: ${version}`);
    }
  });

  test('版本号与用途对应（便于按用途回溯）', () => {
    assert.equal(getPromptVersion('diagnosis'), 'diagnosis.v1');
    assert.equal(getPromptVersion('coach'), 'coach.v1');
    assert.ok(getPromptVersion('microquiz').startsWith('microquiz.'));
  });

  test('注册表覆盖全部用途', () => {
    for (const purpose of PURPOSES) {
      assert.ok(PROMPT_VERSIONS[purpose], `${purpose} 未在注册表中`);
    }
  });

  test('未知用途回退到 unknown.v1（不抛错）', () => {
    assert.equal(getPromptVersion('nonexistent' as never), 'unknown.v1');
  });

  test('版本号互不相同（否则无法区分来源）', () => {
    const versions = PURPOSES.map((p) => getPromptVersion(p));
    assert.equal(new Set(versions).size, versions.length);
  });
});

describe('知识本体摘要', () => {
  test('包含全部知识点及其 ID', () => {
    const text = buildOntologySummary();
    const lines = text.split('\n').filter((l) => l.startsWith('- ID:'));
    assert.ok(lines.length > 0, '本体摘要不应为空');

    // 每个知识点行都要有 ID、学科、名称
    for (const line of lines) {
      assert.match(line, /ID: "[^"]+"/);
      assert.match(line, /学科: /);
      assert.match(line, /知识点: /);
    }
  });

  test('按学科筛选只含该学科', () => {
    const text = buildOntologySummary('数学');
    const lines = text.split('\n').filter((l) => l.startsWith('- ID:'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.match(line, /学科: 数学/);
    }
  });

  test('相同参数重复调用结果一致（缓存不改变语义）', () => {
    assert.equal(buildOntologySummary('数学'), buildOntologySummary('数学'));
  });

  test('不同学科得到不同摘要', () => {
    assert.notEqual(buildOntologySummary('数学'), buildOntologySummary('英语'));
  });
});

describe('诊断提示词', () => {
  test('包含知识本体（模型要据此映射 knowledgeId）', () => {
    const prompt = buildDiagnosisPrompt({ hasImageInput: true });
    const ontologyLines = prompt
      .split('\n')
      .filter((l) => l.startsWith('- ID:'));
    assert.ok(ontologyLines.length > 0, '诊断提示词应包含知识本体');
  });

  test('限定 errorType 为 5 类（与契约一致）', () => {
    const prompt = buildDiagnosisPrompt({ hasImageInput: true });
    for (const t of [
      '知识问题',
      '方法问题',
      '计算问题',
      '熟练度问题',
      '审题问题',
    ]) {
      assert.ok(prompt.includes(t), `缺少 errorType: ${t}`);
    }
  });

  test('无文本输入时走图片识别提示', () => {
    const prompt = buildDiagnosisPrompt({ hasImageInput: true });
    assert.ok(prompt.includes('印刷体题目'));
  });

  test('有文本输入时嵌入文本内容', () => {
    const prompt = buildDiagnosisPrompt({
      hasImageInput: false,
      rawText: '  1. 计算 3+4=__  ',
    });
    assert.ok(prompt.includes('3+4=__'), '应嵌入原始文本');
    assert.ok(prompt.includes('待诊断试卷'), '应包含文本上下文提示');
  });

  test('空白文本等同于无文本（不嵌入空块）', () => {
    const prompt = buildDiagnosisPrompt({ hasImageInput: true, rawText: '   ' });
    assert.ok(prompt.includes('印刷体题目'), '空白文本应走图片分支');
  });

  test('指定学科时给出预选提示', () => {
    const prompt = buildDiagnosisPrompt({ hasImageInput: true, subject: '数学' });
    assert.ok(prompt.includes('用户预选学科提示：数学'));
  });

  test('自动识别时提示模型自行判断', () => {
    const prompt = buildDiagnosisPrompt({
      hasImageInput: true,
      subject: '自动识别',
    });
    assert.ok(prompt.includes('自动识别学科'));
  });

  test('指定考试名时给出参考提示', () => {
    const prompt = buildDiagnosisPrompt({
      hasImageInput: true,
      examTitle: '2026学年第一学期初三物理期中测试',
    });
    assert.ok(prompt.includes('2026学年第一学期初三物理期中测试'));
  });
});

describe('教练提示词', () => {
  test('包含系统指令与提示词两部分', () => {
    const { systemInstruction, prompt } = buildCoachPrompt({});
    assert.ok(systemInstruction.length > 0);
    assert.ok(prompt.length > 0);
  });

  test('系统指令含 5 种教学行为', () => {
    const { systemInstruction } = buildCoachPrompt({});
    for (const b of ['诊断', '讲解', '示范', '引导', '评测']) {
      assert.ok(systemInstruction.includes(b), `缺少教学行为: ${b}`);
    }
  });

  test('系统指令含苏格拉底 5 个阶段', () => {
    const { systemInstruction } = buildCoachPrompt({});
    for (let stage = 0; stage <= 4; stage++) {
      assert.ok(
        systemInstruction.includes(`Stage ${stage}`),
        `缺少 Stage ${stage}`
      );
    }
  });

  test('请求完整讲解时行为切为「完整讲解与示范」', () => {
    const { prompt } = buildCoachPrompt({ requestFullExplanation: true });
    assert.ok(prompt.includes('完整讲解与示范'));
  });

  test('默认行为为引导', () => {
    const { prompt } = buildCoachPrompt({});
    assert.ok(prompt.includes('期望教学行为：引导'));
  });

  test('历史对话被格式化（学生/教练前缀）', () => {
    const { prompt } = buildCoachPrompt({
      history: [
        { role: 'user', text: '我不懂' },
        { role: 'assistant', text: '先看条件' },
      ],
    });
    assert.ok(prompt.includes('学生: 我不懂'));
    assert.ok(prompt.includes('教练: 先看条件'));
  });

  test('无历史时不输出空的历史块', () => {
    const { prompt } = buildCoachPrompt({ history: [] });
    assert.ok(!prompt.includes('历史对话'), '无历史时不应输出历史块');
  });

  test('易错点数组被拼接', () => {
    const { systemInstruction } = buildCoachPrompt({
      commonTraps: ['忘记检验分母不为0', '减号去括号未变号'],
    });
    assert.ok(systemInstruction.includes('忘记检验分母不为0；减号去括号未变号'));
  });

  test('易错点非数组时安全降级为空', () => {
    const { systemInstruction } = buildCoachPrompt({
      commonTraps: 'not-an-array' as never,
    });
    assert.ok(systemInstruction.includes('常见易错点：'));
  });
});

describe('练习生成提示词', () => {
  test('包含知识点 ID（模型据此对齐题目）', () => {
    const prompt = buildPracticeGeneratePrompt({
      knowledgeId: 'math-alg-rational',
      knowledgeName: '分式与代数式运算',
    });
    assert.ok(prompt.includes('math-alg-rational'));
    assert.ok(prompt.includes('分式与代数式运算'));
  });

  test('子技能与易错点被拼接', () => {
    const prompt = buildPracticeGeneratePrompt({
      subSkills: ['通分与约分'],
      commonTraps: ['忘记检验分母不为0'],
    });
    assert.ok(prompt.includes('通分与约分'));
    assert.ok(prompt.includes('忘记检验分母不为0'));
  });

  test('原错题作为变式参考且要求不照抄', () => {
    const prompt = buildPracticeGeneratePrompt({
      sourceErrorStem: '原题：1+1=?',
    });
    assert.ok(prompt.includes('原题：1+1=?'));
    assert.ok(prompt.includes('请勿照抄原数字'), '必须要求变式而非照抄');
  });

  test('无原错题时不输出参考块', () => {
    const prompt = buildPracticeGeneratePrompt({});
    assert.ok(!prompt.includes('参考原错题'));
  });
});

describe('独立验算提示词', () => {
  test('包含题干与候选答案', () => {
    const prompt = buildPracticeVerifyPrompt({
      stem: '1+1=?',
      standardAnswer: '2',
    });
    assert.ok(prompt.includes('1+1=?'));
    assert.ok(prompt.includes('2'));
  });

  test('明确要求独立求解（不假设预设答案）', () => {
    const prompt = buildPracticeVerifyPrompt({
      stem: 'x',
      standardAnswer: 'y',
    });
    assert.ok(prompt.includes('独立求解'));
    assert.ok(prompt.includes('不要假设任何预设答案'));
  });

  test('有选项时列出选项', () => {
    const prompt = buildPracticeVerifyPrompt({
      stem: 'x',
      standardAnswer: 'A',
      options: ['A', 'B'],
    });
    assert.ok(prompt.includes('A | B'));
  });

  test('无选项时不输出选项行', () => {
    const prompt = buildPracticeVerifyPrompt({
      stem: 'x',
      standardAnswer: 'A',
      options: [],
    });
    assert.ok(!prompt.includes('选项：'));
  });
});

describe('评测提示词', () => {
  test('包含标准答案与学生作答', () => {
    const prompt = buildPracticeEvaluatePrompt({
      stem: '1+1=?',
      standardAnswer: '2',
      studentAnswer: '3',
    });
    assert.ok(prompt.includes('1+1=?'));
    assert.ok(prompt.includes('2'));
    assert.ok(prompt.includes('3'));
  });

  test('限定 5 类 errorType 且正确时返回「无」', () => {
    const prompt = buildPracticeEvaluatePrompt({
      stem: 'x',
      standardAnswer: 'y',
      studentAnswer: 'z',
    });
    for (const t of [
      '知识问题',
      '方法问题',
      '计算问题',
      '熟练度问题',
      '审题问题',
    ]) {
      assert.ok(prompt.includes(t), `缺少 errorType: ${t}`);
    }
    assert.ok(prompt.includes('"无"'));
  });
});

describe('微测提示词', () => {
  test('包含目标知识点', () => {
    const prompt = buildMicroQuizPrompt([
      {
        id: 'math-alg-rational',
        subject: '数学',
        name: '分式与代数式运算',
        definition: '掌握分式运算',
      },
    ]);
    assert.ok(prompt.includes('math-alg-rational'));
    assert.ok(prompt.includes('分式与代数式运算'));
    assert.ok(prompt.includes('掌握分式运算'));
  });

  test('最多取 3 个知识点', () => {
    const targets = Array.from({ length: 6 }, (_, i) => ({
      id: `kp-${i}`,
      subject: '数学',
      name: `知识点${i}`,
      definition: `定义${i}`,
    }));
    const prompt = buildMicroQuizPrompt(targets);
    const lines = prompt.split('\n').filter((l) => l.startsWith('- knowledgeId:'));
    assert.equal(lines.length, 3, '微测最多 3 题');
  });

  test('空目标列表不抛错', () => {
    assert.doesNotThrow(() => buildMicroQuizPrompt([]));
  });

  test('要求答案索引准确（0-3）', () => {
    const prompt = buildMicroQuizPrompt([]);
    assert.ok(prompt.includes('correctIndex(0-3整数)'));
  });
});
