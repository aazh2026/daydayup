/**
 * 试卷诊断异步任务 Handler。
 *
 * 分离后大试卷诊断（多图 + 双轮验算）可能超过 2 分钟，
 * 同步请求会超时。改为 Job + SSE 进度推送。
 *
 * 幂等：同一 paperId 重复提交返回同一任务。
 */
import type { JobHandler, JobContext } from '../../infrastructure/jobs/job-types.ts';
import type { AIRuntime } from '../../infrastructure/ai/ai-runtime.ts';
import type { AIProvider } from '../../infrastructure/ai/provider.ts';
import { DIAGNOSIS_SCHEMA } from '../../infrastructure/ai/schemas.ts';
import { validateAgainstSchema } from '../../infrastructure/ai/schema-validator.ts';
import { buildDiagnosisPrompt } from '../../infrastructure/ai/prompts/registry.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import type { FileStorage } from '../../infrastructure/storage/file-storage.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import type { DiagnoseExamResponse } from '@daydayup/contracts';

/** 诊断结果结构校验失败时的重试次数 */
const DIAGNOSIS_MAX_RETRIES = 2;

export interface DiagnosisJobInput {
  studentId: string;
  paperId: string;
  subject?: string;
  examTitle?: string;
  inputFormat: 'image' | 'parsed_text' | 'mixed' | 'wrong_item';
  rawText?: string;
  parsedTextName?: string;
  /** 试卷图片的存储相对路径（最多 4 张，与原实现一致） */
  imagePaths?: string[];
}

/**
 * AI Provider 的来源。
 *
 * - `AIRuntime`：生产路径。**执行时**按当前配置解析 Provider，
 *   于是运行时才配上的 API Key 也能立即生效。
 * - `AIProvider`：测试替身 / 固定实现（保持旧调用方式可用）。
 */
export type AIProviderSource = AIRuntime | AIProvider;

async function resolveProvider(
  source: AIProviderSource
): Promise<AIProvider | null> {
  if (typeof (source as AIRuntime).resolve === 'function') {
    return (source as AIRuntime).resolve();
  }
  return source as AIProvider;
}

export function createDiagnosisJobHandler(
  aiSource: AIProviderSource,
  storage: FileStorage
): JobHandler<DiagnosisJobInput, DiagnoseExamResponse> {
  return {
    async execute(input, context: JobContext) {
      context.reportProgress('准备试卷材料', 10);

      /**
       * **执行时**解析 Provider，而不是在启动时注入。
       *
       * 原因：API Key 现在可以运行时配置（配置中心），
       * 启动时可能根本没有 Key。若在创建 Handler 时就把 Provider 定死，
       * 运行时配置的 Key 永远用不上。
       */
      const ai = await resolveProvider(aiSource);
      if (!ai) {
        throw new Error(
          'AI 能力不可用：请在「设置 → AI 配置」中填写 API Key 并启用 AI。'
        );
      }

      // ---- 组装多模态输入 ----
      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];

      let hasImageInput = false;
      const imagePaths = (input.imagePaths ?? []).slice(0, 4);

      for (const relativePath of imagePaths) {
        if (await context.isCancelled()) {
          throw new (await import('../../infrastructure/jobs/job-types.ts')).JobCancelledError();
        }
        const buffer = await storage.read(relativePath);
        if (!buffer) {
          logger.warn('diagnosis.image_missing', { relativePath });
          continue;
        }
        const stat = await storage.stat(relativePath);
        parts.push({
          inlineData: {
            mimeType: stat?.mimeType ?? 'image/jpeg',
            data: buffer.toString('base64'),
          },
        });
        hasImageInput = true;
        context.reportProgress('读取试卷图片', 25);
      }

      const trimmedText = typeof input.rawText === 'string' ? input.rawText.trim() : '';
      if (!hasImageInput && !trimmedText) {
        throw new Error('请提供试卷图片，或粘贴/导入已识别的试卷文本与错题解析内容。');
      }

      // ---- 生成 prompt ----
      const prompt = buildDiagnosisPrompt({
        subject: input.subject,
        examTitle: input.examTitle,
        rawText: input.rawText,
        parsedTextName: input.parsedTextName,
        inputFormat: input.inputFormat,
        hasImageInput,
      });
      parts.push({ text: prompt });

      context.reportProgress('AI 识别试卷结构', 40);

      // ---- 调用 AI（多模态直连） ----
      const client = (ai as unknown as { client: any }).client;
      if (!client) {
        throw new Error('AI Provider 未初始化');
      }

      const { toGeminiSchema } = await import(
        '../../infrastructure/ai/gemini-provider.ts'
      );

      /**
       * 模型 ID 来自运行时配置（配置中心可改），不再硬编码。
       * Provider 本身已按当前配置创建，这里再取一次是为了
       * 保证「任务执行瞬间」用的是最新配置。
       */
      const modelId = (ai as unknown as { model?: string }).model ?? 'gemini-4-hydrogen';

      context.reportProgress('解析诊断结果', 75);

      /**
       * **必须做 schema 校验。**
       *
       * 此前这里直接 `JSON.parse` 就当成诊断结果，
       * 完全跳过 `validateAgainstSchema` ——
       * 而这正是**异步诊断的主路径**（前端走 Job + SSE）。
       *
       * 后果：规格 §7.1「证据与置信度完整率 100%」在真实链路上没有保障，
       * 模型少返回 `evidence` / `confidence` / `verificationMethod` 也会照单全收，
       * 落库成缺字段的错题记录。
       *
       * 现在与纯文本路径对齐：校验失败 → 重试 → 仍失败则任务明确失败，
       * 而不是把结构不完整的结果当成正常诊断落库。
       */
      let parsed: Record<string, unknown> | null = null;
      let lastError = '未知错误';

      for (let attempt = 0; attempt <= DIAGNOSIS_MAX_RETRIES; attempt++) {
        const response = await client.models.generateContent({
          model: modelId,
          contents: { parts },
          config: {
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(DIAGNOSIS_SCHEMA),
          },
        });

        let candidate: unknown;
        try {
          candidate = JSON.parse((response.text ?? '{}').trim());
        } catch {
          lastError = '模型返回内容不是合法 JSON';
          continue;
        }

        if (!validateAgainstSchema(candidate, DIAGNOSIS_SCHEMA)) {
          lastError = '模型返回结构不符合 schema';
          continue;
        }

        parsed = candidate as Record<string, unknown>;
        break;
      }

      if (!parsed) {
        throw new Error(
          `诊断结果结构校验失败（${lastError}）：缺少证据/置信度/验证方式等必需字段`
        );
      }

      context.reportProgress('生成诊断报告', 90);

      const result: DiagnoseExamResponse = {
        ...(parsed as unknown as DiagnoseExamResponse),
        meta: {
          promptVersion: 'diagnosis.v1',
          model: modelId,
          curriculumVersion: getCurriculumVersion(),
          requestId: context.jobId,
          computedAt: new Date().toISOString(),
        },
      };

      context.reportProgress('完成', 100);
      return result;
    },
  };
}
