/**
 * 统一异常处理中间件。
 *
 * 现状痛点：5 个接口的错误均为 `{ error: string }`，前端无法区分
 * 「模型超时该重试」与「参数错误该改 UI」。
 */
import type { Request, Response, NextFunction } from 'express';
import {
  buildApiError,
  API_ERROR_STATUS,
  type ApiErrorCode,
} from '@daydayup/contracts';
import { logger } from '../../infrastructure/logging/logger.ts';

export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'ApiException';
    this.code = code;
    this.details = details;
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    buildApiError('NOT_FOUND', `接口不存在: ${req.method} ${req.path}`, undefined, req.requestId)
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? 'unknown';

  if (err instanceof ApiException) {
    logger.warn('api.error', {
      requestId,
      code: err.code,
      message: err.message,
      path: req.path,
    });
    // HTTP 状态码由错误码统一映射（401/403/404/429/503 ...）
    res
      .status(API_ERROR_STATUS[err.code] ?? 400)
      .json(buildApiError(err.code, err.message, err.details, requestId));
    return;
  }

  const message = err instanceof Error ? err.message : '服务内部错误';
  // 注意字段名：日志的 `message` 字段是事件名，不能被覆盖
  logger.error('api.unhandled', {
    requestId,
    errorMessage: message,
    path: req.path,
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json(buildApiError('INTERNAL_ERROR', undefined, undefined, requestId));
}
