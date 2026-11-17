/**
 * 服务端状态水合（核心逻辑）。
 *
 * 与 `hydrate.ts` 的 React Hook 分离：
 * 水合的实质是「并发拉 7 类数据 → 逐个合并进状态」，
 * 其中藏着顺序耦合的坑（某个列表为空就提前 return，
 * 导致后续数据全不加载）。把逻辑抽成独立函数才好测。
 */
import type { AppState } from '@daydayup/contracts';
import { api } from '../api/client.ts';

export interface MasteryResponse {
  records: Record<string, AppState['masteryRecords'][string]>;
}

export interface MasteryHistoryResponse {
  history: AppState['masteryHistory'];
}

export interface ErrorRecordsResponse {
  records: Array<Partial<AppState['errorRecords'][number]>>;
}

export interface AttemptsResponse {
  attempts: Array<Partial<AppState['learningAttempts'][number]>>;
}

export interface ExamResultsResponse {
  results: Array<Partial<AppState['examResults'][number]>>;
}

export interface ExamsResponse {
  exams: Array<Partial<AppState['exams'][number]>>;
}

export interface PapersResponse {
  papers: Array<
    Partial<AppState['examPapers'][number]> & {
      errorRecordCount?: number;
      errorTypeCounts?: Record<string, number>;
    }
  >;
}

/** 一次水合的结果：哪些数据被成功写入 */
export interface HydrationResult {
  /** 成功加载的数据类别 */
  loaded: string[];
  /** 加载失败的数据类别 */
  failed: string[];
}

/**
 * 从服务端拉取并合并学生数据。
 *
 * 关键语义：
 * 1. **各类数据互相独立** —— 任一接口失败不应影响其它类别
 * 2. **空列表也要写回** —— 「没有错题」是有效状态，不是「跳过」
 * 3. **不覆盖已有数据** —— 合并而非替换（掌握度用 {...prev, ...new}）
 *
 * @param studentId 学生 ID
 * @param setAppState 状态更新函数（React 的 setState）
 * @param knowledgeMap 知识点名映射（用于补全错题的知识点名称）
 */
export async function hydrateFromServer(
  studentId: string,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>,
  knowledgeMap: Record<string, { name?: string }> = {},
  isCancelled: () => boolean = () => false
): Promise<HydrationResult> {
  const loaded: string[] = [];
  const failed: string[] = [];

  /** 统一的「取一份数据并合并」helper */
  const load = async <K extends keyof AppState>(
    kind: string,
    path: string,
    merge: (prev: AppState, payload: unknown) => AppState
  ): Promise<void> => {
    try {
      const payload = await api.get<unknown>(path);
      if (isCancelled()) return;
      setAppState((prev) => merge(prev, payload));
      loaded.push(kind);
    } catch {
      // 单类失败不影响其它类别 —— 服务端不可用时保留骨架
      failed.push(kind);
    }
  };

  // ---- 掌握度（服务端权威）----
  await load('mastery', `/api/v1/students/${studentId}/mastery`, (prev, payload) => {
    const records = (payload as MasteryResponse)?.records ?? {};
    return {
      ...prev,
      masteryRecords: { ...prev.masteryRecords, ...records },
    };
  });

  // ---- 掌握度迁移历史 ----
  await load('masteryHistory', `/api/v1/students/${studentId}/mastery/history`, (prev, payload) => {
    const history = (payload as MasteryHistoryResponse)?.history ?? [];
    return { ...prev, masteryHistory: history };
  });

  // ---- 错题记录 ----
  await load('errorRecords', `/api/v1/students/${studentId}/error-records`, (prev, payload) => {
    const records = (payload as ErrorRecordsResponse)?.records ?? [];
    return {
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
    };
  });

  // ---- 作答流水 ----
  await load('learningAttempts', `/api/v1/students/${studentId}/attempts`, (prev, payload) => {
    const list = (payload as AttemptsResponse)?.attempts ?? [];
    return {
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
    };
  });

  // ---- 考试场次列表 ----
  await load('exams', `/api/v1/students/${studentId}/exams`, (prev, payload) => {
    const list = (payload as ExamsResponse)?.exams ?? [];
    return {
      ...prev,
      exams: list.map((e, idx) => ({
        id: e.id ?? `exam-${idx}`,
        title: e.title ?? '未命名考试',
        type: e.type ?? '随堂诊断',
        date: e.date ?? '',
      })),
    };
  });

  // ---- 试卷存档库（TC-08）----
  await load('examPapers', `/api/v1/students/${studentId}/papers`, (prev, payload) => {
    const list = (payload as PapersResponse)?.papers ?? [];
    return {
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
    };
  });

  // ---- 考试成绩 ----
  await load('examResults', `/api/v1/students/${studentId}/exam-results`, (prev, payload) => {
    const list = (payload as ExamResultsResponse)?.results ?? [];
    return {
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
    };
  });

  return { loaded, failed };
}

/**
 * 重新拉取**服务端权威**的掌握度与掌握轨迹。
 *
 * 用途：诊断落库后，服务端会更新 MasteryRecord 并写入迁移事件
 * （见 packages/server/src/api/routes/exam.routes.ts）。
 * 前端此前的乐观更新只是「界面即时反馈」，最终值必须以服务端为准 ——
 * 这正是契约要求的「状态迁移规则属服务端 MasteryEngine，前端不得本地推导」。
 *
 * @param studentId 学生 ID
 * @param setAppState 状态更新函数
 * @returns 是否成功刷新
 */
export async function refreshMasteryFromServer(
  studentId: string,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
): Promise<boolean> {
  try {
    const [masteryPayload, historyPayload] = await Promise.all([
      api.get<MasteryResponse>(`/api/v1/students/${studentId}/mastery`),
      api.get<MasteryHistoryResponse>(
        `/api/v1/students/${studentId}/mastery/history`
      ),
    ]);

    const records = masteryPayload?.records ?? {};
    const history = historyPayload?.history ?? [];

    setAppState((prev) => ({
      ...prev,
      masteryRecords: { ...prev.masteryRecords, ...records },
      masteryHistory: history,
    }));
    return true;
  } catch {
    // 刷新失败时保留乐观更新，不阻断界面
    return false;
  }
}
