/**
 * 服务端状态水合。
 *
 * 分离后服务端是唯一真相源：应用启动时从服务端拉取
 * 掌握度、掌握度历史、错题记录、作答流水、考试成绩，
 * 覆盖本地骨架。
 *
 * 设计：本地不再持久化业务数据（见 store/local-state.ts），
 * localStorage 仅作 token / UI 偏好 / 只读快照。
 */
import { useEffect } from 'react';
import type { AppState } from '@daydayup/contracts';
import { api } from '../api/client.ts';
import { useCurriculum } from './curriculum.tsx';

interface MasteryResponse {
  records: Record<string, AppState['masteryRecords'][string]>;
}

interface MasteryHistoryResponse {
  history: AppState['masteryHistory'];
}

interface ErrorRecordsResponse {
  records: Array<Partial<AppState['errorRecords'][number]>>;
}

interface AttemptsResponse {
  attempts: Array<Partial<AppState['learningAttempts'][number]>>;
}

interface ExamResultsResponse {
  results: Array<Partial<AppState['examResults'][number]>>;
}

interface ExamsResponse {
  exams: Array<Partial<AppState['exams'][number]>>;
}

interface PapersResponse {
  papers: Array<
    Partial<AppState['examPapers'][number]> & {
      errorRecordCount?: number;
      errorTypeCounts?: Record<string, number>;
    }
  >;
}

export function useServerHydration(
  studentId: string | undefined,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
): void {
  const { knowledgeMap } = useCurriculum();

  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;

    void (async () => {
      // ---- 掌握度（服务端权威）----
      try {
        const mastery = await api.get<MasteryResponse>(
          `/api/v1/students/${studentId}/mastery`
        );
        if (cancelled) return;
        setAppState((prev) => ({
          ...prev,
          masteryRecords: {
            ...prev.masteryRecords,
            ...(mastery.records ?? {}),
          },
        }));
      } catch {
        // 服务端不可用：保留骨架
      }

      // ---- 掌握度迁移历史 ----
      try {
        const history = await api.get<MasteryHistoryResponse>(
          `/api/v1/students/${studentId}/mastery/history`
        );
        if (cancelled) return;
        setAppState((prev) => ({
          ...prev,
          masteryHistory: history.history ?? [],
        }));
      } catch {
        // 忽略
      }

      // ---- 错题记录 ----
      try {
        const errors = await api.get<ErrorRecordsResponse>(
          `/api/v1/students/${studentId}/error-records`
        );
        if (cancelled) return;
        const records = errors.records ?? [];
        if (records.length === 0) return;

        setAppState((prev) => ({
          ...prev,
          errorRecords: records.map((r, idx) => ({
            id: r.id ?? `err-${idx}`,
            examId: r.examId,
            examPaperId: r.examPaperId,
            examTitle: r.examTitle ?? '',
            questionNumber: r.questionNumber ?? '',
            subject: r.subject ?? '数学',
            stem: r.stem ?? '',
            studentAnswer: r.studentAnswer ?? '',
            correctAnswer: r.correctAnswer ?? '',
            scoreLost: r.scoreLost ?? 0,
            errorType: r.errorType ?? '知识问题',
            knowledgeId: r.knowledgeId ?? '',
            knowledgeName:
              r.knowledgeName ??
              knowledgeMap[r.knowledgeId ?? '']?.name ??
              r.knowledgeId ??
              '',
            aiAnalysis: r.aiAnalysis ?? '',
            evidence: r.evidence ?? '',
            confidence: r.confidence ?? '较可能',
            verificationMethod: r.verificationMethod ?? '',
            status: r.status ?? '未订正',
            correctionNote: r.correctionNote,
            createdAt: r.createdAt ?? new Date().toISOString(),
          })),
        }));
      } catch {
        // 忽略
      }

      // ---- 作答流水 ----
      try {
        const attempts = await api.get<AttemptsResponse>(
          `/api/v1/students/${studentId}/attempts`
        );
        if (cancelled) return;
        const list = attempts.attempts ?? [];

        setAppState((prev) => ({
          ...prev,
          learningAttempts: list.map((a, idx) => ({
            id: a.id ?? `att-${idx}`,
            taskId: a.taskId,
            knowledgeId: a.knowledgeId ?? '',
            subject: a.subject ?? '数学',
            mode: a.mode ?? '基础练习',
            questionStem: a.questionStem ?? '',
            userAnswer: a.userAnswer ?? '',
            isCorrect: a.isCorrect ?? false,
            hintsUsed: a.hintsUsed ?? 0,
            timeSpentSeconds: a.timeSpentSeconds ?? 0,
            independent: a.independent ?? false,
            aiFeedback: a.aiFeedback ?? '',
            timestamp: a.timestamp ?? new Date().toISOString(),
          })),
        }));
      } catch {
        // 忽略
      }

      // ---- 考试场次列表 ----
      try {
        const exams = await api.get<ExamsResponse>(
          `/api/v1/students/${studentId}/exams`
        );
        if (cancelled) return;
        const list = exams.exams ?? [];

        setAppState((prev) => ({
          ...prev,
          exams: list.map((e, idx) => ({
            id: e.id ?? `exam-${idx}`,
            title: e.title ?? '未命名考试',
            type: e.type ?? '随堂诊断',
            date: e.date ?? '',
          })),
        }));
      } catch {
        // 忽略
      }

      // ---- 试卷存档库（TC-08）----
      try {
        const papers = await api.get<PapersResponse>(
          `/api/v1/students/${studentId}/papers`
        );
        if (cancelled) return;
        const list = papers.papers ?? [];

        setAppState((prev) => ({
          ...prev,
          examPapers: list.map((p, idx) => ({
            id: p.id ?? `paper-${idx}`,
            examId: p.examId ?? '',
            examTitle: p.examTitle,
            examType: p.examType,
            subject: p.subject ?? '数学',
            title: p.title ?? p.examTitle ?? '试卷',
            date: p.date ?? (p.createdAt ?? '').slice(0, 10),
            score: p.score,
            fullScore: p.fullScore,
            imageUrl: p.imageUrl,
            rawText: p.rawText,
            sourceFormat: p.sourceFormat,
            status: p.status ?? '待校验',
            totalLostScore: p.totalLostScore ?? 0,
            questionsCount: p.questionsCount ?? 0,
            summary: p.summary ?? '',
            knowledgeIds: p.knowledgeIds ?? [],
            createdAt: p.createdAt,
          })),
        }));
      } catch {
        // 忽略
      }

      // ---- 考试成绩 ----
      try {
        const examResults = await api.get<ExamResultsResponse>(
          `/api/v1/students/${studentId}/exam-results`
        );
        if (cancelled) return;
        const list = examResults.results ?? [];

        setAppState((prev) => ({
          ...prev,
          examResults: list.map((r, idx) => ({
            id: r.id ?? `res-${idx}`,
            examId: r.examId ?? '',
            examTitle: r.examTitle ?? '',
            subject: r.subject ?? '数学',
            score: r.score ?? 0,
            fullScore: r.fullScore ?? 100,
            targetScore: r.targetScore ?? 0,
            date: r.date ?? '',
          })),
        }));
      } catch {
        // 忽略
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studentId, knowledgeMap, setAppState]);
}
