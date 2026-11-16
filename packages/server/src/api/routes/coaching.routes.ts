/**
 * 教练会话路由。
 *
 * 分离前会话历史只存在 localStorage（且每次 appState 变化都整体重写），
 * 换设备即丢。现在按「学生 + 知识点」切分落盘。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import type { CoachMessage } from '@daydayup/contracts';

const COACHING_DIR = ['db', 'coaching'];

interface CoachingSession {
  studentId: string;
  knowledgeId: string;
  messages: CoachMessage[];
  updatedAt: string;
}

/** 单个知识点保留的最大消息数（防止文件无限增长） */
const MAX_MESSAGES = 50;

export function createCoachingRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/students/:id/coaching/sessions/:knowledgeId
   */
  router.get(
    '/students/:id/coaching/sessions/:knowledgeId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const session = await container.db.read<CoachingSession>([
          ...COACHING_DIR,
          req.params.id,
          `${req.params.knowledgeId}.json`,
        ]);
        res.json({
          studentId: req.params.id,
          knowledgeId: req.params.knowledgeId,
          messages: session?.messages ?? [],
          updatedAt: session?.updatedAt ?? null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PUT /api/v1/students/:id/coaching/sessions/:knowledgeId
   *
   * 全量覆盖该知识点的会话消息（前端持有完整历史）。
   */
  router.put(
    '/students/:id/coaching/sessions/:knowledgeId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentWriteAccess(req, req.params.id);
        const body = req.body ?? {};
        const messages: CoachMessage[] = Array.isArray(body.messages)
          ? body.messages.slice(-MAX_MESSAGES)
          : [];

        const session: CoachingSession = {
          studentId: req.params.id,
          knowledgeId: req.params.knowledgeId,
          messages,
          updatedAt: new Date().toISOString(),
        };

        await container.db.write(
          [...COACHING_DIR, req.params.id, `${req.params.knowledgeId}.json`],
          session
        );

        res.json({
          studentId: session.studentId,
          knowledgeId: session.knowledgeId,
          messages: session.messages,
          updatedAt: session.updatedAt,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/coaching/sessions
   * 列出该学生所有会话（按知识点）。
   */
  router.get(
    '/students/:id/coaching/sessions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const studentId = req.params.id;

        const ids = await container.db.list([...COACHING_DIR, studentId]);
        const sessions = [];
        for (const fileId of ids) {
          const session = await container.db.read<CoachingSession>([
            ...COACHING_DIR,
            studentId,
            fileId.replace(/\.json$/, ''),
          ]);
          if (session) {
            sessions.push({
              knowledgeId: session.knowledgeId,
              messageCount: session.messages.length,
              updatedAt: session.updatedAt,
            });
          }
        }
        sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        res.json({ sessions });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
