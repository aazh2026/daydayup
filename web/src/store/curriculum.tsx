/**
 * 知识体系 Context。
 *
 * 分离后知识体系是服务端资产：前端不再硬编码 589 行本体，
 * 改为通过 /api/v1/knowledge-points 获取并缓存。
 *
 * 缓存策略：
 * - 内存缓存（React state），一次会话只拉一次
 * - localStorage 快照兜底（离线时仍可浏览知识体系）
 * - 知识体系几乎不变，staleTime 视为无限
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { KnowledgePoint, Subject } from '@daydayup/contracts';
import { api } from '../api/client.ts';

const CACHE_KEY = 'daydayup.curriculum.snapshot';

export interface CurriculumData {
  version: string;
  knowledgePoints: KnowledgePoint[];
  /** knowledgeId → KnowledgePoint */
  knowledgeMap: Record<string, KnowledgePoint>;
  isLoading: boolean;
  error: string | null;
}

const EMPTY: CurriculumData = {
  version: '',
  knowledgePoints: [],
  knowledgeMap: {},
  isLoading: true,
  error: null,
};

const CurriculumContext = createContext<CurriculumData>(EMPTY);

function loadSnapshot(): { version: string; knowledgePoints: KnowledgePoint[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      version: string;
      knowledgePoints: KnowledgePoint[];
    };
    if (!Array.isArray(parsed.knowledgePoints) || parsed.knowledgePoints.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveSnapshot(version: string, knowledgePoints: KnowledgePoint[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version, knowledgePoints }));
  } catch {
    // 忽略配额错误
  }
}

export const CurriculumProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [data, setData] = useState<CurriculumData>(() => {
    const snapshot = loadSnapshot();
    if (!snapshot) return EMPTY;
    return {
      version: snapshot.version,
      knowledgePoints: snapshot.knowledgePoints,
      knowledgeMap: Object.fromEntries(
        snapshot.knowledgePoints.map((kp) => [kp.id, kp])
      ),
      isLoading: false,
      error: null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    void api
      .get<{ version: string; knowledgePoints: KnowledgePoint[] }>(
        '/api/v1/knowledge-points'
      )
      .then((res) => {
        if (cancelled) return;
        const knowledgePoints = res.knowledgePoints ?? [];
        saveSnapshot(res.version, knowledgePoints);
        setData({
          version: res.version,
          knowledgePoints,
          knowledgeMap: Object.fromEntries(
            knowledgePoints.map((kp) => [kp.id, kp])
          ),
          isLoading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // 拉取失败：保留本地快照（若有），否则置空
        setData((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : '知识体系加载失败',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <CurriculumContext.Provider value={data}>{children}</CurriculumContext.Provider>
  );
};

export function useCurriculum(): CurriculumData {
  return useContext(CurriculumContext);
}

/** 按学科筛选的知识点 */
export function useSubjectKnowledgePoints(subject: Subject | '全部') {
  const { knowledgePoints } = useCurriculum();
  return useMemo(
    () =>
      subject === '全部'
        ? knowledgePoints
        : knowledgePoints.filter((kp) => kp.subject === subject),
    [knowledgePoints, subject]
  );
}
