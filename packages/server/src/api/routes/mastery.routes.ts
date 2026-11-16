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
import {
  evaluateMasteryTransition,
  buildTransitionEvent,
} from '../../engines/mastery-engine.ts';
import { getDelayedRetestStatus } from '../../engines/planning-engine.ts';
import { computePriorityOpportunities } from '../../engines/planning-engine.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import type {
  MasteryRecord,
  MasteryTransitionEvent,
  PracticeMode,
} from '@daydayup/contracts';

const MASTERY_DIR = ['db', 'mastery'];

interface MasteryAggregate {
  studentId: string;
  records: Record<string, MasteryRecord>;
  history: MasteryTransitionEvent[];
  lastComputedAt: string;
}

async function readAggregate(
  container: Container,
  studentId: string
): Promise<MasteryAggregate> {
  const stored = await container.db.read<MasteryAggregate>([
    ...MASTERY_DIR,
    `${studentId}.json`,
  ]);
  return (
    stored ?? {
      studentId,
      records: {},
      history: [],
      lastComputedAt: new Date().toISOString(),
    }
  );
}

async function writeAggregate(
  container: Container,
  aggregate: MasteryAggregate
): Promise<void> {
  aggregate.lastComputedAt = new Date().toISOString();
  await container.db.write(
    [...MASTERY_DIR, `${aggregate.studentId}.json`],
    aggregate
  );
}

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

        const aggregate = await readAggregate(container, studentId);
        const current: MasteryRecord = aggregate.records[knowledgeId] ?? {
          knowledgeId,
          state: '未诊断',
          confidence: '待验证',
          lostScoreEvidence: 0,
          recoveryProbability: 0.5,
          evidenceLogs: [],
          consecutiveErrors: 0,
          practiceCorrect: 0,
          practiceTotal: 0,
          variantPassed: false,
          delayedRetestPassed: false,
          updatedAt: new Date().toISOString(),
        };

        const transition = evaluateMasteryTransition({
          current,
          mode,
          isCorrect,
          evidenceSummary,
        });

        aggregate.records[knowledgeId] = transition.record;

        if (transition.changed) {
          const event = buildTransitionEvent({
            id: `mte_${randomUUID()}`,
            knowledgeId,
            subject: String(body.subject ?? '数学'),
            fromState: transition.fromState,
            toState: transition.toState,
            trigger: `${mode}: ${evidenceSummary}`.slice(0, 200),
          });
          aggregate.history.unshift(event);
          // 历史上限，避免文件无限增长
          aggregate.history = aggregate.history.slice(0, 200);
        }

        await writeAggregate(container, aggregate);

        // 追加作答事件（先落业务结果，再记事件）
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
            timestamp: new Date().toISOString(),
          })
        );

        const opportunities = computePriorityOpportunities(aggregate.records);
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
            from: transition.fromState,
            to: transition.toState,
            mode,
            isCorrect,
          },
        });

        logger.info('mastery.transition', {
          requestId: req.requestId,
          studentId,
          knowledgeId,
          from: transition.fromState,
          to: transition.toState,
        });

        res.json({
          mastery: {
            knowledgeId,
            previousState: transition.fromState,
            newState: transition.toState,
            transitionEventId:
              transition.changed ? aggregate.history[0]?.id ?? '' : '',
          },
          updatedOpportunity,
          record: transition.record,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
