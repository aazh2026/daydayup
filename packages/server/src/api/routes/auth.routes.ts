/**
 * 认证路由。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { logger } from '../../infrastructure/logging/logger.ts';

export interface LoginRequest {
  /** 登录凭证：学生 PIN / 家长或老师 API Key */
  secret: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  principalId: string;
  role: string;
  studentIds: string[];
  displayName?: string;
}

export function createAuthRoutes(container: Container): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/login
   *
   * 用凭证换取访问令牌。
   */
  router.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { secret } = (req.body ?? {}) as LoginRequest;

      if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
        throw new ApiException('VALIDATION_FAILED', '请输入登录凭证');
      }

      const credential = await container.credentialStore.findBySecret(secret.trim());
      if (!credential) {
        logger.warn('auth.login_failed', { requestId: req.requestId });
        throw new ApiException('UNAUTHORIZED', '凭证无效');
      }

      const issued = container.tokenService.issue(
        credential.principalId,
        credential.studentIds,
        credential.role
      );

      logger.info('auth.login', {
        requestId: req.requestId,
        principalId: credential.principalId,
        role: credential.role,
      });

      res.json({
        token: issued.token,
        expiresAt: issued.expiresAt,
        principalId: credential.principalId,
        role: credential.role,
        studentIds: credential.studentIds,
        displayName: credential.displayName,
      } satisfies LoginResponse);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/auth/me —— 校验当前令牌并返回身份信息。
   */
  router.get('/auth/me', (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization');
      if (!header?.toLowerCase().startsWith('bearer ')) {
        throw new ApiException('UNAUTHORIZED', '缺少访问令牌');
      }
      const payload = container.tokenService.verify(header.slice(7).trim());
      if (!payload) {
        throw new ApiException('UNAUTHORIZED', '访问令牌无效或已过期');
      }
      res.json({
        principalId: payload.sub,
        role: payload.role,
        studentIds: payload.sids,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
