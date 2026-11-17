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

/**
 * 读取本地快照（离线兜底）。
 *
 * 导出以便单测 —— 快照损坏时的降级行为直接影响
 * 「断网还能不能浏览知识体系」这条产品承诺。
 */
export function loadSnapshot(): { version: string; knowledgePoints: KnowledgePoint[] } | null {
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

    /**
     * 逐条校验元素结构。
     *
     * 只检查「是数组且非空」不够 —— 数组里混进 null / 缺字段的元素时，
     * 后面 `buildCurriculumData` 里的 `kp.id` 会抛 TypeError，
     * 而它发生在 React 的 `useState` 初始化器里 → **整个应用白屏**。
     *
     * 快照可能来自：写入被中断、旧版本应用、缓存被外部改过。
     * 宁可当作「没有快照」回落到服务端，也不让它拖垮整个应用。
     */
    const valid = parsed.knowledgePoints.filter(
      (kp): kp is KnowledgePoint =>
        typeof kp === 'object' &&
        kp !== null &&
        typeof (kp as KnowledgePoint).id === 'string' &&
        typeof (kp as KnowledgePoint).name === 'string'
    );

    if (valid.length === 0) {
      return null;
    }

    return { version: parsed.version ?? '', knowledgePoints: valid };
  } catch {
    return null;
  }
}

/** 写入本地快照（供离线浏览） */
export function saveSnapshot(version: string, knowledgePoints: KnowledgePoint[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version, knowledgePoints }));
  } catch {
    // 忽略配额错误
  }
}

/**
 * 构造知识体系数据（含 id → KnowledgePoint 索引）。
 *
 * 同样做一次元素过滤：即便调用方传入了畸形数据，
 * 也不能让这里抛错（它在 React 的 useState 初始化器里调用，
 * 抛错 = 整个应用白屏）。
 */
export function buildCurriculumData(
  version: string,
  knowledgePoints: KnowledgePoint[]
): Pick<CurriculumData, 'version' | 'knowledgePoints' | 'knowledgeMap'> {
  const valid = (Array.isArray(knowledgePoints) ? knowledgePoints : []).filter(
    (kp): kp is KnowledgePoint =>
      typeof kp === 'object' &&
      kp !== null &&
      typeof (kp as KnowledgePoint).id === 'string' &&
      typeof (kp as KnowledgePoint).name === 'string'
  );

  return {
    version,
    knowledgePoints: valid,
    knowledgeMap: Object.fromEntries(valid.map((kp) => [kp.id, kp])),
  };
}

export const CurriculumProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [data, setData] = useState<CurriculumData>(() => {
    const snapshot = loadSnapshot();
    if (!snapshot) return EMPTY;
    return {
      ...buildCurriculumData(snapshot.version, snapshot.knowledgePoints),
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
          ...buildCurriculumData(res.version, knowledgePoints),
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
