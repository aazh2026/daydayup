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
import { mergeTraps } from '../../infrastructure/knowledge/trap-context.ts';
import { resolveKnowledgeIds } from '../../infrastructure/knowledge/id-aliases.ts';
import { assertStudentAccess } from '../middleware/auth.ts';

export interface BankQuestion {
  id: string;
  subject: string;
  questionType: string;
  level: string;
  stem: string;
  options?: string[];
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

        // 外部 id 兼容：旧链接带的是 cnm_ext_* / mt_* 这类外部 id，
        // 这里解析成项目原生 id（不猜，无映射 → 404 语义上的空结果）。
        const resolved = resolveKnowledgeIds([knowledgeId]);
        if (resolved.resolved.length === 0) {
          res.json({ found: false, questions: [] });
          return;
        }

        const level = req.query.level ? String(req.query.level) : undefined;
        const excludeRaw = String(req.query.exclude ?? '');
        const excludeStems = excludeRaw
          ? excludeRaw.split('||').map((s) => s.trim()).filter(Boolean)
          : [];

        const matches = findBankQuestions(
          resolved.resolved[0],
          level ?? '',
          excludeStems
        );

        // 题目级 commonErrors 由错因资产层覆盖（applyTrapSets），
        // 但**知识点维度的**错因在这里也要带上 ——
        // 前端拿题库题去生成变式题时，需要的是「这个知识点的通用避坑点」，
        // 而不只是「这道题的历史错答」。
        const questions = matches.map((q) => ({
          ...q,
          commonErrors: (q.commonErrors ?? []).length
            ? q.commonErrors
            : [],
          knowledgeTraps: mergeTraps([], resolved.resolved[0], {
            includeQuestionTraps: false,
          }),
        })) as (BankQuestion & { knowledgeTraps: string[] })[];

        res.json({
          found: matches.length > 0,
          questions,
          resolvedKnowledgeId: resolved.resolved[0],
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
