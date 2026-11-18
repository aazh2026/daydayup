/**
 * JSON gzip 压缩中间件的单测。
 *
 * 换版后知识体系资产涨到 1.47 MB，压缩从"优化"变成"必需"；
 * 而压缩写错会直接让客户端拿到坏数据（最常见的是漏设
 * Content-Length / Vary，或对已发送的响应二次压）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { gzipJsonMiddleware } from '../src/api/middleware/gzip.ts';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
}

/** 起一个最小 app，按给定路径返回 body */
async function withApp(
  body: unknown,
  run: (req: (path: string, headers?: Record<string, string>) => Promise<Reply>) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(gzipJsonMiddleware);
  app.get('/big', (_req, res) => {
    res.json(body);
  });
  app.get('/small', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: hello\n\n');
    res.end();
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const request = (path: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              raw: Buffer.concat(chunks),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  try {
    await run(request);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const BIG = Array.from({ length: 300 }, (_, i) => ({
  id: `kp-${i}`,
  名称: `知识点 ${i}`,
  definition: '这是一段用于验证压缩效果的中文描述文本。',
}));

describe('JSON gzip 压缩', () => {
  test('大响应在客户端声明 gzip 时被压缩，且解压后内容一致', async () => {
    await withApp(BIG, async (request) => {
      const res = await request('/big', { 'accept-encoding': 'gzip' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.match(res.headers['vary'] ?? '', /Accept-Encoding/i);

      const bodyText = await new Promise<string>((resolve, reject) => {
        zlib.gunzip(res.raw, (err, out) =>
          err ? reject(err) : resolve(out.toString('utf8'))
        );
      });
      assert.deepEqual(JSON.parse(bodyText), BIG);
    });
  });

  test('压缩后体积显著减小', async () => {
    await withApp(BIG, async (request) => {
      const plain = await request('/big');
      const gz = await request('/big', { 'accept-encoding': 'gzip' });
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.ok(
        gz.raw.length < plain.raw.length / 2,
        `压缩后应有明显收益：${gz.raw.length} vs ${plain.raw.length}`
      );
    });
  });

  test('客户端不支持 gzip 时不压缩', async () => {
    await withApp(BIG, async (request) => {
      const res = await request('/big', { 'accept-encoding': 'identity' });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.deepEqual(JSON.parse(res.raw.toString('utf8')), BIG);
    });
  });

  test('小响应不压缩（压完可能更大）', async () => {
    await withApp(BIG, async (request) => {
      const res = await request('/small', { 'accept-encoding': 'gzip' });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.deepEqual(JSON.parse(res.raw.toString('utf8')), { ok: true });
    });
  });

  test('SSE 流式响应不受影响（不得被缓冲）', async () => {
    await withApp(BIG, async (request) => {
      const res = await request('/stream', { 'accept-encoding': 'gzip' });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.raw.toString('utf8'), 'data: hello\n\n');
    });
  });

  test('Content-Length 与实际压缩字节数一致', async () => {
    await withApp(BIG, async (request) => {
      const res = await request('/big', { 'accept-encoding': 'gzip' });
      assert.equal(
        Number(res.headers['content-length']),
        res.raw.length,
        'Content-Length 与实际字节数不一致会让客户端截断或卡住'
      );
    });
  });
});
