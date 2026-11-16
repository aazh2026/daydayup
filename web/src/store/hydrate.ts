/**
 * 服务端状态水合。
 *
 * 分离后服务端是唯一真相源：应用启动时从服务端拉取
 * 掌握度、错题记录、教练会话，覆盖本地缓存。
 *
 * 设计：本地 localStorage 仅作为「乐观缓存 + 离线兜底」，
 * 服务端数据到达后即被权威值覆盖。
 */
import { useEffect } from 'react';
import type { AppState } from '@daydayup/contracts';
import { api } from '../api/client.ts';
import { useCurriculum } from './curriculum.tsx';

interface MasteryResponse {
  records: Record<string, AppState['masteryRecords'][string]>;
}

interface ErrorRecordsResponse {
  records: Array<Partial<AppState['errorRecords'][number]>>;
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
      // ---- 掌握度（服务端权威） ----
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
        // 服务端不可用：保留本地缓存
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
        // 服务端不可用：保留本地缓存
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studentId, knowledgeMap, setAppState]);
}
