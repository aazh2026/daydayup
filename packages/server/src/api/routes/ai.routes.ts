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
import { mergeTraps } from '../../infrastructure/knowledge/trap-context.ts';
import { toGeminiSchema } from '../../infrastructure/ai/gemini-provider.ts';
import { validateAgainstSchema } from '../../infrastructure/ai/schema-validator.ts';
import type { AIProvider } from '../../infrastructure/ai/provider.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireQuota } from '../middleware/quota.ts';
import type { Role } from '../../infrastructure/security/token.ts';
import { judgeAnswerDeterministically } from '../../engines/judge-engine.ts';

/**
 * 解析当前可用的 AI Provider。
 *
 * **每次请求都按当前配置解析**，而不是用 `container.ai`（启动时的一次性快照）：
 * 运行时在配置中心改了 API Key / 模型 / 温度 / 开关都会立刻生效，无需重启。
 *
 * 注入场景（测试替身 / 外部实现）由 `AIRuntime.setOverride` 承担，
 * 它压过配置中心 —— 「调用方明确指定用哪个实现」优先于「配置里说了什么」。
 */
async function requireAi(container: Container) {
  const ai = await container.aiRuntime.resolve();
  if (!ai) {
    throw new ApiException(
      'INTERNAL_ERROR',
      'AI 能力不可用：请在「设置 → AI 配置」中填写 API Key 并启用 AI'
    );
  }
  return ai;
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
   * 3. 角色限制 —— 家长是只读角色，不能替孩子执行学习动作
   *
   * 注意：authRequired=false（未配置 AUTH_SECRET）时跳过认证，
   * 仅保留配额保护，便于本地开发。
   *
   * @param path 端点路径
   * @param handler 处理函数
   * @param options.roles 允许的角色（缺省为 student + teacher；
   *   家长只读，不在允许列表里）
   */
  const guard = (
    path: string,
    handler: (req: Request, res: Response, next: NextFunction) => void,
    options: { roles?: Role[] } = {}
  ) => {
    const middlewares: RequestHandler[] = [];
    if (container.config.authRequired) middlewares.push(requireAuth(container));

    /**
     * 角色限制。
     *
     * 家长是**只读**角色（见文档「角色与权限」）：
     * 可以看报告，但**不能替孩子提交作答**。
     *
     * 此前 AI 端点只有身份校验、没有角色校验，
     * 于是家长可以调用 `/practice/evaluate` 替孩子提交作答，
     * 拿到判定结果与分步提示 —— 既越过了只读边界，
     * 也消耗了孩子的 AI 配额。
     */
    const allowedRoles: Role[] = options.roles ?? ['student', 'teacher'];
    middlewares.push((req, _res, next) => {
      // 开发模式：无认证上下文，放行（本地单用户演示）
      if (!req.auth) {
        next();
        return;
      }
      if (!allowedRoles.includes(req.auth.role)) {
        next(
          new ApiException(
            'FORBIDDEN',
            `家长账号为只读角色，无法执行该操作（当前 ${req.auth.role}）`
          )
        );
        return;
      }
      next();
    });

    middlewares.push(requireQuota(container));
    if (extraLimiter) middlewares.push(extraLimiter);
    router.post(path, ...middlewares, handler);
  };

  /**
   * 1. 试卷诊断（原 /api/diagnose-paper）
   */
  guard('/diagnose-paper', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ai = await requireAi(container);
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

      if (!parsed) {
        /**
         * 两条路径都失败了。
         * 错误信息要能区分「文本路径的失败原因」与「多模态路径的结构不合规」，
         * 否则用户只会看到一个含糊的「AI 调用失败」。
         */
        if (!result.data) {
          throw new ApiException(
            'AI_INVALID_OUTPUT',
            '模型返回结构不符合诊断 schema（缺少证据/置信度/验证方式等必需字段）'
          );
        }
        throwAiFailure(result);
      }

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
      const ai = await requireAi(container);
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
        sourceErrorStem = '',
        sourceStudentAnswer = '',
        sourceErrorType = '',
        sourceAnalysis = '',
        knowledgeId = '',
      } = req.body ?? {};

      // 错因兜底：前端传的在前，服务端从错因资产层补知识点/题目错因在后。
      // 不做这一步的话，直接调本接口的调用方拿不到任何易错点，
      // 教练的诊断提问就会退化成泛泛而谈。
      const resolvedTraps = mergeTraps(commonTraps, knowledgeId);

      const { systemInstruction, prompt } = buildCoachPrompt({
        subject,
        knowledgeName,
        knowledgeDefinition,
        commonTraps: resolvedTraps,
        masteryState,
        socraticStage,
        requestFullExplanation,
        teachingBehavior,
        history,
        studentMessage,
        activeProblem,
        sourceErrorStem,
        sourceStudentAnswer,
        sourceErrorType,
        sourceAnalysis,
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
      const ai = await requireAi(container);
      const {
        subject = '数学',
        knowledgeId,
        knowledgeName,
        subSkills = [],
        commonTraps = [],
        level = '变式题',
        sourceErrorStem = '',
      } = req.body ?? {};

      // ---- 错因兜底 ----
      // 前端传的在前，服务端从错因资产层补：
      //   1) 知识点维度的 commonTraps（英语 139 个主资产点 + 468 个叠加层点）
      //   2) 题目维度的 commonErrors（题库里挂在该知识点上的真实失分描述）
      // 第 2 层是 P2 验收标准「变式题提示词带上陷阱」的关键 ——
      // 题目级错因比知识点级更贴近这道题。
      const resolvedTraps = mergeTraps(commonTraps, knowledgeId);

      // ---- Pass 1: 生成题目 ----
      const genPrompt = buildPracticeGeneratePrompt({
        subject,
        level,
        knowledgeName,
        knowledgeId,
        subSkills,
        commonTraps: resolvedTraps,
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
   *
   * 采用“纯函数确定性判题前置 + LLM 复杂归因回落”双层架构：
   * - 客观选择题与标准数值/代数式一致时：纯函数毫秒级判对，零 API 消耗、零不确定性；
   * - 答案不一致或需要细分五维错因时：自动回落给 LLM 深入归因与反馈。
   */
  guard('/practice/evaluate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        subject = '数学',
        knowledgeName = '',
        stem = '',
        standardAnswer = '',
        studentAnswer = '',
      } = req.body ?? {};

      // 第一道防线：纯函数确定性判题
      const deterministic = judgeAnswerDeterministically(
        stem,
        standardAnswer,
        studentAnswer
      );

      if (deterministic.isDeterministic && deterministic.isCorrect) {
        res.json({
          isCorrect: true,
          feedback: deterministic.feedback ?? '回答正确！',
          errorType: deterministic.errorType ?? '无',
          guidance: deterministic.guidance ?? '掌握扎实。',
          confidence: deterministic.confidence ?? '确定',
          isDeterministic: true,
        });
        return;
      }

      // 第二道防线：回落至 AI 智能评测与错因细分
      const ai = await requireAi(container);
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
      const ai = await requireAi(container);
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
 *
 * **关键：必须做 schema 校验。**
 * 此前这里直接 `JSON.parse` 就返回，完全跳过 `validateAgainstSchema`，
 * 而图片试卷诊断是**主路径** ——
 * 于是规格 §7.1「证据与置信度完整率 100%」在真实使用场景里没有服务端保障：
 * 模型少返回 `evidence` / `confidence` / `verificationMethod` 也会照单全收。
 *
 * 现在与纯文本路径对齐：
 * - 校验失败 → 记录告警并重试（最多 2 次）；
 * - 仍失败 → 返回 null，由调用方转成明确的 `AI_INVALID_OUTPUT` 错误码，
 *   而不是把结构不完整的结果当成正常诊断落库。
 */
async function runMultimodalDiagnosis(
  ai: AIProvider,
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  maxRetries = 2
): Promise<Record<string, unknown> | null> {
  const client = (ai as unknown as { client: any }).client;
  if (!client) return null;

  /** 模型 ID 来自运行时配置（配置中心可改），不再硬编码。 */
  const modelId = (ai as unknown as { model?: string }).model ?? 'gemini-4-hydrogen';

  let lastError = '未知错误';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await client.models.generateContent({
      model: modelId,
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(DIAGNOSIS_SCHEMA),
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse((response.text ?? '{}').trim());
    } catch (err) {
      lastError = '模型返回内容不是合法 JSON';
      logger.warn('ai.multimodal.parse_failed', {
        error: String(err),
        attempt: attempt + 1,
      });
      continue;
    }

    if (!validateAgainstSchema(parsed, DIAGNOSIS_SCHEMA)) {
      lastError = '模型返回结构不符合 schema';
      logger.warn('ai.multimodal.schema_invalid', {
        attempt: attempt + 1,
      });
      continue;
    }

    return parsed as Record<string, unknown>;
  }

  logger.warn('ai.multimodal.failed', { error: lastError });
  return null;
}
