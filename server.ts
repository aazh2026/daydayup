import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { SHANGHAI_CURRICULUM } from './src/data/shanghaiCurriculum.ts';

const PORT = 3000;

function createAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildOntologySummary(subject?: string) {
  const filtered = subject
    ? SHANGHAI_CURRICULUM.filter((k) => k.subject === subject)
    : SHANGHAI_CURRICULUM;
  return filtered
    .map(
      (k) =>
        `- ID: "${k.id}" | 学科: ${k.subject} | 知识域: ${k.domain} | 知识点: ${k.name} | 子技能: ${k.subSkills.join('、')}`
    )
    .join('\n');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * 1. Exam Paper / Wrong Problem Diagnosis Agent (Supports multi-page images AND AI-recognized / parsed text papers)
   */
  app.post('/api/diagnose-paper', async (req, res) => {
    try {
      const {
        images = [],
        imageBase64,
        mimeType,
        rawText,
        parsedTextName,
        inputFormat = 'auto',
        subject = '数学',
        examTitle = '期中试卷诊断',
        useSampleImage = false,
      } = req.body ?? {};

      const ai = createAiClient();
      // Include full 5-subject curriculum ontology so auto-detected subject always maps to valid knowledgeIds
      const ontologyText = buildOntologySummary();

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      let hasImageInput = false;

      if (useSampleImage) {
        const samplePath = path.resolve(
          process.cwd(),
          'src/assets/images/sample_math_exam_paper_1794838486492.jpg'
        );
        if (fs.existsSync(samplePath)) {
          const fileBytes = fs.readFileSync(samplePath);
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: fileBytes.toString('base64'),
            },
          });
          hasImageInput = true;
        }
      } else if (Array.isArray(images) && images.length > 0) {
        for (const img of images.slice(0, 4)) {
          if (img?.base64 && img?.mimeType) {
            const cleaned = String(img.base64).replace(/^data:[^;]+;base64,/, '');
            parts.push({
              inlineData: {
                mimeType: String(img.mimeType),
                data: cleaned,
              },
            });
            hasImageInput = true;
          }
        }
      } else if (imageBase64 && mimeType) {
        const cleanedBase64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
        parts.push({
          inlineData: {
            mimeType: String(mimeType),
            data: cleanedBase64,
          },
        });
        hasImageInput = true;
      }

      const trimmedText = typeof rawText === 'string' ? rawText.trim() : '';
      if (!hasImageInput && !trimmedText) {
        res.status(400).json({ error: '请提供试卷图片，或粘贴/导入已识别的试卷文本与错题解析内容。' });
        return;
      }

      const textContextPrompt = trimmedText
        ? `输入形式：${hasImageInput ? '试卷图片 + 补充/解析文本' : `纯文本/AI已识别解析试卷${parsedTextName ? `（文件：${parsedTextName}）` : ''}（模式：${inputFormat}）`}
待诊断试卷/错题文本内容：
"""
${trimmedText}
"""`
        : '请结合图片中的印刷体题目、学生手写过程和红笔批改痕迹进行逐题识别与诊断。';

      const subjectHintText =
        subject && subject !== '自动识别'
          ? `用户预选学科提示：${subject}（如试卷实际明显属于其他学科，请以试卷实际内容为准识别）`
          : '用户未指定学科，请完全根据试卷内容自动识别学科';
      const titleHintText = examTitle
        ? `用户填写考试名称参考：${examTitle}（如试卷页眉或文本中已有明确考试名称，请优先提取试卷真实名称）`
        : '请自动提取或概括考试名称';

      const instructionPrompt = `你是上海初三中考“试卷诊断 Agent”（覆盖数学、英语、物理、化学、语文五门学科）。
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

      parts.push({ text: instructionPrompt });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedMetadata: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING },
                  examTitle: { type: Type.STRING },
                  examType: { type: Type.STRING },
                  examDate: { type: Type.STRING },
                  score: { type: Type.NUMBER },
                  fullScore: { type: Type.NUMBER },
                  metadataConfidence: { type: Type.STRING },
                },
                required: [
                  'subject',
                  'examTitle',
                  'examType',
                  'examDate',
                  'score',
                  'fullScore',
                  'metadataConfidence',
                ],
              },
              paperSummary: { type: Type.STRING },
              questionsDetectedCount: { type: Type.INTEGER },
              totalLostScore: { type: Type.NUMBER },
              diagnosedItems: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    questionNumber: { type: Type.STRING },
                    stem: { type: Type.STRING },
                    studentAnswer: { type: Type.STRING },
                    correctAnswer: { type: Type.STRING },
                    scoreLost: { type: Type.NUMBER },
                    knowledgeId: { type: Type.STRING },
                    errorType: { type: Type.STRING },
                    aiAnalysis: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    confidence: { type: Type.STRING },
                    verificationMethod: { type: Type.STRING },
                  },
                  required: [
                    'questionNumber',
                    'stem',
                    'studentAnswer',
                    'correctAnswer',
                    'scoreLost',
                    'knowledgeId',
                    'errorType',
                    'aiAnalysis',
                    'evidence',
                    'confidence',
                    'verificationMethod',
                  ],
                },
              },
            },
            required: [
              'detectedMetadata',
              'paperSummary',
              'questionsDetectedCount',
              'totalLostScore',
              'diagnosedItems',
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      console.error('Error in /api/diagnose-paper:', err);
      const message = err instanceof Error ? err.message : '试卷诊断请求失败';
      res.status(500).json({ error: message });
    }
  });

  /**
   * 2. Socratic Task-Driven AI Coach Endpoint
   */
  app.post('/api/coach/chat', async (req, res) => {
    try {
      const {
        subject = '数学',
        knowledgeName = '',
        knowledgeDefinition = '',
        commonTraps = [],
        masteryState = '待学习',
        socraticStage = 0,
        requestFullExplanation = false,
        teachingBehavior = '引导',
        history = [],
        studentMessage = '',
        activeProblem = '',
      } = req.body ?? {};

      const ai = createAiClient();

      const systemInstruction = `你是上海初三“AI学习教练”，不是闲聊机器人，而是任务驱动的学科教学 Agent。
你需要掌握五种教学行为：诊断、讲解、示范、引导、评测。
当前训练学科：${subject}
当前知识点：${knowledgeName}（当前掌握状态：${masteryState}）
知识定义：${knowledgeDefinition}
常见易错点：${Array.isArray(commonTraps) ? commonTraps.join('；') : ''}
${activeProblem ? `当前训练题目：${activeProblem}` : ''}

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

      const conversationText = Array.isArray(history)
        ? history
            .map((m: { role: string; text: string }) => `${m.role === 'user' ? '学生' : '教练'}: ${m.text}`)
            .join('\n')
        : '';

      const prompt = `${conversationText ? `历史对话：\n${conversationText}\n\n` : ''}当前苏格拉底阶段：Stage ${socraticStage}
期望教学行为：${requestFullExplanation ? '完整讲解与示范' : teachingBehavior}
学生最新输入：${studentMessage || '请开始本节学习引导'}`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reply: { type: Type.STRING },
              teachingBehaviorUsed: { type: Type.STRING },
              nextStage: { type: Type.INTEGER },
              detectedUnderstanding: { type: Type.STRING },
              suggestedQuickReplies: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: [
              'reply',
              'teachingBehaviorUsed',
              'nextStage',
              'detectedUnderstanding',
              'suggestedQuickReplies',
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      console.error('Error in /api/coach/chat:', err);
      const message = err instanceof Error ? err.message : 'AI教练响应失败';
      res.status(500).json({ error: message });
    }
  });

  /**
   * 3. Practice & Variant Question Generator with Dual-Pass Independent Verification
   */
  app.post('/api/practice/generate', async (req, res) => {
    try {
      const {
        subject = '数学',
        knowledgeId,
        knowledgeName,
        subSkills = [],
        commonTraps = [],
        level = '变式题',
        sourceErrorStem = '',
      } = req.body ?? {};

      const ai = createAiClient();

      // Pass 1: Generate problem & initial solution
      const genPrompt = `请为上海初三学生生成 1 道【${subject}】${level}，用于检验知识点「${knowledgeName}」（ID: ${knowledgeId}）的真实掌握情况。
涉及子技能：${Array.isArray(subSkills) ? subSkills.join('、') : ''}
重点易错点：${Array.isArray(commonTraps) ? commonTraps.join('；') : ''}
${sourceErrorStem ? `参考原错题（请勿照抄原数字，必须做条件或表达变式）：${sourceErrorStem}` : ''}

要求：
1. 严格符合上海初三中考考纲与难度（基础题难度2，变式题难度3，迁移题/延迟复测难度3-4）。
2. 如果是选择题，提供 4 个清晰选项（options 数组）；如果是填空/解答/化学方程式题，options 必须为空数组。
3. 题目条件必须唯一确定、无歧义、无矛盾。`;

      const pass1Resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: genPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              stem: { type: Type.STRING },
              questionType: { type: Type.STRING },
              options: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              standardAnswer: { type: Type.STRING },
              solutionSteps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              commonTrap: { type: Type.STRING },
            },
            required: [
              'stem',
              'questionType',
              'options',
              'standardAnswer',
              'solutionSteps',
              'commonTrap',
            ],
          },
        },
      });

      const draft = JSON.parse((pass1Resp.text ?? '{}').trim());

      // Pass 2: Independent Blind Solve & Consistency Audit (never trusts Pass 1's answer blindly)
      const optionsText =
        Array.isArray(draft.options) && draft.options.length > 0
          ? `\n选项：${draft.options.join(' | ')}`
          : '';
      const verifyPrompt = `你是上海初三学科审题验算官。请仅根据下列题干独立求解（不要假设任何预设答案），然后与候选答案比对是否完全一致。
学科：${subject}
题干：${draft.stem}${optionsText}
候选参考答案：${draft.standardAnswer}

请给出你的独立求解过程、独立得出的答案(independentAnswer)、是否与候选答案等价一致(isConsistent)，以及简明验算依据(verificationCheck)。`;

      const pass2Resp = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: verifyPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              independentAnswer: { type: Type.STRING },
              isConsistent: { type: Type.BOOLEAN },
              verificationCheck: { type: Type.STRING },
            },
            required: ['independentAnswer', 'isConsistent', 'verificationCheck'],
          },
        },
      });

      const audit = JSON.parse((pass2Resp.text ?? '{}').trim());
      const dualVerified = Boolean(audit.isConsistent);

      res.json({
        ...draft,
        standardAnswer: dualVerified ? draft.standardAnswer : audit.independentAnswer || draft.standardAnswer,
        dualVerified,
        verificationCheck: dualVerified
          ? `双轮独立验算一致：${audit.verificationCheck}`
          : `经第二轮独立验算修正为「${audit.independentAnswer}」：${audit.verificationCheck}`,
      });
    } catch (err) {
      console.error('Error in /api/practice/generate:', err);
      const message = err instanceof Error ? err.message : '生成练习题失败';
      res.status(500).json({ error: message });
    }
  });

  /**
   * 4. Practice Evaluation Agent
   */
  app.post('/api/practice/evaluate', async (req, res) => {
    try {
      const {
        subject = '数学',
        knowledgeName = '',
        stem = '',
        standardAnswer = '',
        studentAnswer = '',
      } = req.body ?? {};

      const ai = createAiClient();

      const prompt = `你是上海初三学科评测 Agent。请判断学生作答是否正确（等价数学表达式、等价英语大小写或合理完整表述均应判对），若错误请给出精确的错因分类与针对性反馈。
学科：${subject}
知识点：${knowledgeName}
题目：${stem}
参考标准答案：${standardAnswer}
学生作答：${studentAnswer}

errorType 仅当错误时从以下选择：知识问题 | 方法问题 | 计算问题 | 熟练度问题 | 审题问题；若正确则返回 "无"。`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isCorrect: { type: Type.BOOLEAN },
              errorType: { type: Type.STRING },
              feedback: { type: Type.STRING },
              stepHint: { type: Type.STRING },
              nextRecommendation: { type: Type.STRING },
            },
            required: ['isCorrect', 'errorType', 'feedback', 'stepHint', 'nextRecommendation'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      console.error('Error in /api/practice/evaluate:', err);
      const message = err instanceof Error ? err.message : '作答评测失败';
      res.status(500).json({ error: message });
    }
  });

  /**
   * 5. Dynamic Diagnostic Micro-Quiz Generator for unverified / low-confidence hypotheses
   */
  app.post('/api/diagnose-microquiz', async (req, res) => {
    try {
      const { targets = [] } = req.body ?? {};
      const ai = createAiClient();

      const targetDesc = Array.isArray(targets)
        ? targets
            .slice(0, 3)
            .map(
              (t: { id: string; subject: string; name: string; definition: string }) =>
                `- knowledgeId: ${t.id} | 学科: ${t.subject} | 知识点: ${t.name} | 核心定义: ${t.definition}`
            )
            .join('\n')
        : '';

      const prompt = `请针对以下上海初三学生目前“置信度待验证”的知识点，为每个知识点各生成 1 道高区分度诊断微测选择题（共最多3题），用来快速确认学生是真的概念不清还是偶然失误。
目标知识点：
${targetDesc}

每题包含：knowledgeId、subject、question、4个选项(options)、correctIndex(0-3整数)与简明解析(explanation)。务必核对答案索引准确无误。`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                knowledgeId: { type: Type.STRING },
                subject: { type: Type.STRING },
                question: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                correctIndex: { type: Type.INTEGER },
                explanation: { type: Type.STRING },
              },
              required: [
                'knowledgeId',
                'subject',
                'question',
                'options',
                'correctIndex',
                'explanation',
              ],
            },
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '[]').trim());
      res.json({ items: Array.isArray(parsed) ? parsed : [] });
    } catch (err) {
      console.error('Error in /api/diagnose-microquiz:', err);
      const message = err instanceof Error ? err.message : '生成诊断微测失败';
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
