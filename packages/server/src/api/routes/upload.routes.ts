/**
 * 文件上传与异步诊断路由。
 *
 * 分离后试卷图片不再 base64 直传模型：
 * 1. POST /uploads/papers → 落盘，返回 fileId
 * 2. POST /exams/:id/diagnosis → 创建 Job（引用 fileId）
 * 3. GET /jobs/:id/events → SSE 进度
 */
import { Router } from 'express';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import type { DiagnoseExamResponse } from '@daydayup/contracts';

export function createUploadRoutes(container: Container): Router {
  const router = Router();

  /**
   * POST /api/v1/uploads/papers
   *
   * 上传试卷图片（JSON base64 或 multipart）。
   *
   * 返回 fileId 与存储路径（不暴露绝对路径）。
   */
  router.post(
    '/uploads/papers',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body ?? {};
        const studentId = String(body.studentId ?? '');
        if (!studentId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
        }
        assertStudentWriteAccess(req, studentId);

        // ---- multipart（base64 字段）----
        const base64 = String(body.base64 ?? body.data ?? '');
        const mimeType = String(body.mimeType ?? 'image/jpeg');
        const originalName = String(body.originalName ?? 'paper.jpg');
        const paperId = body.paperId ? String(body.paperId) : undefined;

        if (!base64) {
          throw new ApiException('VALIDATION_FAILED', '缺少文件内容');
        }

        const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
        let buffer: Buffer;
        try {
          buffer = Buffer.from(cleaned, 'base64');
        } catch {
          throw new ApiException('VALIDATION_FAILED', '文件内容不是合法的 base64');
        }

        if (buffer.length === 0) {
          throw new ApiException('VALIDATION_FAILED', '文件内容为空');
        }

        const stored = await container.storage.save(buffer, {
          studentId,
          paperId,
          originalName,
          mimeType,
        });

        logger.info('upload.paper', {
          requestId: req.requestId,
          studentId,
          fileId: stored.id,
          size: stored.size,
        });

        res.json({
          fileId: stored.id,
          mimeType: stored.mimeType,
          size: stored.size,
          createdAt: stored.createdAt,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/uploads/papers/:fileId
   *
   * 下载试卷图片（鉴权后按 ID 返回，不暴露文件目录）。
   *
   * 鉴权依据**元数据索引**中的 studentId，而非文件名猜测——
   * 知道 fileId 也不足以访问他人文件。
   */
  router.get(
    '/uploads/papers/:fileId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = String(req.query.studentId ?? '');
        if (!studentId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
        }
        assertStudentAccess(req, studentId);

        const fileId = req.params.fileId;

        // 元数据索引鉴权：文件必须属于该学生
        const meta = await container.storage.getMeta(fileId);
        if (!meta) {
          throw new ApiException('NOT_FOUND', '文件不存在');
        }
        if (meta.studentId !== studentId) {
          throw new ApiException('FORBIDDEN', '无权访问该文件');
        }

        const buffer = await container.storage.read(meta.relativePath);
        if (!buffer) {
          throw new ApiException('NOT_FOUND', '文件不存在');
        }

        res.setHeader('Content-Type', meta.mimeType);
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        // 防止浏览器 MIME 嗅探导致的 XSS
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(meta.originalName)}"`);
        res.send(buffer);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/exams/:examId/diagnosis
   *
   * 发起异步诊断。
   *
   * 幂等：同一 (studentId, paperId) 返回同一任务。
   */
  router.post(
    '/exams/:examId/diagnosis',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body ?? {};
        const studentId = String(body.studentId ?? '');
        if (!studentId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
        }
        assertStudentWriteAccess(req, studentId);

        const examId = req.params.examId;
        const paperId = String(body.paperId ?? '');

        // 解析图片：优先 fileId 列表，回落旧版 base64
        const imagePaths: string[] = [];
        const fileIds: string[] = Array.isArray(body.fileIds)
          ? body.fileIds.map(String)
          : [];

        for (const fileId of fileIds) {
          const relativePath = await findFilePath(container, fileId);
          if (relativePath) imagePaths.push(relativePath);
        }

        // 兼容：直接传 base64（临时文件化）
        if (imagePaths.length === 0 && body.images) {
          const images = Array.isArray(body.images) ? body.images : [];
          for (const img of images.slice(0, 4)) {
            if (!img?.base64) continue;
            const cleaned = String(img.base64).replace(/^data:[^;]+;base64,/, '');
            const buffer = Buffer.from(cleaned, 'base64');
            const stored = await container.storage.save(buffer, {
              studentId,
              paperId: paperId || undefined,
              originalName: 'paper.jpg',
              mimeType: String(img.mimeType ?? 'image/jpeg'),
            });
            imagePaths.push(stored.relativePath);
          }
        }

        const rawText = body.rawText ? String(body.rawText) : undefined;
        if (imagePaths.length === 0 && !rawText) {
          throw new ApiException(
            'VALIDATION_FAILED',
            '请提供试卷图片，或粘贴/导入已识别的试卷文本与错题解析内容。'
          );
        }

        const input = {
          studentId,
          paperId,
          subject: body.subject ? String(body.subject) : '数学',
          examTitle: body.examTitle ? String(body.examTitle) : '期中试卷诊断',
          inputFormat: body.inputFormat ?? 'image',
          rawText,
          parsedTextName: body.parsedTextName
            ? String(body.parsedTextName)
            : undefined,
          imagePaths,
        };

        // 未注册诊断 Handler 时给出明确提示（通常是未配置 API Key）
        if (!container.jobEngine.hasHandler('diagnosis')) {
          throw new ApiException(
            'INTERNAL_ERROR',
            '服务端未配置 GEMINI_API_KEY，AI 诊断能力不可用'
          );
        }

        // 幂等键：同一试卷 + 同一输入不重复诊断
        const idempotencyKey = [
          studentId,
          examId,
          paperId,
          body.inputFormat ?? 'image',
          rawText ? rawText.length : imagePaths.join(','),
        ].join('|');

        const jobId = await container.jobEngine.enqueue(
          'diagnosis',
          input,
          { idempotencyKey, maxAttempts: 2 }
        );

        logger.info('diagnosis.enqueued', {
          requestId: req.requestId,
          studentId,
          examId,
          jobId,
        });

        res.status(202).json({
          mode: 'async',
          jobId,
          status: 'PENDING',
          streamUrl: `/api/v1/jobs/${jobId}/events`,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/exams/:examId/diagnosis/:jobId
   *
   * 同步等待诊断结果的辅助端点（供不支持 SSE 的客户端降级使用）。
   */
  router.get(
    '/exams/:examId/diagnosis/:jobId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const job = await container.jobEngine.getJob(req.params.jobId);
        if (!job) {
          throw new ApiException('NOT_FOUND', '任务不存在');
        }

        if (job.status === 'SUCCEEDED') {
          res.json({
            mode: 'sync',
            data: job.output as DiagnoseExamResponse,
          });
          return;
        }
        if (job.status === 'FAILED') {
          throw new ApiException('INTERNAL_ERROR', job.error ?? '诊断失败');
        }

        res.json({
          mode: 'async',
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          streamUrl: `/api/v1/jobs/${job.id}/events`,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/** 由 fileId 查找存储相对路径 */
async function findFilePath(
  container: Container,
  fileId: string
): Promise<string | null> {
  return container.storage.findById(fileId);
}
