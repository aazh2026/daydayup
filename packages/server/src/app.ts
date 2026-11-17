/**
 * Express 应用组装。
 *
 * 分离后服务端不再托管前端构建产物（移除原 server.ts 的 vite middleware 挂载），
 * 前端由 Vite dev server（开发）或静态托管（生产）独立提供。
 */
import express from 'express';
import type { Express, Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from './bootstrap/container.ts';
import { requestIdMiddleware } from './api/middleware/request-id.ts';
import { corsMiddleware } from './api/middleware/cors.ts';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler.ts';
import { requireAuth } from './api/middleware/auth.ts';
import { rateLimit } from './api/middleware/rate-limit.ts';
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

  /**
   * 全局限流（保护整个 API 面）。
   *
   * 与 AI 配额分工：
   * - 限流：单位时间请求数，防瞬时刷量
   * - 配额：每日总量，防成本失控
   *
   * 关键：限流器挂在 `requireAuth` **之前**（公开端点如登录不能要求认证），
   * 此时 `req.auth` 还是 undefined —— 因此必须用 `resolvePrincipalId`
   * 自行解析令牌，否则已登录用户也会挤在同一个 IP 桶里，
   * 同一 NAT 下的不同用户会互相影响。
   */
  const principalIdResolver = (req: Request): string | null =>
    container.tokenService.resolvePrincipalId(req.header('authorization'));

  v1.use(
    rateLimit({
      windowMs: 60_000,
      max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
      skipAuthenticated: true,
      resolvePrincipalId: principalIdResolver,
    })
  );

  /**
   * AI 端点更严格的限流。
   * 每个 AI 调用都可能产生真实费用，因此单独收紧。
   */
  const aiLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_AI_PER_MINUTE ?? 10),
    skipAuthenticated: true,
    resolvePrincipalId: principalIdResolver,
    message: 'AI 请求过于频繁',
  });

  v1.use(createAiRoutes(container, aiLimiter));
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
   * 必须认证：任务输出可能包含学生的诊断结论与作答内容，
   * 不能仅凭 jobId 就被读取。
   *
   * SSE 也需要认证——前端用 fetch + ReadableStream 手动解析 SSE 帧，
   * 正是为了能携带 Authorization 头（EventSource 不支持自定义 header）。
   */
  const jobRouter = express.Router();
  if (container.config.authRequired) {
    jobRouter.use(requireAuth(container));
  }
  jobRouter.use(createJobRoutes(container));
  v1.use(jobRouter);

  app.use('/api/v1', v1);

  /**
   * 生产环境的静态前端托管。
   *
   * 前后端分离部署时，前端产物由独立静态托管服务提供；
   * 但也支持由后端一并托管（单容器部署），此时通过
   * STATIC_DIR 指定 web/dist 路径。
   *
   * 注意：**不托管 data/files 目录** —— 试卷图片必须经鉴权接口访问。
   */
  if (container.config.staticDir) {
    const staticDir = container.config.staticDir;
    if (fs.existsSync(staticDir)) {
      app.use(
        express.static(staticDir, {
          index: false,
          maxAge: '1h',
          setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) {
              res.setHeader('Cache-Control', 'no-cache');
            }
          },
        })
      );

      // SPA fallback
      app.get('*', (req, res, next) => {
        // API 与敏感路径不落到 SPA（否则会被当作前端路由）
        if (
          req.path.startsWith('/api') ||
          req.path.startsWith('/data') ||
          req.path.startsWith('/files')
        ) {
          next();
          return;
        }
        res.sendFile(path.join(staticDir, 'index.html'));
      });

      logger.info('app.static_mounted', { staticDir });
    } else {
      logger.warn('app.static_missing', { staticDir });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info('app.created', {
    aiEnabled: Boolean(container.ai),
    corsOrigins: container.config.corsOrigins,
  });

  return app;
}
