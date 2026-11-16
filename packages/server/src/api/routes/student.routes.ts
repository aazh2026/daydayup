/**
 * 学生档案路由。
 *
 * 关键：每日有效学习预算由服务端计算（getEffectiveDailyBudget），
 * 防止学生篡改前端突破时间预算约束。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { getEffectiveDailyBudget } from '../../engines/planning-engine.ts';
import type { Student, StudentProfileUpdate } from '@daydayup/contracts';

const STUDENTS_DIR = ['db', 'students'];

export function createStudentRoutes(container: Container): Router {
  const router = Router();

  /** GET /api/v1/students/:id */
  router.get('/students/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const student = await container.db.read<Student>([
        ...STUDENTS_DIR,
        `${req.params.id}.json`,
      ]);
      if (!student) {
        throw new ApiException('NOT_FOUND', '学生不存在');
      }
      res.json(student);
    } catch (err) {
      next(err);
    }
  });

  /** PUT /api/v1/students/:id/profile */
  router.put('/students/:id/profile', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fileSegments = [...STUDENTS_DIR, `${req.params.id}.json`];
      const existing = await container.db.read<Student>(fileSegments);
      if (!existing) {
        throw new ApiException('NOT_FOUND', '学生不存在');
      }

      const patch = (req.body ?? {}) as StudentProfileUpdate;
      const updated: Student = { ...existing, ...patch };

      if (
        updated.dailyBudgetMinutes !== undefined &&
        (!Number.isFinite(updated.dailyBudgetMinutes) || updated.dailyBudgetMinutes <= 0)
      ) {
        throw new ApiException('VALIDATION_FAILED', '每日学习时长必须为正数');
      }

      await container.db.write(fileSegments, updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/v1/students/:id/effective-budget —— 服务端权威预算 */
  router.get(
    '/students/:id/effective-budget',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const student = await container.db.read<Student>([
          ...STUDENTS_DIR,
          `${req.params.id}.json`,
        ]);
        if (!student) {
          throw new ApiException('NOT_FOUND', '学生不存在');
        }
        res.json({
          studentId: student.id,
          effectiveDailyBudget: getEffectiveDailyBudget(student),
          baseMinutes: student.dailyBudgetMinutes,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
