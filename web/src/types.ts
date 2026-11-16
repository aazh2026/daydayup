/**
 * 前端类型入口 —— 全部来自 @daydayup/contracts。
 *
 * 分离后契约是前后端唯一事实源。
 * 本文件仅作重导出，以保持既有 import 路径 `../types.ts` 继续可用，
 * 避免一次性改动全部组件的 import 造成大范围 diff。
 */
export type {
  Subject,
  HomeworkLoad,
  FatigueLevel,
  ErrorType,
  ConfidenceLevel,
  MasteryState,
  TeachingBehavior,
  PracticeMode,
  QuestionLevel,
  Student,
  Exam,
  ExamResult,
  ExamPaper,
  KnowledgePoint,
  Question,
  QuestionKnowledge,
  ErrorRecord,
  MasteryRecord,
  PriorityOpportunity,
  TaskStep,
  LearningTask,
  DailySchedule,
  LearningPlan,
  LearningAttempt,
  VariantQuestion,
  CoachMessage,
  MasteryTransitionEvent,
  AppPage,
  AppState,
} from '@daydayup/contracts';

export { ALL_SUBJECTS } from '@daydayup/contracts';

/**
 * MASTERY_ORDER 属于「状态枚举的显示顺序」，是常量而非业务逻辑，
 * 保留在前端供 UI 渲染排序使用（展示职责）。
 * 真正的状态迁移规则在服务端 MasteryEngine。
 */
export { MASTERY_ORDER } from '@daydayup/contracts';
