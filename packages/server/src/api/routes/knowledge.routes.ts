/**
 * 知识体系路由。
 *
 * 分离后知识体系成为服务端资产——前端不再硬编码 589 行本体。
 *
 * 注意：本路由挂在 `v1` 上、**不经** `requireAuth` ——
 * 知识本体是公开只读资产（不含学生数据），无需认证。
 * 学生维度的先修分析（需要读个人掌握度）在 `prerequisite.routes.ts`，
 * 挂载于受认证保护的 `studentDataRouter` 下。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Subject } from '@daydayup/contracts';
import {
  listKnowledgePoints,
  getCurriculumVersion,
  getCurriculum,
} from '../../infrastructure/knowledge/curriculum.ts';
import { resolveKnowledgeIds } from '../../infrastructure/knowledge/id-aliases.ts';

export function createKnowledgeRoutes(): Router {
  const router = Router();

  /** GET /api/v1/knowledge-points?subject=数学 */
  router.get('/knowledge-points', (req: Request, res: Response, next: NextFunction) => {
    try {
      const subject = req.query.subject as Subject | undefined;
      const knowledgePoints = listKnowledgePoints(subject);
      res.json({
        version: getCurriculumVersion(),
        knowledgePoints,
      });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/v1/knowledge-points/tree —— 供思维导图使用 */
  router.get('/knowledge-points/tree', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const curriculum = getCurriculum();
      const tree = curriculum.subjects.map((subject) => {
        const kps = curriculum.knowledgePoints.filter((kp) => kp.subject === subject);
        const domains = [...new Set(kps.map((kp) => kp.domain))];
        return {
          subject,
          domains: domains.map((domain) => ({
            domain,
            knowledgePoints: kps.filter((kp) => kp.domain === domain),
          })),
        };
      });
      res.json({ version: curriculum.version, tree });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/v1/knowledge-points/curriculum-version */
  router.get('/knowledge-points/curriculum-version', (_req: Request, res: Response) => {
    res.json({ version: getCurriculumVersion() });
  });

  /**
   * GET /api/v1/knowledge-points/resolve?ids=a,b,c
   *
   * 外部 id → 项目原生 id 的解析。旧链接、旧资料里带的是
   * `cnm_ext_*` / `mt_*` / atlas 的 `m1-*` / workbuddy 的 `01.01.01.01`，
   * 这些 id 不是主键，只能解析后使用。
   */
  router.get('/knowledge-points/resolve', (req: Request, res: Response) => {
    const raw = String(req.query.ids ?? '');
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const { resolved, unresolved } = resolveKnowledgeIds(ids);
    res.json({ resolved, unresolved });
  });

  return router;
}
