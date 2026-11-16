/**
 * 统一异常处理中间件。
 *
 * 现状痛点：5 个接口的错误均为 `{ error: string }`，前端无法区分
 * 「模型超时该重试」与「参数错误该改 UI」。
 */
import type { Request, Response, NextFunction } from 'express';
import { buildApiError, type ApiErrorCode } from '@daydayup/contracts';
import { logger } from '../../infrastructure/logging/logger.ts';

export class ApiException extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message?: string,
    public readonly details?: unknown
  ) {
    super(message ?? code);
    this.name = 'ApiException';
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
    res
      .status(err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400)
      .json(buildApiError(err.code, err.message, err.details, requestId));
    return;
  }

  const message = err instanceof Error ? err.message : '服务内部错误';
  logger.error('api.unhandled', { requestId, message, path: req.path, stack: err instanceof Error ? err.stack : undefined });
  res.status(500).json(buildApiError('INTERNAL_ERROR', undefined, undefined, requestId));
}
