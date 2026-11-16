/**
 * AI 配额中间件。
 *
 * 保护 GEMINI_API_KEY 的直接成本。
 */
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from './error-handler.ts';

export function requireQuota(container: Container) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      const principalId = auth?.principalId ?? 'anonymous';

      const allowed = await container.quota.consume(principalId);
      if (!allowed) {
        const remaining = await container.quota.remaining(principalId);
        throw new ApiException(
          'QUOTA_EXCEEDED',
          `今日 AI 用量已达上限（${remaining} 次剩余），请明天再试`
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
