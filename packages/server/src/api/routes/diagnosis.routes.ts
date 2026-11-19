/**
 * 三态自适应诊断路由。
 *
 * 与「试卷诊断」（POST /exams/:id/diagnosis，AI 读卷）不同，
 * 这条路由是**交互式微测**：从题库按知识点抽题、逐题作答、
 * 连对确认 → 判「掌握 / 不稳 / 薄弱」，最后写回掌握度。
 *
 * 路由清单：
 * - POST /api/v1/students/:id/diagnosis/adaptive/start    开始一次诊断
 * - POST /api/v1/students/:id/diagnosis/adaptive/answer   提交一次作答
 * - GET  /api/v1/students/:id/diagnosis/adaptive/sessions 会话列表
 * - GET  /api/v1/students/:id/diagnosis/adaptive/:sid     单个会话状态
 * - POST /api/v1/students/:id/diagnosis/adaptive/:sid/finalize 结束并落掌握度
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import {
  UnresolvedKnowledgeError,
  finalizeAdaptiveSession,
  getAdaptiveSession,
  listAdaptiveSessions,
  startAdaptiveSession,
  submitAdaptiveAnswer,
} from '../../modules/diagnosis/adaptive-diagnosis.ts';

export function createDiagnosisRoutes(container: Container): Router {
  const router = Router();

  /** POST /api/v1/students/:id/diagnosis/adaptive/start */
  router.post(
    '/students/:id/diagnosis/adaptive/start',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentWriteAccess(req, studentId);

        const body = req.body ?? {};
        const knowledgeIds: string[] = Array.isArray(body.knowledgeIds)
          ? body.knowledgeIds.map(String)
          : [];
        if (knowledgeIds.length === 0) {
          throw new ApiException('VALIDATION_FAILED', '缺少 knowledgeIds');
        }

        const session = await startAdaptiveSession(container, {
          studentId,
          knowledgeIds,
          mode: body.mode === 'screen' ? 'screen' : 'target',
          ...(body.confirm ? { confirm: Number(body.confirm) } : {}),
          ...(body.limit ? { limit: Number(body.limit) } : {}),
          ...(body.seed ? { seed: String(body.seed) } : {}),
        });
        res.json(session);
      } catch (err) {
        if (err instanceof UnresolvedKnowledgeError) {
          next(new ApiException('VALIDATION_FAILED', err.message, {
            unresolved: err.unresolved,
          }));
          return;
        }
        next(err);
      }
    }
  );

  /** POST /api/v1/students/:id/diagnosis/adaptive/answer */
  router.post(
    '/students/:id/diagnosis/adaptive/answer',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentWriteAccess(req, studentId);

        const body = req.body ?? {};
        const sessionId = String(body.sessionId ?? '');
        const knowledgeId = String(body.knowledgeId ?? '');
        if (!sessionId || !knowledgeId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 sessionId 或 knowledgeId');
        }

        const result = await submitAdaptiveAnswer(container, {
          studentId,
          sessionId,
          knowledgeId,
          answer: String(body.answer ?? ''),
          ...(body.qid ? { qid: String(body.qid) } : {}),
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/diagnosis/adaptive/sessions */
  router.get(
    '/students/:id/diagnosis/adaptive/sessions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);
        const sessions = await listAdaptiveSessions(container, studentId);
        res.json({ sessions });
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/diagnosis/adaptive/:sessionId */
  router.get(
    '/students/:id/diagnosis/adaptive/:sessionId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);
        const session = await getAdaptiveSession(
          container,
          studentId,
          req.params.sessionId
        );
        if (!session) {
          throw new ApiException('NOT_FOUND', '诊断会话不存在');
        }
        res.json(session);
      } catch (err) {
        next(err);
      }
    }
  );

  /** POST /api/v1/students/:id/diagnosis/adaptive/:sessionId/finalize */
  router.post(
    '/students/:id/diagnosis/adaptive/:sessionId/finalize',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentWriteAccess(req, studentId);
        const summary = await finalizeAdaptiveSession(
          container,
          studentId,
          req.params.sessionId
        );
        res.json(summary);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
