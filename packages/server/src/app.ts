/**
 * Express 应用组装。
 *
 * 分离后服务端不再托管前端构建产物（移除原 server.ts 的 vite middleware 挂载），
 * 前端由 Vite dev server（开发）或静态托管（生产）独立提供。
 */
import express from 'express';
import type { Express } from 'express';
import type { Container } from './bootstrap/container.ts';
import { requestIdMiddleware } from './api/middleware/request-id.ts';
import { corsMiddleware } from './api/middleware/cors.ts';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler.ts';
import { requireAuth } from './api/middleware/auth.ts';
import { createAiRoutes } from './api/routes/ai.routes.ts';
import { createAuthRoutes } from './api/routes/auth.routes.ts';
import { createKnowledgeRoutes } from './api/routes/knowledge.routes.ts';
import { createStudentRoutes } from './api/routes/student.routes.ts';
import { createMasteryRoutes } from './api/routes/mastery.routes.ts';
import { createPlanRoutes } from './api/routes/plan.routes.ts';
import { createPracticeRoutes } from './api/routes/practice.routes.ts';
import { createExamRoutes } from './api/routes/exam.routes.ts';
import { createCoachingRoutes } from './api/routes/coaching.routes.ts';
import { createJobRoutes } from './api/routes/job.routes.ts';
import { createUploadRoutes } from './api/routes/upload.routes.ts';
import { createAdminRoutes } from './api/routes/admin.routes.ts';
import { logger } from './infrastructure/logging/logger.ts';

export function createApp(container: Container): Express {
  const app = express();

  // 供资源级鉴权中间件判断当前是否为强制认证模式
  app.locals.authRequired = container.config.authRequired;

  app.use(requestIdMiddleware);
  app.use(corsMiddleware(container.config.corsOrigins));
  app.use(express.json({ limit: '35mb' }));

  // ---- 健康检查 ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      ok: true,
      aiEnabled: Boolean(container.ai),
      authRequired: container.config.authRequired,
      serviceTime: new Date().toISOString(),
    });
  });

  // ---- v1 API ----
  const v1 = express.Router();
  v1.use(createAuthRoutes(container));
  v1.use(createAiRoutes(container));
  v1.use(createKnowledgeRoutes());

  /**
   * 学生数据路由：需要认证 + 资源级隔离。
   *
   * 与 AI 路由不同，这些路由在未配置 AUTH_SECRET（开发模式）时也放行，
   * 但一旦配置了 AUTH_SECRET 就强制认证。
   */
  const studentDataRouter = express.Router();
  if (container.config.authRequired) {
    studentDataRouter.use(requireAuth(container));
  }
  studentDataRouter.use(createStudentRoutes(container));
  studentDataRouter.use(createMasteryRoutes(container));
  studentDataRouter.use(createPlanRoutes(container));
  studentDataRouter.use(createPracticeRoutes(container));
  studentDataRouter.use(createExamRoutes(container));
  studentDataRouter.use(createCoachingRoutes(container));
  studentDataRouter.use(createUploadRoutes(container));
  studentDataRouter.use(createAdminRoutes(container));
  v1.use(studentDataRouter);

  /**
   * 任务路由。
   *
   * SSE 需要在认证中间件之前保持连接，因此这里只挂载读接口，
   * 写操作（取消任务）通过 studentDataRouter 鉴权。
   */
  const jobRouter = express.Router();
  jobRouter.use(createJobRoutes(container));
  v1.use(jobRouter);

  app.use('/api/v1', v1);

  /**
   * 旧路径兼容层（迁移期保留一个发布周期）。
   *
   * 前端全量切换到 /api/v1 后删除。
   * 旧路径映射到新实现，避免前后端版本组合时 404。
   */
  const legacy = express.Router();
  legacy.use(createAiRoutes(container));
  app.use('/api', legacy);

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info('app.created', {
    aiEnabled: Boolean(container.ai),
    corsOrigins: container.config.corsOrigins,
  });

  return app;
}
