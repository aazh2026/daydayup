/**
 * JSON 响应 gzip 压缩中间件（零依赖，只用 node:zlib）。
 *
 * 为什么需要
 * ----------
 * 知识体系资产从 18 个知识点（约 14 KB）换成 2760 个（**1.47 MB**）。
 * `/api/v1/knowledge-points` 会一次性把它吐给前端，未压缩时：
 *
 *   - 移动端首屏要等 1.5 MB 下载，弱网下几秒白屏
 *   - 而这 1.5 MB 里 90% 是重复的中文键名与结构，压缩比极高
 *
 * 实测 gzip 后约 150 KB（约 10 倍）。
 *
 * 为什么不装 `compression` 包
 * ---------------------------
 * 只需要对 JSON 压缩，用 node:zlib 约 40 行即可，
 * 少一个生产依赖、少一次供应链审查。
 *
 * 为什么拦 `res.json` 而不是包一层 `res.write`
 * ----------------
 * 流式响应（SSE 进度推送）走 `res.write`，若在 write 层压缩会和
 * `text/event-stream` 冲突（必须逐条 flush，不能缓冲）。
 * 只拦 `res.json` 天然避开 SSE。
 *
 * 与 ETag 的关系
 * --------------
 * Express 默认给 JSON 响应加 ETag，重复请求会 304（无正文）。
 * 因此压缩只在**首次加载**生效 —— 这正是需要它的地方。
 */

import zlib from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

/** 小于此大小不压缩：压完可能更大，且小响应开销不划算 */
const MIN_BYTES = 1024;

/** 是否接受 gzip */
function acceptsGzip(req: Request): boolean {
  const header = req.headers['accept-encoding'];
  return typeof header === 'string' && /\bgzip\b/i.test(header);
}

export function gzipJsonMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!acceptsGzip(req)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = function jsonWithGzip(body: unknown): Response {
    // 已经写过头的响应不能再改编码（否则客户端拿到的是坏数据）
    if (res.headersSent) return originalJson(body);

    // 缓存协商：不同编码的同一个 URL 不能共用缓存条目
    res.setHeader('Vary', 'Accept-Encoding');

    let raw: Buffer;
    try {
      raw = Buffer.from(JSON.stringify(body), 'utf8');
    } catch {
      // 不可序列化的响应体交给 Express 自己处理（它会报错并走错误处理）
      return originalJson(body);
    }

    if (raw.length < MIN_BYTES) return originalJson(body);

    zlib.gzip(raw, (err, compressed) => {
      if (err) {
        // 压缩失败不能让请求挂掉：退回未压缩
        originalJson(body);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(compressed.length));
      // HEAD 请求：头信息已写好，不发正文
      res.end(req.method === 'HEAD' ? undefined : compressed);
    });

    return res;
  } as Response['json'];

  next();
}
