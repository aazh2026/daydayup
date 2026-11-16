/**
 * 请求频率限制中间件。
 *
 * 与「AI 配额」的区别：
 * - 配额：每日总量上限，防成本失控
 * - 限流：单位时间请求数上限，防瞬时刷量与资源耗尽
 *
 * 实现：滑动窗口计数器（进程内）。
 * 单实例部署下足够；多实例需改为 Redis 等共享存储。
 */
import type { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  /** 时间窗口（毫秒） */
  windowMs?: number;
  /** 窗口内最大请求数 */
  max?: number;
  /** 限流键生成器（默认按 IP） */
  keyGenerator?: (req: Request) => string;
  /** 限流响应消息 */
  message?: string;
  /** 是否跳过已认证用户的限流（登录后按用户维度） */
  skipAuthenticated?: boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 60;
  const message = options.message ?? '请求过于频繁，请稍后再试';
  const keyGenerator =
    options.keyGenerator ??
    ((req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown');

  const buckets = new Map<string, Bucket>();

  // 定期清理过期桶，避免内存无限增长
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  cleanupTimer.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    // 已认证用户按用户维度限流，匿名按 IP
    const key =
      options.skipAuthenticated && req.auth
        ? `user:${req.auth.principalId}`
        : `ip:${keyGenerator(req)}`;

    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `${message}（${retryAfter} 秒后重试）`,
        },
        requestId: req.requestId,
      });
      return;
    }

    next();
  };
}
