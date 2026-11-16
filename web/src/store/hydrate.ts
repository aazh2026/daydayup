/**
 * 服务端状态水合。
 *
 * 分离后服务端是唯一真相源：应用启动时从服务端拉取
 * 掌握度、掌握度历史、错题记录、作答流水、考试场次、试卷存档库、考试成绩，
 * 覆盖本地骨架。
 *
 * 设计：本地不再持久化业务数据（见 store/local-state.ts），
 * localStorage 仅作 token / UI 偏好 / 只读快照。
 *
 * 核心逻辑在 `hydration-core.ts`（可独立测试），
 * 本文件只负责 React 生命周期与取消处理。
 */
import { useEffect } from 'react';
import type { AppState } from '@daydayup/contracts';
import { useCurriculum } from './curriculum.tsx';
import { hydrateFromServer } from './hydration-core.ts';

export function useServerHydration(
  studentId: string | undefined,
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
): void {
  const { knowledgeMap } = useCurriculum();

  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;

    void hydrateFromServer(
      studentId,
      setAppState,
      knowledgeMap,
      () => cancelled
    );

    return () => {
      cancelled = true;
    };
  }, [studentId, knowledgeMap, setAppState]);
}
