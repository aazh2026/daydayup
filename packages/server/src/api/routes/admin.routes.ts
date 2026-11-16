/**
 * 运维管理路由（数据保留、备份、审计）。
 *
 * 这些接口涉及全量数据操作，仅老师角色与已登录用户可用。
 * 生产环境应进一步限制为管理员账号。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentWriteAccess } from '../middleware/auth.ts';
import { logger } from '../../infrastructure/logging/logger.ts';

export function createAdminRoutes(container: Container): Router {
  const router = Router();

  /**
   * POST /api/v1/admin/cleanup
   * 手动触发数据保留清理。
   */
  router.post('/admin/cleanup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await container.retention.cleanup();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/v1/admin/students/:id/data
   *
   * 删除某学生的全部数据（数据主体删除权）。
   * 审计记录保留以满足可追溯要求。
   */
  router.delete(
    '/admin/students/:id/data',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentWriteAccess(req, studentId);

        const result = await container.retention.deleteStudentData(studentId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/admin/backup
   * 创建备份。
   */
  router.post('/admin/backup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const label = String(req.body?.label ?? 'manual');
      const { path: backupPath, manifest } = await container.backup.create(label);
      res.json({
        path: backupPath,
        createdAt: manifest.createdAt,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        checksum: manifest.checksum,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/admin/backups
   * 列出备份。
   */
  router.get('/admin/backups', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ backups: await container.backup.list() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/admin/backups/:name/verify
   * 验证备份可恢复性。
   */
  router.get(
    '/admin/backups/:name/verify',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const backups = await container.backup.list();
        const target = backups.find((b) => b.path.endsWith(req.params.name));
        if (!target) {
          throw new ApiException('NOT_FOUND', '备份不存在');
        }
        const result = await container.backup.verify(target.path);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/admin/backups/:name/restore
   * 从备份恢复（dryRun=true 时仅校验）。
   */
  router.post(
    '/admin/backups/:name/restore',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const backups = await container.backup.list();
        const target = backups.find((b) => b.path.endsWith(req.params.name));
        if (!target) {
          throw new ApiException('NOT_FOUND', '备份不存在');
        }
        const result = await container.backup.restore(target.path, {
          dryRun: req.body?.dryRun === true,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/admin/audit
   * 读取审计日志。
   */
  router.get('/admin/audit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dateKey = req.query.date
        ? String(req.query.date)
        : new Date().toISOString().slice(0, 10);
      const entries = await container.db.readLines<Record<string, unknown>>([
        'audit',
        `${dateKey}.jsonl`,
      ]);
      res.json({ date: dateKey, entries });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/admin/audit
   * 写入审计记录。
   */
  router.post('/admin/audit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      const now = new Date().toISOString();
      const entry = {
        event_id: `audit_${randomUUID()}`,
        event_type: String(body.eventType ?? 'CustomAudit'),
        aggregate_id: body.aggregateId ? String(body.aggregateId) : '',
        occurred_at: now,
        payload: body.payload ?? {},
        actor: req.auth?.principalId ?? 'anonymous',
      };

      await container.db.append(
        ['audit', `${now.slice(0, 10)}.jsonl`],
        JSON.stringify(entry)
      );

      logger.info('audit.written', {
        eventType: entry.event_type,
        actor: entry.actor,
      });

      res.json(entry);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
