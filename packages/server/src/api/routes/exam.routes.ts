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
import { sanitizeSegment } from '../../infrastructure/persistence/file-database.ts';
import { applyDiagnosisMastery } from '../../modules/mastery/mastery-service.ts';
import type {
  Exam,
  ExamPaper,
  ExamResult,
  ErrorRecord,
  DiagnosedItem,
  DetectedMetadata,
  Subject,
} from '@daydayup/contracts';

const EXAMS_DIR = ['db', 'exams'];
const PAPERS_DIR = ['db', 'papers'];
const ERRORS_DIR = ['db', 'error-records'];
const RESULTS_DIR = ['db', 'exam-results'];
const EVENTS_DIR = ['events'];

/**
 * 构造考试/试卷文件路径。
 *
 * 关键：`:id` 来自 URL，**必须清洗** ——
 * 否则 `id=../credentials` 会写到 `db/credentials.json`。
 */
function entityPath(dir: string[], id: string): string[] {
  return [...dir, `${sanitizeSegment(id)}.json`];
}

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
      const exam = await container.db.read<Exam>(
        entityPath(EXAMS_DIR, req.params.id)
      );
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
          // 持久化归属 —— 修改元信息时要据此校验「这张卷属于谁」
          studentId,
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

        /**
         * 诊断条目 → 错题记录。
         *
         * **受控词表归一化**：五维错因与置信度是规格定义的枚举
         * （§模块01 §2），前端可以传任意字符串，服务端必须归一化，
         * 否则报告页的「五维错因占比统计」会出现规格外的分类。
         *
         * 未知取值降级为最保守的档位（错因→知识问题、置信度→待验证），
         * 而不是直接落库。
         */
        const ERROR_TYPES_ALLOWED: ErrorRecord['errorType'][] = [
          '知识问题',
          '方法问题',
          '计算问题',
          '熟练度问题',
          '审题问题',
        ];
        const CONFIDENCE_ALLOWED: ErrorRecord['confidence'][] = [
          '确定',
          '较可能',
          '待验证',
        ];

        const records: ErrorRecord[] = items.map((item) => {
          const rawErrorType = String(item.errorType ?? '');
          const rawConfidence = String(item.confidence ?? '');
          const errorType = ERROR_TYPES_ALLOWED.includes(
            rawErrorType as ErrorRecord['errorType']
          )
            ? (rawErrorType as ErrorRecord['errorType'])
            : '知识问题';
          const confidence = CONFIDENCE_ALLOWED.includes(
            rawConfidence as ErrorRecord['confidence']
          )
            ? (rawConfidence as ErrorRecord['confidence'])
            : '待验证';

          return {
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
            errorType,
            knowledgeId: item.knowledgeId,
            knowledgeName: String(
              body.knowledgeNameById?.[item.knowledgeId] ?? item.knowledgeId
            ),
            aiAnalysis: item.aiAnalysis,
            evidence: item.evidence,
            confidence,
            verificationMethod: item.verificationMethod,
            status: '未订正',
            createdAt: now,
          };
        });

        for (const record of records) {
          await container.db.write(
            [...ERRORS_DIR, studentId, `${record.id}.json`],
            record
          );
        }

        /**
         * 诊断失分 → 服务端更新 MasteryRecord（服务端权威）。
         *
         * 规格 TC-01：「新增对应 ErrorRecord 并**更新相关知识点 MasteryRecord**
         * 与 7 天排序」。
         *
         * 此前这一步只发生在**前端**（web/src/App.tsx 本地推导 nextState），
         * 服务端完全没写 —— 于是：
         * - 刷新页面后失分证据全部丢失；
         * - 服务端的 7 天排序（读 db/mastery/{studentId}.json）看不到任何诊断结果，
         *   「诊断 → 提分规划」闭环在服务端是断的；
         * - 违反契约明文约束「状态迁移规则属服务端 MasteryEngine，前端不得本地推导」。
         *
         * 现在下沉到服务端：
         * - 同一知识点的多条失分**先聚合**再应用一次迁移，
         *   避免同一知识点在一次诊断里被多次回退（状态跳变失真）；
         * - 迁移事件写入同一份 mastery history，报告页「掌握轨迹」得以还原。
         */
        const lossByKnowledge = new Map<
          string,
          { scoreLost: number; evidence: string[]; confidence: ErrorRecord['confidence'] }
        >();

        for (const record of records) {
          const existing = lossByKnowledge.get(record.knowledgeId);
          const evidence = `${record.examTitle || paper.title} ${record.questionNumber}（-${record.scoreLost}分，${record.errorType}）`;
          if (existing) {
            existing.scoreLost += record.scoreLost;
            existing.evidence.push(evidence);
            /**
             * 同一知识点多条失分时，置信度取**最低** ——
             * 证据互相印证则置信度上升，但不应由前端自报覆盖。
             */
            if (record.confidence === '待验证') existing.confidence = '待验证';
            else if (record.confidence === '较可能') {
              existing.confidence =
                existing.confidence === '确定' ? '确定' : '较可能';
            }
          } else {
            lossByKnowledge.set(record.knowledgeId, {
              scoreLost: record.scoreLost,
              evidence: [evidence],
              confidence: record.confidence,
            });
          }
        }

        const masteryUpdates: Array<{
          knowledgeId: string;
          fromState: string;
          toState: string;
        }> = [];

        for (const [knowledgeId, loss] of lossByKnowledge) {
          try {
            const transition = await applyDiagnosisMastery(container, {
              studentId,
              knowledgeId,
              scoreLost: loss.scoreLost,
              evidenceSummary: loss.evidence.join('；'),
              subject: paper.subject,
              confidence: loss.confidence,
            });
            if (transition.changed) {
              masteryUpdates.push({
                knowledgeId,
                fromState: transition.fromState,
                toState: transition.toState,
              });
            }
          } catch (err) {
            /**
             * 掌握度更新失败**不能阻断试卷落库** ——
             * 试卷与错题是诊断的主产物，先落库再补掌握度。
             * 但必须留下日志，否则这类偏差会静默存在。
             */
            logger.error('diagnosis.mastery_update_failed', {
              requestId: req.requestId,
              studentId,
              knowledgeId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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
              masteryUpdates,
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

        res.json({ paper, errorRecords: records, masteryUpdates });
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
   *
   * 数据来源有两处，**都要保留**：
   * 1. 显式录入的成绩基线（`db/exam-results/{studentId}/{id}.json`）——
   *    这里才有独立的 `targetScore`（目标分）。
   * 2. 从试卷（ExamPaper）派生的成绩 —— 诊断时同步了卷面分数的试卷。
   *
   * 此前只有第 2 条路径，且 `targetScore` 被直接抄成 `score`，
   * 导致「距离目标分差值」恒为 0（规格 §模块06 第三层评估的核心指标失效）。
   * 现在显式录入的记录优先，targetScore 保持独立。
   */
  router.get(
    '/students/:id/exam-results',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertStudentAccess(req, req.params.id);
        const studentId = req.params.id;

        const results: ExamResult[] = [];

        // ---- 1. 显式录入的成绩基线（targetScore 独立）----
        const storedIds = await container.db.list([...RESULTS_DIR, studentId]);
        for (const fileId of storedIds) {
          const stored = await container.db.read<ExamResult>([
            ...RESULTS_DIR,
            studentId,
            fileId.replace(/\.json$/, ''),
          ]);
          if (stored) results.push(stored);
        }

        // ---- 2. 从试卷派生的成绩（不与显式记录重复）----
        const recordedKeys = new Set(
          results.map((r) => `${r.examId}::${r.subject}`)
        );
        const examIds = await container.db.list(EXAMS_DIR);
        const paperIds = await container.db.list(PAPERS_DIR);
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

            const key = `${exam.id}::${paper.subject}`;
            if (recordedKeys.has(key)) continue;

            results.push({
              id: `res-${paper.id}`,
              examId: exam.id,
              examTitle: paper.examTitle ?? exam.title,
              subject: paper.subject,
              score: paper.score ?? 0,
              fullScore: paper.fullScore ?? 100,
              /**
               * 未显式录入目标分时，用卷面满分的一个保守默认值，
               * 而不是抄成实际分 —— 后者会让「目标分差值」恒为 0。
               */
              targetScore: Math.round((paper.fullScore ?? 100) * 0.9),
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

  /** POST /api/v1/students/:id/exam-results
   *
   * 录入 / 更新一条成绩基线。
   *
   * 规格 §模块06 第三层：「全科历次考试成绩趋势对比矩阵（跨月考/期中/模考横向变化）、
   * 距离目标分差值」—— 这要求 `targetScore` 是**独立数据**，
   * 此前既没有写入端点也没有存储，读时只能从试卷现场合成。
   *
   * 同一 (examId, subject) 重复录入时**覆盖**而非追加，
   * 避免成绩矩阵出现重复列。
   */
  router.post(
    '/students/:id/exam-results',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const studentId = req.params.id;
        assertStudentWriteAccess(req, studentId);
        const body = req.body ?? {};

        const examId = String(body.examId ?? '').trim();
        const subject = String(body.subject ?? '').trim() as Subject;
        if (!examId) {
          throw new ApiException('VALIDATION_FAILED', '缺少 examId');
        }
        if (!subject) {
          throw new ApiException('VALIDATION_FAILED', '缺少 subject');
        }

        const score = Number(body.score);
        const fullScore = Number(body.fullScore ?? 100);
        if (!Number.isFinite(score)) {
          throw new ApiException('VALIDATION_FAILED', '成绩必须是数字');
        }
        if (!Number.isFinite(fullScore) || fullScore <= 0) {
          throw new ApiException('VALIDATION_FAILED', '满分必须大于 0');
        }

        const targetScore = Number(
          body.targetScore ?? Math.round(fullScore * 0.9)
        );
        if (!Number.isFinite(targetScore)) {
          throw new ApiException('VALIDATION_FAILED', '目标分必须是数字');
        }

        // 同一 (examId, subject) 覆盖写入
        const existingIds = await container.db.list([
          ...RESULTS_DIR,
          studentId,
        ]);
        let resultId = `res-${randomUUID()}`;
        for (const fileId of existingIds) {
          const stored = await container.db.read<ExamResult>([
            ...RESULTS_DIR,
            studentId,
            fileId.replace(/\.json$/, ''),
          ]);
          if (stored && stored.examId === examId && stored.subject === subject) {
            resultId = stored.id;
            break;
          }
        }

        const record: ExamResult = {
          id: resultId,
          examId,
          examTitle: String(
            body.examTitle ??
              (await container.db.read<Exam>([
                ...EXAMS_DIR,
                sanitizeSegment(examId),
              ]))?.title ??
              examId
          ),
          subject,
          score,
          fullScore,
          targetScore,
          date: String(body.date ?? new Date().toISOString().slice(0, 10)),
        };

        await container.db.write(
          [...RESULTS_DIR, studentId, `${sanitizeSegment(resultId)}.json`],
          record
        );

        await container.audit.record('ExamResultRecorded', {
          aggregateId: resultId,
          actor: req.auth?.principalId,
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: { studentId, examId, subject, score, targetScore },
        });

        logger.info('exam.result_recorded', {
          requestId: req.requestId,
          studentId,
          examId,
          subject,
          score,
          targetScore,
        });

        res.json({ result: record });
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

        /**
         * 状态白名单校验。
         *
         * 服务端必须校验状态取值 —— 否则任意字符串都能被写进
         * ErrorRecord.status，报告页的筛选与统计随之失真。
         */
        const ALLOWED_ERROR_STATUSES: ErrorRecord['status'][] = [
          '未订正',
          '已订正',
          '待复测',
          '已闭环',
        ];
        const nextStatus = (body.status ?? existing.status) as ErrorRecord['status'];
        if (!ALLOWED_ERROR_STATUSES.includes(nextStatus)) {
          throw new ApiException(
            'VALIDATION_FAILED',
            `非法的错题状态：${String(body.status)}（允许值：${ALLOWED_ERROR_STATUSES.join(' / ')}）`
          );
        }

        const updated: ErrorRecord = {
          ...existing,
          status: nextStatus,
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

        const existing = await container.db.read<ExamPaper>(
          entityPath(PAPERS_DIR, req.params.id)
        );
        if (!existing) {
          throw new ApiException('NOT_FOUND', '试卷不存在');
        }

        /**
         * 关键：必须校验**试卷的实际归属**，而不是请求体里的 studentId。
         *
         * 请求体的 studentId 是调用方自述的，可以随便填 ——
         * 学生 A 填自己的 studentId、却把请求打到学生 B 的试卷上，
         * 就能改掉 B 的卷面元信息（学科、考试名、分数）。
         *
         * `assertStudentWriteAccess` 只验证「调用方能否写 studentId」，
         * 与「这张卷属于谁」是两件事，必须分别校验。
         */
        const ownerId = existing.studentId ?? studentId;
        assertStudentWriteAccess(req, ownerId);

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
