/**
 * 先修链路由（学生维度数据）。
 *
 * ⚠ 必须挂载在 `studentDataRouter` 之下（见 app.ts），
 * 因为这两个端点读的是**学生个人的掌握度记录**，
 * 属于学生数据，需要 `requireAuth` + 资源级隔离。
 *
 * 反例（曾经的错误）：把它们放进 `createKnowledgeRoutes`，
 * 而后者挂在 `v1` 上、**没有** `requireAuth` ——
 * 于是令牌虽然被前端带上了，服务端的 `req.auth` 却始终为空，
 * `assertStudentAccess` 抛 401「缺少访问令牌」；
 * 前端 API 客户端收到 401 后触发 `notifyAuthExpired()` 清会话 ——
 * 用户一进「提分报告」页就被踢回登录页。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess } from '../middleware/auth.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import {
  analyzeAllBlocking,
  analyzeBlockingChain,
} from '../../engines/prerequisite-engine.ts';
import { readMasteryAggregate } from '../../modules/mastery/mastery-service.ts';

export function createPrerequisiteRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/students/:id/prerequisite-chain?knowledgeId=xxx
   *
   * 某知识点的**传递**先修链与阻断根因。
   *
   * 为什么需要这个端点：提分优先级只看**直接**先修，
   * 但学习阻断是传递的 —— 学生不会「一次函数」时，
   * 真正该先补的是最底层那个点。这个端点把
   * 「目标 → 根因 → 学习路径」显式暴露给前端，
   * 是「从初三回溯到小学」这一能力的产品出口。
   */
  router.get(
    '/students/:id/prerequisite-chain',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const knowledgeId = String(req.query.knowledgeId ?? '');
        if (!knowledgeId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 knowledgeId');
        }

        const aggregate = await readMasteryAggregate(container, studentId);
        const chain = analyzeBlockingChain(knowledgeId, aggregate.records);

        res.json({
          version: getCurriculumVersion(),
          knowledgeId,
          chain,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/blocking-summary
   *
   * 全量知识点的阻断概况：哪些目标被阻、被什么阻、真正的根因在哪。
   *
   * 用于报告页的「根因分布」与教师端的教学重点排序。
   */
  router.get(
    '/students/:id/blocking-summary',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const aggregate = await readMasteryAggregate(container, studentId);
        const limitParam = req.query.limit;
        const limit = limitParam !== undefined ? Number(limitParam) : undefined;

        const summary = analyzeAllBlocking(aggregate.records, limit);

        res.json({
          version: getCurriculumVersion(),
          summary,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
