/**
 * 掌握度路由（服务端权威）。
 *
 * 核心变化：掌握度状态迁移只能由服务端 MasteryEngine 计算。
 * 前端提交作答 → 服务端判定 → 服务端落库 → 返回权威变更。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { getDelayedRetestStatus } from '../../engines/planning-engine.ts';
import { computePriorityOpportunities } from '../../engines/planning-engine.ts';
import {
  MASTERY_DIR,
  readMasteryAggregate,
  writeMasteryAggregate,
  applyMasteryTransition,
  createEmptyMasteryRecord,
} from '../../modules/mastery/mastery-service.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import type {
  MasteryRecord,
  MasteryTransitionEvent,
  PracticeMode,
} from '@daydayup/contracts';

const MASTERY_DIR_LOCAL = MASTERY_DIR;

type MasteryAggregate = {
  studentId: string;
  records: Record<string, MasteryRecord>;
  history: MasteryTransitionEvent[];
  lastComputedAt: string;
};

/**
 * 聚合读写委托给共享服务（modules/mastery/mastery-service.ts）。
 *
 * 保留本地别名是为了不改动本文件其余部分的调用点，
 * 但**实现只有一份** —— 诊断路径与练习路径共用同一套读写逻辑。
 */
const readAggregate = readMasteryAggregate;
const writeAggregate = writeMasteryAggregate;

export function createMasteryRoutes(container: Container): Router {
  const router = Router();

  /** GET /api/v1/students/:id/mastery */
  router.get(
    '/students/:id/mastery',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const aggregate = await readAggregate(container, req.params.id);
        res.json({
          studentId: aggregate.studentId,
          records: aggregate.records,
          lastComputedAt: aggregate.lastComputedAt,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/mastery/history */
  router.get(
    '/students/:id/mastery/history',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const aggregate = await readAggregate(container, req.params.id);
        res.json({ history: aggregate.history });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/attempts
   *
   * 作答流水（用于报告页的评测记录与学习时长统计）。
   *
   * 数据来自事件日志文件（data/db/attempts/{studentId}/{yyyy-MM}.jsonl）。
   */
  router.get(
    '/students/:id/attempts',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const studentId = req.params.id;

        const files = await container.db.list(['db', 'attempts', studentId]);
        const attempts: unknown[] = [];
        const seen = new Set<string>();

        for (const file of files) {
          const lines = await container.db.readLines<Record<string, unknown>>([
            'db',
            'attempts',
            studentId,
            file,
          ]);
          for (const line of lines) {
            // 按 ID 去重（重复 seed 或多次写入时的防御）
            const id = String(line.id ?? '');
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            attempts.push(line);
          }
        }

        // 按时间倒序（最近在前）
        attempts.sort((a, b) => {
          const ta = String((a as { timestamp?: string }).timestamp ?? '');
          const tb = String((b as { timestamp?: string }).timestamp ?? '');
          return ta < tb ? 1 : -1;
        });

        res.json({ attempts, total: attempts.length });
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/mastery/:knowledgeId/retest-status */
  router.get(
    '/students/:id/mastery/:knowledgeId/retest-status',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const aggregate = await readAggregate(container, req.params.id);
        const rec = aggregate.records[req.params.knowledgeId];
        res.json(getDelayedRetestStatus(rec));
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/students/:id/mastery/:knowledgeId/attempt
   *
   * 提交作答 → 服务端判定 → 状态机迁移 → 落库 → 返回权威变更。
   * 这是「前端不再本地推导掌握度」的落点。
   */
  router.post(
    '/students/:id/mastery/:knowledgeId/attempt',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        const knowledgeId = req.params.knowledgeId;
        assertStudentWriteAccess(req, studentId);
        const body = req.body ?? {};

        const isCorrect = Boolean(body.isCorrect);
        const mode = (body.mode ?? '基础练习') as PracticeMode;
        const evidenceSummary = String(body.evidenceSummary ?? '');

        /**
         * 读-判-写必须整体串行化（按学生维度）。
         *
         * 否则并发作答会各自读到同一个旧聚合、各自写回自己的版本，
         * 后写者覆盖先写者 —— 知识点记录被静默丢弃。
         *
         * 实测：5 个并发作答（5 个不同知识点）全部返回 200，
         * 但聚合里只剩 **1 条**记录。
         *
         * 实现委托给共享服务 applyMasteryTransition（内含排他锁），
         * 与诊断路径共用同一套读写逻辑。
         */
        const transition = await applyMasteryTransition(container, {
          studentId,
          knowledgeId,
          mode,
          isCorrect,
          evidenceSummary,
          subject: String(body.subject ?? '数学'),
          hintsUsed: Number(body.hintsUsed ?? 0),
          triggerPrefix: mode,
        });

        const {
          record: updatedRecord,
          fromState: previousState,
          toState: newState,
          changed,
          transitionEventId,
        } = transition;

        /**
         * 追加作答事件（先落业务结果，再记事件）。
         *
         * 字段完整性：必须写入题干、学生作答、AI 反馈与任务 ID ——
         * 规格 §模块06 第一层要展示「评测记录」与「无提示独立作答率」，
         * 缺了这些字段，报告页的作答明细刷新后就是空的。
         *
         * 此前只写 9 个字段（缺 questionStem / userAnswer / aiFeedback / taskId），
         * 于是「刷新前看 seed 数据一切正常，真实使用后就丢失」。
         */
        const dateKey = new Date().toISOString().slice(0, 10);
        await container.db.append(
          ['db', 'attempts', studentId, `${dateKey}.jsonl`],
          JSON.stringify({
            id: `att_${randomUUID()}`,
            studentId,
            knowledgeId,
            mode,
            isCorrect,
            hintsUsed: body.hintsUsed ?? 0,
            timeSpentSeconds: body.timeSpentSeconds ?? 0,
            independent: body.independent ?? false,
            taskId: body.taskId,
            questionStem: body.questionStem,
            userAnswer: body.userAnswer,
            aiFeedback: body.aiFeedback,
            timestamp: new Date().toISOString(),
          })
        );

        /**
         * 提分机会基于**最新的**聚合重算。
         *
         * 注意必须在锁内拿到聚合快照 —— 锁外重新读取可能拿到
         * 已被其它并发请求更新过的版本，导致返回的提分机会与落库不一致。
         */
        const opportunities = computePriorityOpportunities(
          (
            await container.db.read<MasteryAggregate>([
              ...MASTERY_DIR,
              `${studentId}.json`,
            ])
          )?.records ?? { [knowledgeId]: updatedRecord }
        );
        const updatedOpportunity = opportunities.find(
          (o) => o.knowledgeId === knowledgeId
        );

        await container.audit.record('MasteryTransitionApplied', {
          aggregateId: knowledgeId,
          actor: req.auth?.principalId,
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: {
            studentId,
            from: previousState,
            to: newState,
            mode,
            isCorrect,
          },
        });

        logger.info('mastery.transition', {
          requestId: req.requestId,
          studentId,
          knowledgeId,
          from: previousState,
          to: newState,
        });

        res.json({
          mastery: {
            knowledgeId,
            previousState,
            newState,
            transitionEventId: changed ? transitionEventId : '',
          },
          updatedOpportunity,
          record: updatedRecord,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
