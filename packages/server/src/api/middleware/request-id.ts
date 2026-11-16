/**
 * Request ID 中间件。
 *
 * 为每个请求生成追踪 ID，贯穿日志、错误响应、AI 调用记录。
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 64 ? incoming : `req_${randomUUID()}`;
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
