/**
 * 学习计划路由（服务端权威）。
 *
 * 现状前端 App.tsx:71 用 useMemo 在每次 appState 变化时全量重算 7 天计划。
 * 分离后改为服务端计算 + 前端乐观渲染 + 服务端结果覆盖。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { buildSevenDayPlan, computePriorityOpportunities } from '../../engines/planning-engine.ts';
import type {
  MasteryRecord,
  LearningPlan,
  Student,
} from '@daydayup/contracts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import { sanitizeSegment } from '../../infrastructure/persistence/file-database.ts';

const PLANS_DIR = ['db', 'plans'];

interface PlanAggregate {
  id: string;
  studentId: string;
  plan: LearningPlan;
  completedTaskIds: string[];
  deferredKnowledgeIds: string[];
  taskProgressByKnowledge: Record<
    string,
    {
      reviewedConcept?: boolean;
      viewedExample?: boolean;
      practiceSolvedCount: number;
      reviewedFeedback?: boolean;
    }
  >;
  updatedAt: string;
}

async function readPlan(
  container: Container,
  studentId: string
): Promise<PlanAggregate | null> {
  const ids = await container.db.list([...PLANS_DIR, studentId]);
  if (ids.length === 0) return null;
  const latest = ids.sort().reverse()[0];
  return container.db.read<PlanAggregate>([
    ...PLANS_DIR,
    studentId,
    latest.replace(/\.json$/, ''),
  ]);
}

export function createPlanRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/students/:id/plans/current
   *
   * 若无已存计划，则基于当前掌握度实时生成并落盘。
   */
  router.get(
    '/students/:id/plans/current',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const student = await container.db.read<Student>([
          'db',
          'students',
          `${studentId}.json`,
        ]);
        if (!student) {
          throw new ApiException('NOT_FOUND', '学生不存在');
        }

        const mastery = await container.db.read<{
          records: Record<string, MasteryRecord>;
        }>(['db', 'mastery', `${studentId}.json`]);
        const masteryRecords = mastery?.records ?? {};

        const existing = await readPlan(container, studentId);
        if (existing) {
          res.json(existing.plan);
          return;
        }

        const plan = buildSevenDayPlan({
          student,
          masteryRecords,
          completedTaskIds: [],
          deferredKnowledgeIds: [],
          taskProgressByKnowledge: {},
        });

        await container.db.write([...PLANS_DIR, studentId, `${plan.id}.json`], {
          id: plan.id,
          studentId,
          plan,
          completedTaskIds: [],
          deferredKnowledgeIds: [],
          taskProgressByKnowledge: {},
          updatedAt: new Date().toISOString(),
        } satisfies PlanAggregate);

        res.json(plan);
      } catch (err) {
        next(err);
      }
    }
  );

  /** POST /api/v1/students/:id/plans —— 重新生成计划 */
  router.post(
    '/students/:id/plans',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const student = await container.db.read<Student>([
          'db',
          'students',
          `${studentId}.json`,
        ]);
        if (!student) {
          throw new ApiException('NOT_FOUND', '学生不存在');
        }

        const mastery = await container.db.read<{
          records: Record<string, MasteryRecord>;
        }>(['db', 'mastery', `${studentId}.json`]);
        const masteryRecords = mastery?.records ?? {};

        const existing = await readPlan(container, studentId);

        const plan = buildSevenDayPlan({
          student,
          masteryRecords,
          completedTaskIds: existing?.completedTaskIds ?? [],
          deferredKnowledgeIds: existing?.deferredKnowledgeIds ?? [],
          taskProgressByKnowledge: existing?.taskProgressByKnowledge ?? {},
        });

        await container.db.write([...PLANS_DIR, studentId, `${plan.id}.json`], {
          id: plan.id,
          studentId,
          plan,
          completedTaskIds: existing?.completedTaskIds ?? [],
          deferredKnowledgeIds: existing?.deferredKnowledgeIds ?? [],
          taskProgressByKnowledge: existing?.taskProgressByKnowledge ?? {},
          updatedAt: new Date().toISOString(),
        } satisfies PlanAggregate);

        res.json(plan);
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/opportunities —— 提分机会 */
  router.get(
    '/students/:id/opportunities',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const mastery = await container.db.read<{
          records: Record<string, MasteryRecord>;
        }>(['db', 'mastery', `${sanitizeSegment(req.params.id)}.json`]);
        res.json({ opportunities: computePriorityOpportunities(mastery?.records ?? {}) });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/plans/:studentId/tasks/:taskId
   *
   * 更新任务状态（完成/延后）与步骤进度。
   */
  router.patch(
    '/plans/:studentId/tasks/:taskId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.studentId;
        const taskId = req.params.taskId;
        assertStudentWriteAccess(req, studentId);
        const body = req.body ?? {};

        const existing = await readPlan(container, studentId);
        if (!existing) {
          throw new ApiException('NOT_FOUND', '学习计划不存在');
        }

        if (body.status) {
          const idx = existing.completedTaskIds.indexOf(taskId);
          if (body.status === '已完成') {
            if (idx === -1) existing.completedTaskIds.push(taskId);
          } else if (idx !== -1) {
            existing.completedTaskIds.splice(idx, 1);
          }
        }

        if (body.deferred === true) {
          const knowledgeId = extractKnowledgeId(taskId);
          if (knowledgeId && !existing.deferredKnowledgeIds.includes(knowledgeId)) {
            existing.deferredKnowledgeIds.push(knowledgeId);
          }
        } else if (body.deferred === false) {
          const knowledgeId = extractKnowledgeId(taskId);
          if (knowledgeId) {
            existing.deferredKnowledgeIds =
              existing.deferredKnowledgeIds.filter((id) => id !== knowledgeId);
          }
        }

        if (body.progress) {
          const knowledgeId = extractKnowledgeId(taskId);
          if (knowledgeId) {
            const curr = existing.taskProgressByKnowledge[knowledgeId] ?? {
              practiceSolvedCount: 0,
            };
            existing.taskProgressByKnowledge[knowledgeId] = {
              reviewedConcept: body.progress.reviewedConcept ?? curr.reviewedConcept,
              viewedExample: body.progress.viewedExample ?? curr.viewedExample,
              practiceSolvedCount:
                curr.practiceSolvedCount + (body.progress.practiceSolvedDelta ?? 0),
              reviewedFeedback: body.progress.reviewedFeedback ?? curr.reviewedFeedback,
            };
          }
        }

        existing.updatedAt = new Date().toISOString();

        // 状态变化后重新生成计划，使服务端与前端保持一致
        const student = await container.db.read<Student>([
          'db',
          'students',
          `${studentId}.json`,
        ]);
        const mastery = await container.db.read<{
          records: Record<string, MasteryRecord>;
        }>(['db', 'mastery', `${studentId}.json`]);

        if (student) {
          existing.plan = buildSevenDayPlan({
            student,
            masteryRecords: mastery?.records ?? {},
            completedTaskIds: existing.completedTaskIds,
            deferredKnowledgeIds: existing.deferredKnowledgeIds,
            taskProgressByKnowledge: existing.taskProgressByKnowledge,
          });
        }

        await container.db.write(
          [...PLANS_DIR, studentId, `${existing.id}.json`],
          existing
        );

        res.json(existing.plan);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/** 从 taskId 提取知识点 ID（task-d{dayIdx}-{knowledgeId}） */
function extractKnowledgeId(taskId: string): string | null {
  const match = /^task-d\d+-(.+)$/.exec(taskId);
  return match ? match[1] : null;
}
