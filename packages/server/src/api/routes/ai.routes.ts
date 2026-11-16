/**
 * AI 相关路由（迁移自原 server.ts 的 5 个接口）。
 *
 * 行为保持一致，改进点：
 * - 统一走 GeminiProvider（超时/重试/schema 校验）
 * - 错误统一为结构化 ApiError
 * - 响应附带 meta 可追溯信息
 */
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import {
  DIAGNOSIS_SCHEMA,
  COACH_SCHEMA,
  PRACTICE_GENERATE_SCHEMA,
  PRACTICE_VERIFY_SCHEMA,
  PRACTICE_EVALUATE_SCHEMA,
  MICROQUIZ_SCHEMA,
} from '../../infrastructure/ai/schemas.ts';
import {
  buildDiagnosisPrompt,
  buildCoachPrompt,
  buildPracticeGeneratePrompt,
  buildPracticeVerifyPrompt,
  buildPracticeEvaluatePrompt,
  buildMicroQuizPrompt,
} from '../../infrastructure/ai/prompts/registry.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import { toGeminiSchema } from '../../infrastructure/ai/gemini-provider.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireQuota } from '../middleware/quota.ts';

function requireAi(container: Container) {
  if (!container.ai) {
    throw new ApiException(
      'INTERNAL_ERROR',
      '服务端未配置 GEMINI_API_KEY，AI 能力不可用'
    );
  }
  return container.ai;
}

/** AI 超时与非法输出 → 明确的错误码，而非笼统 500 */
function throwAiFailure(result: { error: string | null; attempts: number }): never {
  const isTimeout = result.error?.toLowerCase().includes('abort') || result.error?.toLowerCase().includes('timeout');
  throw new ApiException(
    isTimeout ? 'AI_TIMEOUT' : 'AI_INVALID_OUTPUT',
    result.error ?? 'AI 调用失败'
  );
}

export function createAiRoutes(
  container: Container,
  extraLimiter?: RequestHandler
): Router {
  const router = Router();

  /**
   * AI 端点保护：
   * 1. 身份认证 —— 防止他人白嫖 GEMINI_API_KEY
   * 2. 配额限制 —— 防止单账号刷量
   *
   * 注意：authRequired=false（未配置 AUTH_SECRET）时跳过认证，
   * 仅保留配额保护，便于本地开发。
   */
  const guard = (
    path: string,
    handler: (req: Request, res: Response, next: NextFunction) => void
  ) => {
    const middlewares: RequestHandler[] = [];
    if (container.config.authRequired) middlewares.push(requireAuth(container));
    middlewares.push(requireQuota(container));
    if (extraLimiter) middlewares.push(extraLimiter);
    router.post(path, ...middlewares, handler);
  };

  /**
   * 1. 试卷诊断（原 /api/diagnose-paper）
   */
  guard('/diagnose-paper', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = requireAi(container);
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

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      let hasImageInput = false;

      if (useSampleImage) {
        // 样本试卷图片：服务端自有资产，缺失时静默降级为无图模式
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const candidates = [
            path.resolve(container.config.dataDir, 'files/sample-exam-paper.jpg'),
            path.resolve(container.config.dataDir, 'seed/sample-exam-paper.jpg'),
          ];
          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
              const fileBytes = fs.readFileSync(candidate);
              parts.push({
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: fileBytes.toString('base64'),
                },
              });
              hasImageInput = true;
              break;
            }
          }
        } catch {
          // 忽略：降级为无图模式
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
        throw new ApiException(
          'VALIDATION_FAILED',
          '请提供试卷图片，或粘贴/导入已识别的试卷文本与错题解析内容。'
        );
      }

      const prompt = buildDiagnosisPrompt({
        subject,
        examTitle,
        rawText,
        parsedTextName,
        inputFormat,
        hasImageInput,
      });

      parts.push({ text: prompt });

      const result = await ai.generateJson<Record<string, unknown>>({
        purpose: 'diagnosis',
        prompt: parts
          .map((p) =>
            'text' in p ? p.text : `[image ${p.inlineData.mimeType}]`
          )
          .join('\n'),
        schema: DIAGNOSIS_SCHEMA,
      });

      // 诊断需要携带图片，走多模态直连路径
      const parsed = result.data ?? (await runMultimodalDiagnosis(ai, parts));

      if (!parsed) throwAiFailure(result);

      res.json({
        ...parsed,
        meta: {
          promptVersion: result.promptVersion,
          model: result.model,
          curriculumVersion: getCurriculumVersion(),
          requestId: req.requestId,
          computedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 2. 教练对话（原 /api/coach/chat）
   */
  guard('/coach/chat', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = requireAi(container);
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

      const { systemInstruction, prompt } = buildCoachPrompt({
        subject,
        knowledgeName,
        knowledgeDefinition,
        commonTraps,
        masteryState,
        socraticStage,
        requestFullExplanation,
        teachingBehavior,
        history,
        studentMessage,
        activeProblem,
      });

      const result = await ai.generateJson<Record<string, unknown>>({
        purpose: 'coach',
        prompt,
        systemInstruction,
        schema: COACH_SCHEMA,
      });

      if (!result.data) throwAiFailure(result);
      res.json(result.data);
    } catch (err) {
      next(err);
    }
  });

  /**
   * 3. 练习题生成 + 双轮独立验算（原 /api/practice/generate）
   */
  guard('/practice/generate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = requireAi(container);
      const {
        subject = '数学',
        knowledgeId,
        knowledgeName,
        subSkills = [],
        commonTraps = [],
        level = '变式题',
        sourceErrorStem = '',
      } = req.body ?? {};

      // ---- Pass 1: 生成题目 ----
      const genPrompt = buildPracticeGeneratePrompt({
        subject,
        level,
        knowledgeName,
        knowledgeId,
        subSkills,
        commonTraps,
        sourceErrorStem,
      });

      const pass1 = await ai.generateJson<{
        stem: string;
        questionType: string;
        options: string[];
        standardAnswer: string;
        solutionSteps: string[];
        commonTrap: string;
      }>({
        purpose: 'practice-generate',
        prompt: genPrompt,
        schema: PRACTICE_GENERATE_SCHEMA,
      });

      if (!pass1.data) throwAiFailure(pass1);
      const draft = pass1.data;

      // ---- Pass 2: 独立盲解审计（绝不盲信 Pass 1 的答案）----
      const verifyPrompt = buildPracticeVerifyPrompt({
        subject,
        stem: draft.stem,
        options: draft.options,
        standardAnswer: draft.standardAnswer,
      });

      const pass2 = await ai.generateJson<{
        independentAnswer: string;
        isConsistent: boolean;
        verificationCheck: string;
      }>({
        purpose: 'practice-verify',
        prompt: verifyPrompt,
        schema: PRACTICE_VERIFY_SCHEMA,
      });

      const audit = pass2.data;
      const dualVerified = Boolean(audit?.isConsistent);

      res.json({
        ...draft,
        standardAnswer: dualVerified
          ? draft.standardAnswer
          : audit?.independentAnswer || draft.standardAnswer,
        dualVerified,
        verificationCheck: dualVerified
          ? `双轮独立验算一致：${audit!.verificationCheck}`
          : `经第二轮独立验算修正为「${audit?.independentAnswer}」：${audit?.verificationCheck ?? ''}`,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 4. 作答评测（原 /api/practice/evaluate）
   */
  guard('/practice/evaluate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = requireAi(container);
      const {
        subject = '数学',
        knowledgeName = '',
        stem = '',
        standardAnswer = '',
        studentAnswer = '',
      } = req.body ?? {};

      const prompt = buildPracticeEvaluatePrompt({
        subject,
        knowledgeName,
        stem,
        standardAnswer,
        studentAnswer,
      });

      const result = await ai.generateJson<Record<string, unknown>>({
        purpose: 'practice-evaluate',
        prompt,
        schema: PRACTICE_EVALUATE_SCHEMA,
      });

      if (!result.data) throwAiFailure(result);
      res.json(result.data);
    } catch (err) {
      next(err);
    }
  });

  /**
   * 5. 诊断微测（原 /api/diagnose-microquiz）
   */
  guard('/diagnose-microquiz', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = requireAi(container);
      const { targets = [] } = req.body ?? {};

      const prompt = buildMicroQuizPrompt(targets);

      const result = await ai.generateJson<unknown[]>({
        purpose: 'microquiz',
        prompt,
        schema: MICROQUIZ_SCHEMA,
      });

      if (!result.data) throwAiFailure(result);
      res.json({ items: Array.isArray(result.data) ? result.data : [] });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * 多模态直连（图片 + 文本 parts）。
 *
 * GeminiProvider.generateJson 目前按纯文本构造 contents，
 * 诊断场景需要携带图片 inlineData，故此处单独处理。
 */
async function runMultimodalDiagnosis(
  ai: NonNullable<Container['ai']>,
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>
): Promise<Record<string, unknown> | null> {
  const client = (ai as unknown as { client: any }).client;
  if (!client) return null;

  const response = await client.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: { parts },
    config: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(DIAGNOSIS_SCHEMA),
    },
  });

  try {
    return JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
  } catch (err) {
    logger.warn('ai.multimodal.parse_failed', { error: String(err) });
    return null;
  }
}
