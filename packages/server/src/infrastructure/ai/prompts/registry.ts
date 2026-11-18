/**
 * 提示词注册表（版本化）。
 *
 * 现状痛点：prompt 硬编码在 server.ts 中，修改后无法回溯
 * 「上周和本周诊断结果为何变化」。
 *
 * 分离后每个提示词都有版本号，诊断结果记录 promptVersion，
 * 使结果可追溯（对应设计文档 §12.2）。
 *
 * 迁移说明：v1 的 prompt 文本与原 server.ts **逐字一致**，
 * 保证行为零变化。后续修改请新增 v2 而非原地修改 v1。
 */
import type { AIPurpose } from '../provider.ts';
import { listKnowledgePoints } from '../../knowledge/curriculum.ts';

export const PROMPT_VERSIONS: Record<AIPurpose, string> = {
  diagnosis: 'diagnosis.v1',
  'practice-generate': 'practice-generate.v1',
  'practice-verify': 'practice-verify.v1',
  'practice-evaluate': 'practice-evaluate.v1',
  coach: 'coach.v1',
  microquiz: 'microquiz.v1',
};

export function getPromptVersion(purpose: AIPurpose): string {
  return PROMPT_VERSIONS[purpose] ?? 'unknown.v1';
}

/**
 * 知识本体摘要。
 *
 * 原实现在每次请求时重建（server.ts:64）。本体是静态资产，
 * 此处做进程内缓存以减少无谓的字符串拼接开销。
 */
let ontologyCache: { key: string; text: string } | null = null;

export function buildOntologySummary(
  subject?: string,
  stage: '初中' | 'all' = '初中'
): string {
  const key = `${subject ?? '*'}:${stage}`;
  if (ontologyCache && ontologyCache.key === key) return ontologyCache.text;

  const filtered = listKnowledgePoints(subject as never, stage);

  const text = filtered
    .map(
      (k) =>
        `- ID: "${k.id}" | 学科: ${k.subject} | 知识域: ${k.domain} | 知识点: ${k.name} | 子技能: ${k.subSkills.join('、')}`
    )
    .join('\n');

  ontologyCache = { key, text };
  return text;
}

export interface DiagnosisPromptContext {
  subject?: string;
  examTitle?: string;
  rawText?: string;
  parsedTextName?: string;
  inputFormat?: string;
  hasImageInput: boolean;
}

/**
 * 诊断提示词 v1 —— 针对上海初三中考，本体注入优化（学段与学科过滤，大幅节省 Token 并消除学段漂移）。
 */
export function buildDiagnosisPrompt(ctx: DiagnosisPromptContext): string {
  const targetSubject =
    ctx.subject && ctx.subject !== '自动识别' ? ctx.subject : undefined;
  const ontologyText = buildOntologySummary(targetSubject, '初中');

  const trimmedText = typeof ctx.rawText === 'string' ? ctx.rawText.trim() : '';
  const textContextPrompt = trimmedText
    ? `输入形式：${ctx.hasImageInput ? '试卷图片 + 补充/解析文本' : `纯文本/AI已识别解析试卷${ctx.parsedTextName ? `（文件：${ctx.parsedTextName}）` : ''}（模式：${ctx.inputFormat ?? 'auto'}）`}
待诊断试卷/错题文本内容：
"""
${trimmedText}
"""`
    : '请结合图片中的印刷体题目、学生手写过程和红笔批改痕迹进行逐题识别与诊断。';

  const subjectHintText =
    ctx.subject && ctx.subject !== '自动识别'
      ? `用户预选学科提示：${ctx.subject}（如试卷实际明显属于其他学科，请以试卷实际内容为准识别）`
      : '用户未指定学科，请完全根据试卷内容自动识别学科';
  const titleHintText = ctx.examTitle
    ? `用户填写考试名称参考：${ctx.examTitle}（如试卷页眉或文本中已有明确考试名称，请优先提取试卷真实名称）`
    : '请自动提取或概括考试名称';

  return `你是上海初三中考“试卷诊断 Agent”（覆盖数学、英语、物理、化学、语文五门学科）。
学生可能上传“原始试卷照片”，也可能直接提供“AI已识别后的文本解读、OCR转录稿、Markdown/JSON结构化解析试卷或含批改记录的纯文本”。请严格完成以下任务：
1. **自动识别考试元信息 (detectedMetadata)**：
   - subject：从 "数学" | "英语" | "物理" | "化学" | "语文" 中识别所属学科。
   - examTitle：提取试卷页眉、标题或文本中的完整考试名称（如“2026学年第一学期初三物理期中测试”）；若无明确标题，则结合学科与门类生成简洁名称。
   - examType：从 "期中考试" | "月考" | "一模" | "二模" | "随堂诊断" 中判断考试门类。
   - examDate：若试卷中有明确考试日期，请转为 "YYYY-MM-DD" 格式；否则返回空字符串 ""。
   - score：提取试卷上的实得分数（数字）；若未标明实得分，请返回 -1（严禁随意编造）。
   - fullScore：提取卷面满分（如 100 / 70 / 50 / 150）；若未写明且无法确认，请返回 -1。
   - metadataConfidence："确定" | "较可能" | "待验证"。
2. 从图片或已识别/解析文本中提取所有**失分、做错、漏答或存疑的题目**（跳过明确标注全对/得满分的题目，但在 questionsDetectedCount 中统计整卷涉及的总题数）。提取字段包含：题号(questionNumber)、题干(stem)、学生作答(studentAnswer)、规范答案(correctAnswer)、扣分分值(scoreLost)。
3. 如果输入的文本中已经包含前序 AI 的初步解读、错因提示或教师批注，请充分吸收其中的有效事实与解题细节，并统一规范化到上海初三知识本体中**与识别学科相匹配**的 knowledgeId：
${ontologyText}
4. 严格区分知识点与失分原因，errorType 必须从以下 5 类中选择：
   - 知识问题
   - 方法问题
   - 计算问题
   - 熟练度问题
   - 审题问题
5. 为每条诊断结论提供：证据(evidence，注明来自哪道题及具体作答/批注表现)、判断(aiAnalysis)、置信度(confidence: "确定" | "较可能" | "待验证")、验证方式(verificationMethod)。
6. 严禁武断定论：若输入文本缺少具体扣分分值、学生原答不完整或仅凭单题存疑，请合理估算或保留原貌，并将 confidence 标为“待验证”以便人工校验台核对。

${subjectHintText}
${titleHintText}
${textContextPrompt}
`;
}

/**
 * 教练提示词 v1 —— 与原 server.ts:265-292 逐字等价。
 */
export function buildCoachPrompt(ctx: {
  subject?: string;
  knowledgeName?: string;
  knowledgeDefinition?: string;
  commonTraps?: string[];
  masteryState?: string;
  activeProblem?: string;
  sourceErrorStem?: string;
  sourceStudentAnswer?: string;
  sourceErrorType?: string;
  sourceAnalysis?: string;
  history?: Array<{ role: string; text: string }>;
  studentMessage?: string;
  requestFullExplanation?: boolean;
  teachingBehavior?: string;
  socraticStage?: number;
}): { systemInstruction: string; prompt: string } {
  const errorContextText = ctx.sourceErrorStem
    ? `
【学生既往失分证据与错题上下文】：
- 对应错题原题：${ctx.sourceErrorStem}
- 学生错误作答：${ctx.sourceStudentAnswer || '未记录'}
- 归因错因类型：${ctx.sourceErrorType || '未知'}
- 诊断归因分析：${ctx.sourceAnalysis || ''}
核心原则：本轮教学应针对上述失分点有的放矢。在 Stage 0 诊断提问时，请直接结合该题的典型陷阱或概念易错点展开提问，避免泛泛而谈！`
    : '';

  const systemInstruction = `你是上海初三“AI学习教练”，不是闲聊机器人，而是任务驱动的学科教学 Agent。
你需要掌握五种教学行为：诊断、讲解、示范、引导、评测。
当前训练学科：${ctx.subject ?? '数学'}
当前知识点：${ctx.knowledgeName ?? ''}（当前掌握状态：${ctx.masteryState ?? '待学习'}）
知识定义：${ctx.knowledgeDefinition ?? ''}
常见易错点：${Array.isArray(ctx.commonTraps) ? ctx.commonTraps.join('；') : ''}
${ctx.activeProblem ? `当前训练题目：${ctx.activeProblem}` : ''}${errorContextText}

核心教学原则：
1. 控制讲解粒度！每次只推进一小步（100-180字以内，禁止连续输出长篇大论）。
2. 默认采用苏格拉底式教学：
   - Stage 0（诊断）：先问学生看出了哪些已知条件或临界限制。
   - Stage 1（引导知识点）：问学生应该调用哪个核心性质/公式。
   - Stage 2（一级提示）：给出关键一步方向提示，让学生自己列式或判断。
   - Stage 3（二级提示）：给出核心算式骨架，请学生完成最后一步计算。
   - Stage 4（示范/完整讲解）：展示清晰的分步解答过程。
3. 如果 requestFullExplanation 为 true，或者学生明确要求“直接讲完整过程/看完整讲解”，必须立刻切换为“讲解/示范”行为，完整清晰地给出分步解答与易错提醒，不能机械拒绝！
4. 返回 JSON 格式，包含 reply、teachingBehaviorUsed（诊断|讲解|示范|引导|评测）、nextStage（0-4整数）、detectedUnderstanding（未理解|部分理解|已掌握）和 suggestedQuickReplies（2-3个简短的学生可选快捷回复）。`;

  const conversationText = Array.isArray(ctx.history)
    ? ctx.history
        .map((m: { role: string; text: string }) => `${m.role === 'user' ? '学生' : '教练'}: ${m.text}`)
        .join('\n')
    : '';

  const prompt = `${conversationText ? `历史对话：\n${conversationText}\n\n` : ''}当前苏格拉底阶段：Stage ${ctx.socraticStage ?? 0}
期望教学行为：${ctx.requestFullExplanation ? '完整讲解与示范' : ctx.teachingBehavior ?? '引导'}
学生最新输入：${ctx.studentMessage || '请开始本节学习引导'}`;

  return { systemInstruction, prompt };
}

/**
 * 练习题生成提示词 v1 —— 与原 server.ts:350-358 逐字等价。
 */
export function buildPracticeGeneratePrompt(ctx: {
  subject?: string;
  level?: string;
  knowledgeName?: string;
  knowledgeId?: string;
  subSkills?: string[];
  commonTraps?: string[];
  sourceErrorStem?: string;
}): string {
  return `请为上海初三学生生成 1 道【${ctx.subject ?? '数学'}】${ctx.level ?? '变式题'}，用于检验知识点「${ctx.knowledgeName ?? ''}」（ID: ${ctx.knowledgeId ?? ''}）的真实掌握情况。
涉及子技能：${Array.isArray(ctx.subSkills) ? ctx.subSkills.join('、') : ''}
重点易错点：${Array.isArray(ctx.commonTraps) ? ctx.commonTraps.join('；') : ''}
${ctx.sourceErrorStem ? `参考原错题（请勿照抄原数字，必须做条件或表达变式）：${ctx.sourceErrorStem}` : ''}

要求：
1. 严格符合上海初三中考考纲与难度（基础题难度2，变式题难度3，迁移题/延迟复测难度3-4）。
2. 如果是选择题，提供 4 个清晰选项（options 数组）；如果是填空/解答/化学方程式题，options 必须为空数组。
3. 题目条件必须唯一确定、无歧义、无矛盾。`;
}

/**
 * 独立验算提示词 v1 —— 与原 server.ts:400-405 逐字等价。
 */
export function buildPracticeVerifyPrompt(ctx: {
  subject?: string;
  stem: string;
  options?: string[];
  standardAnswer: string;
}): string {
  const optionsText =
    Array.isArray(ctx.options) && ctx.options.length > 0
      ? `\n选项：${ctx.options.join(' | ')}`
      : '';
  return `你是上海初三学科审题验算官。请仅根据下列题干独立求解（不要假设任何预设答案），然后与候选答案比对是否完全一致。
学科：${ctx.subject ?? '数学'}
题干：${ctx.stem}${optionsText}
候选参考答案：${ctx.standardAnswer}

请给出你的独立求解过程、独立得出的答案(independentAnswer)、是否与候选答案等价一致(isConsistent)，以及简明验算依据(verificationCheck)。`;
}

/**
 * 评测提示词 v1 —— 与原 server.ts:457-464 逐字等价。
 */
export function buildPracticeEvaluatePrompt(ctx: {
  subject?: string;
  knowledgeName?: string;
  stem: string;
  standardAnswer: string;
  studentAnswer: string;
}): string {
  return `你是上海初三学科评测 Agent。请判断学生作答是否正确（等价数学表达式、等价英语大小写或合理完整表述均应判对），若错误请给出精确的错因分类与针对性反馈。
学科：${ctx.subject ?? '数学'}
知识点：${ctx.knowledgeName ?? ''}
题目：${ctx.stem}
参考标准答案：${ctx.standardAnswer}
学生作答：${ctx.studentAnswer}

errorType 仅当错误时从以下选择：知识问题 | 方法问题 | 计算问题 | 熟练度问题 | 审题问题；若正确则返回 "无"。`;
}

/**
 * 诊断微测提示词 v1 —— 与原 server.ts:512-516 逐字等价。
 */
export function buildMicroQuizPrompt(
  targets: Array<{ id: string; subject: string; name: string; definition: string }>
): string {
  const targetDesc = Array.isArray(targets)
    ? targets
        .slice(0, 3)
        .map(
          (t) =>
            `- knowledgeId: ${t.id} | 学科: ${t.subject} | 知识点: ${t.name} | 核心定义: ${t.definition}`
        )
        .join('\n')
    : '';

  return `请针对以下上海初三学生目前“置信度待验证”的知识点，为每个知识点各生成 1 道高区分度诊断微测选择题（共最多3题），用来快速确认学生是真的概念不清还是偶然失误。
目标知识点：
${targetDesc}

每题包含：knowledgeId、subject、question、4个选项(options)、correctIndex(0-3整数)与简明解析(explanation)。务必核对答案索引准确无误。`;
}
