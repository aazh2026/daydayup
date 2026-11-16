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
import { createAiRoutes } from './api/routes/ai.routes.ts';
import { createKnowledgeRoutes } from './api/routes/knowledge.routes.ts';
import { createStudentRoutes } from './api/routes/student.routes.ts';
import { createMasteryRoutes } from './api/routes/mastery.routes.ts';
import { createPlanRoutes } from './api/routes/plan.routes.ts';
import { logger } from './infrastructure/logging/logger.ts';

export function createApp(container: Container): Express {
  const app = express();

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
      serviceTime: new Date().toISOString(),
    });
  });

  // ---- v1 API ----
  const v1 = express.Router();
  v1.use(createAiRoutes(container));
  v1.use(createKnowledgeRoutes());
  v1.use(createStudentRoutes(container));
  v1.use(createMasteryRoutes(container));
  v1.use(createPlanRoutes(container));
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
