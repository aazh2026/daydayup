/**
 * 认证与授权中间件。
 *
 * 三个层次：
 * 1. 身份认证：Bearer Token → AuthContext
 * 2. 资源级鉴权：AuthContext.studentIds 决定可访问的学生数据
 * 3. 成本护栏：AI 调用配额（防止 token 额度失控）
 */
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from './error-handler.ts';
import type { Role } from '../../infrastructure/security/token.ts';

export interface AuthContext {
  principalId: string;
  role: Role;
  /** 可访问的学生 ID 列表 */
  studentIds: string[];
  /** 配额使用情况 */
  quota: { used: number; limit: number };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * 必须认证。未携带有效 token 直接拒绝。
 */
export function requireAuth(container: Container) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      next(new ApiException('UNAUTHORIZED', '缺少访问令牌'));
      return;
    }

    const token = header.slice(7).trim();
    const payload = container.tokenService.verify(token);
    if (!payload) {
      next(new ApiException('UNAUTHORIZED', '访问令牌无效或已过期'));
      return;
    }

    req.auth = {
      principalId: payload.sub,
      role: payload.role,
      studentIds: payload.sids,
      quota: { used: 0, limit: container.config.dailyTokenQuota },
    };
    next();
  };
}

/**
 * 校验对某个学生数据的访问权。
 *
 * 服务端强制过滤，不依赖前端隐藏按钮。
 *
 * 开发模式（未配置 AUTH_SECRET，authRequired=false）下无认证信息，
 * 此时不做资源级校验——因为本地开发只有单一演示学生。
 */
export function assertStudentAccess(req: Request, studentId: string): void {
  const auth = req.auth;
  if (!auth) {
    // 开发模式：无认证上下文，放行
    if (!req.app.locals.authRequired) return;
    throw new ApiException('UNAUTHORIZED', '缺少访问令牌');
  }
  // 老师角色可访问全部学生（受限于教学场景）
  if (auth.role === 'teacher') return;
  if (!auth.studentIds.includes(studentId)) {
    throw new ApiException('FORBIDDEN', '无权访问该学生数据');
  }
}

/**
 * 校验对某个学生数据的写入权。
 *
 * 家长为只读角色 —— 家长能看报告，但不能替孩子提交作答。
 */
export function assertStudentWriteAccess(req: Request, studentId: string): void {
  const auth = req.auth;
  if (!auth) {
    // 开发模式：无认证上下文，放行
    if (!req.app.locals.authRequired) return;
    throw new ApiException('UNAUTHORIZED', '缺少访问令牌');
  }
  if (auth.role === 'parent') {
    throw new ApiException('FORBIDDEN', '家长账号为只读角色，无法修改学习数据');
  }
  assertStudentAccess(req, studentId);
}
