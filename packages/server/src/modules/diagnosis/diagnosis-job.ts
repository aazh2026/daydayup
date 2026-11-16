/**
 * 试卷诊断异步任务 Handler。
 *
 * 分离后大试卷诊断（多图 + 双轮验算）可能超过 2 分钟，
 * 同步请求会超时。改为 Job + SSE 进度推送。
 *
 * 幂等：同一 paperId 重复提交返回同一任务。
 */
import type { JobHandler, JobContext } from '../../infrastructure/jobs/job-types.ts';
import type { AIProvider } from '../../infrastructure/ai/provider.ts';
import { DIAGNOSIS_SCHEMA } from '../../infrastructure/ai/schemas.ts';
import { buildDiagnosisPrompt } from '../../infrastructure/ai/prompts/registry.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import type { FileStorage } from '../../infrastructure/storage/file-storage.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import type { DiagnoseExamResponse } from '@daydayup/contracts';

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

export function createDiagnosisJobHandler(
  ai: AIProvider,
  storage: FileStorage
): JobHandler<DiagnosisJobInput, DiagnoseExamResponse> {
  return {
    async execute(input, context: JobContext) {
      context.reportProgress('准备试卷材料', 10);

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

      const response = await client.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(DIAGNOSIS_SCHEMA),
        },
      });

      context.reportProgress('解析诊断结果', 75);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
      } catch {
        throw new Error('模型返回内容不是合法 JSON');
      }

      context.reportProgress('生成诊断报告', 90);

      const result: DiagnoseExamResponse = {
        ...(parsed as unknown as DiagnoseExamResponse),
        meta: {
          promptVersion: 'diagnosis.v1',
          model: 'gemini-4-hydrogen',
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
