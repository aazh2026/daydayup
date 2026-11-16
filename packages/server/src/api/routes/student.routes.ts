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
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import type { Student, StudentProfileUpdate } from '@daydayup/contracts';

const STUDENTS_DIR = ['db', 'students'];

/**
 * 读取全部学生档案。
 *
 * `db.list()` 返回带 `.json` 后缀的文件名，这里按 ID 读取（与 read 的兼容行为对称）。
 */
async function listStudents(container: Container): Promise<Student[]> {
  const files = await container.db.list(STUDENTS_DIR);
  const students: Student[] = [];
  for (const file of files) {
    const student = await container.db.read<Student>([
      ...STUDENTS_DIR,
      file.replace(/\.json$/, ''),
    ]);
    if (student) students.push(student);
  }
  return students;
}

export function createStudentRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/students —— 列出当前身份可访问的学生。
   *
   * 为什么需要这个端点：
   * 老师角色的 `studentIds` 为空（可访问**全部**学生，而非某个子集），
   * 因此前端无法从令牌里得知有哪些学生。
   * 没有这个端点，教师工作台永远拿不到学生列表 —— 功能形同虚设。
   *
   * 授权：
   * - teacher：返回全部学生
   * - student / parent：只返回 `studentIds` 内的学生
   */
  router.get('/students', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.auth;
      if (!auth) {
        // 开发模式：无认证上下文，返回全部学生（本地单一演示场景）
        const all = await listStudents(container);
        res.json({ students: all });
        return;
      }

      const all = await listStudents(container);
      const visible =
        auth.role === 'teacher'
          ? all
          : all.filter((s) => auth.studentIds.includes(s.id));

      res.json({ students: visible });
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/v1/students/:id */
  router.get('/students/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertStudentAccess(req, req.params.id);
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
      assertStudentWriteAccess(req, req.params.id);
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

      await container.audit.record('StudentProfileUpdated', {
        aggregateId: req.params.id,
        actor: req.auth?.principalId,
        actorRole: req.auth?.role,
        ip: req.ip,
        requestId: req.requestId,
        payload: { fields: Object.keys(patch) },
      });

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
        assertStudentAccess(req, req.params.id);
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
