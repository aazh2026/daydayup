/**
 * 角色校验中间件。
 *
 * 用于运维类接口（备份、清理、审计）——
 * 这些操作影响**全部学生**的数据，不能只靠「已登录」放行。
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiException } from './error-handler.ts';
import type { Role } from '../../infrastructure/security/token.ts';

/**
 * 要求指定角色之一。
 *
 * @param roles 允许的角色
 */
export function requireRole(roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      next(new ApiException('UNAUTHORIZED', '缺少访问令牌'));
      return;
    }
    if (!roles.includes(auth.role)) {
      next(
        new ApiException(
          'FORBIDDEN',
          `该操作需要 ${roles.join(' / ')} 角色，当前为 ${auth.role}`
        )
      );
      return;
    }
    next();
  };
}

/** 仅管理员（老师）可执行运维操作 */
export const requireAdmin = requireRole(['teacher']);
