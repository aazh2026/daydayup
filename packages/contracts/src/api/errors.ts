/**
 * 统一错误码与错误响应结构。
 *
 * 现状痛点：现有 5 个接口的错误均为 `{ error: string }`，
 * 前端无法区分「模型超时该重试」与「参数错误该改 UI」。
 */

export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'QUOTA_EXCEEDED',
  'AI_TIMEOUT',
  'AI_INVALID_OUTPUT',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 429,
  AI_INVALID_OUTPUT: 502,
  AI_TIMEOUT: 503,
  INTERNAL_ERROR: 500,
};

/** 面向用户的默认中文文案 */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_FAILED: '请求参数有误',
  UNAUTHORIZED: '请先登录',
  FORBIDDEN: '无权访问该学生数据',
  NOT_FOUND: '资源不存在',
  CONFLICT: '数据版本冲突，请刷新后重试',
  QUOTA_EXCEEDED: '今日 AI 用量已达上限，请明天再试',
  AI_INVALID_OUTPUT: 'AI 返回内容异常，请重试',
  AI_TIMEOUT: 'AI 响应超时，请重试',
  INTERNAL_ERROR: '服务内部错误',
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export interface ApiErrorResponse extends ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

/** 构造标准错误响应体 */
export function buildApiError(
  code: ApiErrorCode,
  message?: string,
  details?: unknown,
  requestId = 'unknown'
): ApiErrorResponse {
  return {
    error: {
      code,
      message: message ?? API_ERROR_MESSAGES[code],
      ...(details === undefined ? {} : { details }),
    },
    requestId,
  };
}

export function isApiErrorResponse(raw: unknown): raw is ApiErrorResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const err = (raw as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    typeof code === 'string' &&
    (API_ERROR_CODES as readonly string[]).includes(code) &&
    typeof message === 'string'
  );
}
