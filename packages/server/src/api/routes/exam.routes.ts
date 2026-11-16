/**
 * 考试、试卷与错题记录路由。
 *
 * 分离后这些实体的所有权在服务端：
 * - 诊断结果落库为错题记录（error_records），有独立生命周期
 * - 试卷元信息区分「AI 提取」与「人工确认」两个值域
 * - 事件日志（先落业务结果，再记事件）
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { assertStudentAccess, assertStudentWriteAccess } from '../middleware/auth.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import { getCurriculumVersion } from '../../infrastructure/knowledge/curriculum.ts';
import type {
  Exam,
  ExamPaper,
  ErrorRecord,
  DiagnosedItem,
  DetectedMetadata,
} from '@daydayup/contracts';

const EXAMS_DIR = ['db', 'exams'];
const PAPERS_DIR = ['db', 'papers'];
const ERRORS_DIR = ['db', 'error-records'];
const EVENTS_DIR = ['events'];

/** 错题记录列表项（列表视图不含大字段） */
interface ErrorRecordListItem {
  id: string;
  examId?: string;
  examPaperId?: string;
  examTitle: string;
  questionNumber: string;
  subject: string;
  knowledgeId: string;
  knowledgeName: string;
  errorType: string;
  scoreLost: number;
  confidence: string;
  status: string;
  createdAt: string;
}

export function createExamRoutes(container: Container): Router {
  const router = Router();

  /**
   * POST /api/v1/exams
   * 创建考试。
   */
  router.post('/exams', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      const studentId = String(body.studentId ?? '');
      if (!studentId) {
        throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
      }
      assertStudentWriteAccess(req, studentId);

      const id = String(body.id ?? `exam-${randomUUID()}`);
      const exam: Exam = {
        id,
        title: String(body.title ?? '未命名考试'),
        type: body.type ?? '随堂诊断',
        date: String(body.date ?? new Date().toISOString().slice(0, 10)),
      };

      await container.db.write([...EXAMS_DIR, `${id}.json`], exam);
      res.json(exam);
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/v1/exams/:id */
  router.get('/exams/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exam = await container.db.read<Exam>([
        ...EXAMS_DIR,
        `${req.params.id}.json`,
      ]);
      if (!exam) {
        throw new ApiException('NOT_FOUND', '考试不存在');
      }
      res.json(exam);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/exams/:id/papers
   *
   * 保存试卷与 AI 诊断结果。
   *
   * 分离前诊断结果只在前端内存里，刷新即丢；
   * 现在落库，并区分 AI 提取值与人工确认值。
   */
  router.post(
    '/exams/:examId/papers',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body ?? {};
        const studentId = String(body.studentId ?? '');
        if (!studentId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
        }
        assertStudentWriteAccess(req, studentId);

        const examId = req.params.examId;
        const paperId = String(body.id ?? `paper-${randomUUID()}`);
        const now = new Date().toISOString();

        const paper: ExamPaper = {
          id: paperId,
          examId,
          examTitle: body.examTitle ? String(body.examTitle) : undefined,
          examType: body.examType,
          subject: body.subject ?? '数学',
          title: String(body.title ?? body.examTitle ?? '试卷'),
          date: String(body.date ?? now.slice(0, 10)),
          score: body.score !== undefined ? Number(body.score) : undefined,
          fullScore:
            body.fullScore !== undefined ? Number(body.fullScore) : undefined,
          imageUrl: body.imageUrl,
          rawText: body.rawText,
          sourceFormat: body.sourceFormat ?? '文本试卷',
          status: body.status ?? '待校验',
          totalLostScore: Number(body.totalLostScore ?? 0),
          questionsCount: Number(body.questionsCount ?? 0),
          summary: String(body.summary ?? ''),
          knowledgeIds: Array.isArray(body.knowledgeIds) ? body.knowledgeIds : [],
          createdAt: now,
          detectedMetadata: body.detectedMetadata,
        };

        await container.db.write([...PAPERS_DIR, `${paperId}.json`], paper);

        // 诊断条目 → 错题记录
        const items: DiagnosedItem[] = Array.isArray(body.diagnosedItems)
          ? body.diagnosedItems
          : [];

        const records: ErrorRecord[] = items.map((item) => ({
          id: `err-${randomUUID()}`,
          examId,
          examPaperId: paperId,
          examTitle: String(body.examTitle ?? ''),
          questionNumber: item.questionNumber,
          subject: paper.subject,
          stem: item.stem,
          studentAnswer: item.studentAnswer,
          correctAnswer: item.correctAnswer,
          scoreLost: item.scoreLost,
          errorType: item.errorType as ErrorRecord['errorType'],
          knowledgeId: item.knowledgeId,
          knowledgeName: String(body.knowledgeNameById?.[item.knowledgeId] ?? item.knowledgeId),
          aiAnalysis: item.aiAnalysis,
          evidence: item.evidence,
          confidence: item.confidence as ErrorRecord['confidence'],
          verificationMethod: item.verificationMethod,
          status: '未订正',
          createdAt: now,
        }));

        for (const record of records) {
          await container.db.write(
            [...ERRORS_DIR, studentId, `${record.id}.json`],
            record
          );
        }

        // 事件日志：先落业务结果，再记事件
        const dateKey = now.slice(0, 10);
        await container.db.append(
          [...EVENTS_DIR, `${dateKey}.jsonl`],
          JSON.stringify({
            event_id: `evt_${randomUUID()}`,
            event_type: 'DiagnosisCompleted',
            aggregate_id: studentId,
            occurred_at: now,
            payload: {
              examId,
              paperId,
              errorCount: records.length,
              totalLostScore: paper.totalLostScore,
              curriculumVersion: getCurriculumVersion(),
            },
          })
        );

        logger.info('diagnosis.persisted', {
          requestId: req.requestId,
          studentId,
          examId,
          paperId,
          errorCount: records.length,
        });

        res.json({ paper, errorRecords: records });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/exams
   *
   * 学生的考试列表（报告页的场次筛选、存档库的场次名回填用）。
   */
  router.get(
    '/students/:id/exams',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);

        const examIds = await container.db.list(EXAMS_DIR);
        const exams: Exam[] = [];

        for (const fileId of examIds) {
          const exam = await container.db.read<Exam>([
            ...EXAMS_DIR,
            fileId.replace(/\.json$/, ''),
          ]);
          if (exam) exams.push(exam);
        }

        exams.sort((a, b) => (a.date < b.date ? 1 : -1));
        res.json({ exams, total: exams.length });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/papers
   *
   * 试卷存档库列表（产品验收 TC-08）。
   *
   * 每份诊断过的试卷独立留存：元信息、五维错因分布、涉及知识点、
   * 原始文本/图像引用。
   */
  router.get(
    '/students/:id/papers',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const paperIds = await container.db.list(PAPERS_DIR);
        const papers: ExamPaper[] = [];

        for (const fileId of paperIds) {
          const paper = await container.db.read<ExamPaper>([
            ...PAPERS_DIR,
            fileId.replace(/\.json$/, ''),
          ]);
          if (!paper) continue;
          papers.push(paper);
        }

        // 按创建时间倒序（最近诊断的在前）
        papers.sort((a, b) =>
          (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1
        );

        // 附带错因分布与关联错题数量
        const errorIds = await container.db.list([...ERRORS_DIR, studentId]);
        const records: ErrorRecord[] = [];
        for (const id of errorIds) {
          const record = await container.db.read<ErrorRecord>([
            ...ERRORS_DIR,
            studentId,
            id.replace(/\.json$/, ''),
          ]);
          if (record) records.push(record);
        }

        const enriched = papers.map((paper) => {
          const related = records.filter(
            (r) =>
              r.examPaperId === paper.id ||
              (r.examId === paper.examId && r.subject === paper.subject)
          );

          // 五维错因分布
          const errorTypeCounts = related.reduce<
            Record<string, number>
          >((acc, r) => {
            acc[r.errorType] = (acc[r.errorType] ?? 0) + 1;
            return acc;
          }, {});

          return {
            ...paper,
            errorRecordCount: related.length,
            errorTypeCounts,
          };
        });

        res.json({ papers: enriched, total: enriched.length });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/students/:id/papers/:paperId
   *
   * 单份试卷的完整存档（含关联错题明细）。
   */
  router.get(
    '/students/:id/papers/:paperId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentAccess(req, studentId);

        const paper = await container.db.read<ExamPaper>([
          ...PAPERS_DIR,
          req.params.paperId,
        ]);
        if (!paper) {
          throw new ApiException('NOT_FOUND', '试卷不存在');
        }

        const errorIds = await container.db.list([...ERRORS_DIR, studentId]);
        const records: ErrorRecord[] = [];
        for (const id of errorIds) {
          const record = await container.db.read<ErrorRecord>([
            ...ERRORS_DIR,
            studentId,
            id.replace(/\.json$/, ''),
          ]);
          if (record) records.push(record);
        }

        const related = records.filter(
          (r) =>
            r.examPaperId === paper.id ||
            (r.examId === paper.examId && r.subject === paper.subject)
        );

        res.json({ paper, errorRecords: related });
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/exam-results
   *
   * 学生的历次考试成绩（报告页的「成绩趋势对比矩阵」用）。
   */
  router.get(
    '/students/:id/exam-results',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);

        const examIds = await container.db.list(EXAMS_DIR);
        const paperIds = await container.db.list(PAPERS_DIR);
        const results: Array<Record<string, unknown>> = [];

        for (const examFileId of examIds) {
          const exam = await container.db.read<Exam>([
            ...EXAMS_DIR,
            examFileId.replace(/\.json$/, ''),
          ]);
          if (!exam) continue;

          for (const paperFileId of paperIds) {
            const paper = await container.db.read<ExamPaper>([
              ...PAPERS_DIR,
              paperFileId.replace(/\.json$/, ''),
            ]);
            if (!paper || paper.examId !== exam.id) continue;

            results.push({
              id: `res-${paper.id}`,
              examId: exam.id,
              examTitle: paper.examTitle ?? exam.title,
              subject: paper.subject,
              score: paper.score ?? 0,
              fullScore: paper.fullScore ?? 100,
              targetScore: paper.score ?? 0,
              date: paper.date,
            });
          }
        }

        results.sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
        res.json({ results, total: results.length });
      } catch (err) {
        next(err);
      }
    }
  );

  /** GET /api/v1/students/:id/error-records */
  router.get(
    '/students/:id/error-records',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const studentId = req.params.id;

        const ids = await container.db.list([...ERRORS_DIR, studentId]);
        const records: ErrorRecord[] = [];
        for (const fileId of ids) {
          const record = await container.db.read<ErrorRecord>([
            ...ERRORS_DIR,
            studentId,
            fileId.replace(/\.json$/, ''),
          ]);
          if (record) records.push(record);
        }

        records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        const list: ErrorRecordListItem[] = records.map((r) => ({
          id: r.id,
          examId: r.examId,
          examPaperId: r.examPaperId,
          examTitle: r.examTitle,
          questionNumber: r.questionNumber,
          subject: r.subject,
          knowledgeId: r.knowledgeId,
          knowledgeName: r.knowledgeName,
          errorType: r.errorType,
          scoreLost: r.scoreLost,
          confidence: r.confidence,
          status: r.status,
          createdAt: r.createdAt,
        }));

        res.json({ records, total: records.length });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/error-records/:studentId/:id
   *
   * 更新错题记录状态（订正 / 闭环）与备注。
   */
  router.patch(
    '/error-records/:studentId/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { studentId, id } = req.params;
        assertStudentWriteAccess(req, studentId);
        const body = req.body ?? {};

        const existing = await container.db.read<ErrorRecord>([
          ...ERRORS_DIR,
          studentId,
          `${id}.json`,
        ]);
        if (!existing) {
          throw new ApiException('NOT_FOUND', '错题记录不存在');
        }

        const updated: ErrorRecord = {
          ...existing,
          status: body.status ?? existing.status,
          correctionNote: body.correctionNote ?? existing.correctionNote,
        };

        await container.db.write([...ERRORS_DIR, studentId, `${id}.json`], updated);

        await container.audit.record('ErrorRecordUpdated', {
          aggregateId: id,
          actor: req.auth?.principalId,
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: { studentId, status: updated.status },
        });

        const now = new Date().toISOString();
        await container.db.append(
          [...EVENTS_DIR, `${now.slice(0, 10)}.jsonl`],
          JSON.stringify({
            event_id: `evt_${randomUUID()}`,
            event_type: 'ErrorRecordUpdated',
            aggregate_id: studentId,
            occurred_at: now,
            payload: { recordId: id, status: updated.status },
          })
        );

        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/papers/:id/confirm-metadata
   *
   * 人工确认 AI 提取的考试元信息。
   * 分离前人工在 UI 上改了值就直接丢，没有数据结构承载「确认后的覆盖值」。
   */
  router.patch(
    '/papers/:id/confirm-metadata',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body ?? {};
        const studentId = String(body.studentId ?? '');
        if (!studentId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 studentId');
        }
        assertStudentWriteAccess(req, studentId);

        const existing = await container.db.read<ExamPaper>([
          ...PAPERS_DIR,
          `${req.params.id}.json`,
        ]);
        if (!existing) {
          throw new ApiException('NOT_FOUND', '试卷不存在');
        }

        const confirmed: Partial<DetectedMetadata> = body.confirmedMetadata ?? {};
        const updated: ExamPaper = {
          ...existing,
          status: '已识别',
          confirmedMetadata: {
            subject: String(confirmed.subject ?? existing.subject),
            examTitle: String(confirmed.examTitle ?? ''),
            examType: String(confirmed.examType ?? ''),
            examDate: String(confirmed.examDate ?? ''),
            score: Number(confirmed.score ?? 0),
            fullScore: Number(confirmed.fullScore ?? 0),
            metadataConfidence: '确定',
          },
        };

        await container.db.write([...PAPERS_DIR, `${existing.id}.json`], updated);

        await container.audit.record('PaperMetadataConfirmed', {
          aggregateId: existing.id,
          actor: req.auth?.principalId,
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: { studentId },
        });

        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
