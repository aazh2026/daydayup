/**
 * 上传文件的归属校验测试（跨学生越权）。
 *
 * ## 为什么重要
 *
 * 试卷文件按 `files/papers/{studentId}/` 分目录存储，
 * 鉴权**依赖元数据索引**（记录了 studentId），不靠文件名猜测。
 *
 * 但「取文件路径」有两个入口，防护程度曾不一致：
 *
 * | 入口 | 归属校验 |
 * |---|---|
 * | `GET /uploads/:fileId`（下载） | ✅ 校验 `meta.studentId !== studentId` |
 * | `POST /exams/:id/diagnosis`（诊断引用 fileId） | ❌ **只按 ID 查路径** |
 *
 * 结果：学生 A 可以把学生 B 的 fileId 填进自己的诊断请求，
 * AI 就会去读 B 的卷子 —— 而 B 的卷子内容会进入 A 的诊断结果。
 *
 * 关键：`storage.findById` 只按 ID 查路径，**本身不做归属校验**；
 * `storage.canAccess` 一直存在却从未被调用。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createContainer, type Container } from '../src/bootstrap/container.ts';
import { createApp } from '../src/app.ts';

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
let container: Container;
let tokenA: string;

const STUDENT_A = 'stu-file-a';

before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-fileowner-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.AUTH_SECRET = 'fileowner-test-secret';
  process.env.GEMINI_API_KEY = '';

  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'owner-a',
        secret: 'key-a',
        role: 'student',
        studentIds: [STUDENT_A],
      },
    ])
  );

  container = createContainer();
  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'key-a' }),
  });
  const body = (await res.json()) as { token: string };
  tokenA = body.token;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('文件归属校验', () => {
  test('canAccess 正确区分归属', async () => {
    const stored = await container.storage.save(Buffer.from('B 的卷子'), {
      studentId: 'stu-B',
      paperId: 'paper-B',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    assert.equal(
      await container.storage.canAccess(stored.id, 'stu-B'),
      true,
      '主人应可访问'
    );
    assert.equal(
      await container.storage.canAccess(stored.id, 'stu-A'),
      false,
      '他人不可访问'
    );
  });

  test('下载接口拒绝跨学生访问（原本就有的防护）', async () => {
    const stored = await container.storage.save(Buffer.from('B 的卷子'), {
      studentId: 'stu-B',
      paperId: 'paper-B',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    const res = await fetch(
      `${baseUrl}/api/v1/uploads/papers/${stored.id}?studentId=${STUDENT_A}`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    assert.equal(res.status, 403, '跨学生下载应被拒绝');
  });

  test('诊断接口拒绝引用他人的 fileId（回归）', async () => {
    const storedB = await container.storage.save(Buffer.from('B 的卷子'), {
      studentId: 'stu-B',
      paperId: 'paper-B',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    /**
     * 观察点：`findByIdForStudent` —— 按学生维度解析文件路径。
     *
     * 不能只看 HTTP 响应：未配 GEMINI_API_KEY 时，
     * 越权与正常都会走到「AI 不可用」的 500 分支，响应完全一样，
     * 测不出区别。真正的差别在**路径解析是否放行**。
     */
    const asOwner = await container.storage.findByIdForStudent(
      storedB.id,
      'stu-B'
    );
    assert.equal(asOwner, storedB.relativePath, '主人应能解析出路径');

    const asOther = await container.storage.findByIdForStudent(
      storedB.id,
      STUDENT_A
    );
    assert.equal(
      asOther,
      null,
      '他人不得解析出路径（否则可把别人的卷子挂进自己的诊断）'
    );
  });

  test('引用自己的 fileId 正常通过归属校验', async () => {
    const storedA = await container.storage.save(Buffer.from('A 的卷子'), {
      studentId: STUDENT_A,
      paperId: 'paper-A',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });

    const resolved = await container.storage.findByIdForStudent(
      storedA.id,
      STUDENT_A
    );
    assert.equal(resolved, storedA.relativePath, '自己的文件应能解析');
  });

  test('不存在的 fileId 返回 null', async () => {
    assert.equal(
      await container.storage.findByIdForStudent('file_nonexistent', STUDENT_A),
      null
    );
  });

  test('findById（无归属校验）仍可用于内部查找', async () => {
    const storedB = await container.storage.save(Buffer.from('B'), {
      studentId: 'stu-B',
      paperId: 'paper-B',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });
    // 内部管理逻辑（如清理）可能需要无视归属地查找 ——
    // 关键是有两个明确命名的方法，不靠调用方记得传对参数
    assert.equal(
      await container.storage.findById(storedB.id),
      storedB.relativePath
    );
  });
});
