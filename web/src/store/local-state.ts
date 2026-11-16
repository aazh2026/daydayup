/**
 * 本地状态存储。
 *
 * 分离后的边界：**localStorage 只保留客户端应持有的数据**。
 *
 * | 数据 | 是否保留 | 理由 |
 * |---|---|---|
 * | 访问令牌 | ✅ | 必须本地持有才能发请求 |
 * | UI 偏好 | ✅ | 纯客户端状态 |
 * | 只读缓存快照 | ✅ | 减少请求，支持离线浏览 |
 * | 掌握度 / 错题 / 计划 / 会话 | ❌ | **服务端是唯一真相源** |
 *
 * 分离前 AppState（约 20KB，含全部聊天与试卷）每次状态变化都全量重写，
 * 既拖慢性能又让「服务端是权威」名存实亡。
 */
import type { AppState } from '@daydayup/contracts';

const LEGACY_KEY = 'shanghai_ai_score_os_v5';
const PREFS_KEY = 'daydayup.ui.prefs';

export interface UiPreferences {
  /** 当前选中的学科 */
  subject?: string;
  /** 折叠侧栏 */
  sidebarCollapsed?: boolean;
  /** 报告页默认标签 */
  reportTab?: string;
}

export function loadUiPreferences(): UiPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as UiPreferences;
  } catch {
    return {};
  }
}

export function saveUiPreferences(prefs: UiPreferences): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略配额错误
  }
}

/**
 * 一次性清理分离前遗留的 localStorage 数据。
 *
 * 旧 key 存的是完整 AppState（含聊天记录、试卷、考试等业务实体）。
 * 这些数据已迁移到服务端，继续保留既占空间又可能展示过期数据。
 *
 * @returns 是否执行了清理
 */
export function purgeLegacyState(): boolean {
  try {
    if (!localStorage.getItem(LEGACY_KEY)) return false;
    localStorage.removeItem(LEGACY_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造本地初始状态。
 *
 * 只保留「无业务数据」的骨架：业务字段一律由服务端水合填充。
 */
export function createLocalSkeleton(seed: AppState): AppState {
  return {
    ...seed,
    // 业务数据清空，由服务端水合
    exams: [],
    examResults: [],
    examPapers: [],
    errorRecords: [],
    masteryRecords: {},
    masteryHistory: [],
    learningAttempts: [],
    variantQuestions: [],
    completedTaskIds: [],
    deferredKnowledgeIds: [],
    coachHistoryByKnowledge: {},
    taskProgressByKnowledge: {},
  };
}
