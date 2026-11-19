/**
 * @daydayup/contracts
 *
 * 前后端共享的契约包。
 *
 * 严格约束（本包的唯一职责）：
 * - 只包含**类型定义**与**纯校验函数**
 * - **不包含任何业务逻辑**（提分算法、计划生成、状态机迁移等均属服务端）
 *
 * 原因：业务逻辑放前端意味着学生可通过篡改 JS 伪造掌握度与计划，
 * 对面向未成年学生的教育产品不可接受。
 */

// ---- 领域类型与枚举（唯一事实源） ----
export * from './domain/index.ts';

// ---- API 契约 ----
export {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  API_ERROR_MESSAGES,
  buildApiError,
  isApiErrorResponse,
  type ApiErrorCode,
  type ApiErrorBody,
  type ApiErrorResponse,
} from './api/errors.ts';

export {
  EXAM_TYPES,
  parseDiagnoseExamResponse,
  parseMicroQuizResponse,
  type DetectedMetadata,
  type DiagnosedItem,
  type DiagnoseExamRequest,
  type DiagnoseExamResponse,
  type DiagnosisMeta,
  type ExamType,
  type InputFormat,
  type MicroQuizItem,
  type MicroQuizRequest,
  type MicroQuizResponse,
  type PaperSourceFormat,
} from './api/diagnosis.ts';

export {
  parseGeneratePracticeResponse,
  parseEvaluateResponse,
  type EvaluateRequest,
  type EvaluateResponse,
  type GeneratePracticeRequest,
  type GeneratePracticeResponse,
} from './api/practice.ts';

export {
  parseCoachChatResponse,
  type CoachChatRequest,
  type CoachChatResponse,
  type CoachMessageInput,
} from './api/coaching.ts';

export {
  parseRetestStatus,
  type MasteryChange,
  type RetestStatus,
  type SubmitAttemptRequest,
  type SubmitAttemptResponse,
} from './api/mastery.ts';

export {
  parseLearningPlan,
  type TaskStatePatch,
} from './api/plan.ts';

export {
  parseStudent,
  parseEffectiveBudget,
  type EffectiveBudget,
  type StudentProfileUpdate,
} from './api/student.ts';

export {
  parseKnowledgeList,
  type CurriculumVersion,
  type KnowledgeListResponse,
} from './api/knowledge.ts';

export {
  parseJob,
  type Job,
  type JobProgressEvent,
  type JobStatus,
} from './api/job.ts';

export {
  AI_CONFIG_LIMITS,
  AI_MODEL_OPTIONS,
  AI_PURPOSES,
  maskApiKey,
  parseAIConfigResponse,
  validateAIConfigUpdate,
  type AIConfig,
  type AIConfigResponse,
  type AIModelId,
  type AIPurposeId,
  type TestAIConnectionResult,
  type UpdateAIConfigRequest,
} from './api/ai-config.ts';
