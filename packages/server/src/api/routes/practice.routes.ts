/**
 * 练习题路由。
 *
 * 核心：题库优先策略（题库命中则不用 AI 生成，省成本且更稳定）。
 * 原来题库查找在前端 CoachPage 里做，属于业务逻辑，应下沉服务端。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { findBankQuestions } from '../../infrastructure/knowledge/curriculum.ts';
import { assertStudentAccess } from '../middleware/auth.ts';

export interface BankQuestion {
  id: string;
  subject: string;
  questionType: string;
  level: string;
  stem: string;
  standardAnswer: string;
  scoreValue: number;
  difficulty: number;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

export function createPracticeRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/practice/questions?knowledgeId=xxx&level=基础题&exclude=stem1|stem2
   *
   * 返回题库命中的题目。未命中时返回空数组，
   * 前端据此决定是否调用 AI 生成（generate）。
   */
  router.get(
    '/practice/questions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.query.studentId as string | undefined;
        if (studentId) {
          assertStudentAccess(req, studentId);
        }

        const knowledgeId = String(req.query.knowledgeId ?? '');
        if (!knowledgeId) {
          res.status(400).json({
            error: { code: 'VALIDATION_FAILED', message: '缺少 knowledgeId' },
            requestId: req.requestId,
          });
          return;
        }

        const level = req.query.level ? String(req.query.level) : undefined;
        const excludeRaw = String(req.query.exclude ?? '');
        const excludeStems = excludeRaw
          ? excludeRaw.split('||').map((s) => s.trim()).filter(Boolean)
          : [];

        const matches = findBankQuestions(knowledgeId, level ?? '', excludeStems);

        res.json({
          found: matches.length > 0,
          questions: matches as BankQuestion[],
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
