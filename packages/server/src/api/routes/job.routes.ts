/**
 * 后台任务路由（含 SSE 进度推送）。
 *
 * SSE 用 node:http 原生实现（保持零第三方依赖）。
 * 保留轮询作为降级路径（代理不支持 SSE 时）。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess } from '../middleware/auth.ts';
import { logger } from '../../infrastructure/logging/logger.ts';

export function createJobRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/jobs/:id
   * 查询任务状态（轮询降级路径）。
   */
  router.get('/jobs/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await container.jobEngine.getJob(req.params.id);
      if (!job) {
        throw new ApiException('NOT_FOUND', '任务不存在');
      }
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/jobs/:id/events
   *
   * SSE 进度推送。
   *
   * 事件类型：
   *   event: progress  data: { stage, pct, message }
   *   event: done      data: { job }
   *   event: error     data: { message }
   *   event: retry     data: { message, retryAt }
   *   event: cancelled data: { job }
   */
  router.get('/jobs/:id/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobEngine } = container;
      const jobId = req.params.id;

      const job = await jobEngine.getJob(jobId);
      if (!job) {
        throw new ApiException('NOT_FOUND', '任务不存在');
      }

      // ---- SSE 响应头 ----
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 关闭 Nginx 缓冲
      });
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // 立即推送当前状态
      if (job.status === 'SUCCEEDED') {
        send('done', { job });
        res.end();
        return;
      }
      if (job.status === 'FAILED') {
        send('error', { message: job.error ?? '任务失败' });
        res.end();
        return;
      }
      if (job.status === 'CANCELLED') {
        send('cancelled', { job });
        res.end();
        return;
      }

      send('progress', {
        stage: job.progress?.stage ?? '排队中',
        pct: job.progress?.pct ?? 0,
        message: job.progress?.message,
      });

      // ---- 订阅事件 ----
      const unsubscribe = jobEngine.subscribe(jobId, (event) => {
        switch (event.type) {
          case 'progress':
            send('progress', {
              stage: event.stage,
              pct: event.pct,
              message: event.message,
            });
            break;
          case 'done':
            send('done', { job: event.job });
            res.end();
            break;
          case 'error':
            send('error', { message: event.message });
            res.end();
            break;
          case 'retry':
            send('retry', {
              message: event.message,
              retryAt: event.retryAt,
            });
            break;
          case 'cancelled':
            send('cancelled', { job: event.job });
            res.end();
            break;
          default:
            break;
        }
      });

      // ---- 心跳（防止代理断开） ----
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };

      req.on('close', cleanup);
      res.on('close', cleanup);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/jobs/:id/cancel
   */
  router.post('/jobs/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await container.jobEngine.cancel(req.params.id);
      res.json({ ok: true, jobId: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/jobs
   * 列出任务（供调试与运维）。
   */
  router.get('/jobs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobs = await container.jobEngine.list();
      res.json({
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          progress: j.progress,
          error: j.error,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
