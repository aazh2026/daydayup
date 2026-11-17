/**
 * 文件魔数校验测试。
 *
 * ## 为什么需要
 *
 * 客户端自报的 `mimeType` 是**不可信的** —— 传 `mimeType: 'image/jpeg'`
 * 加任意字节就能通过白名单，于是任意内容都能以「图片」的名义落盘
 * （并被送给 AI 模型）。
 *
 * 校验文件头才能确认「它真的是图片」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchesMagicBytes,
  sniffImageMimeType,
  FileStorage,
} from '../src/infrastructure/storage/file-storage.ts';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { fakeJpeg, fakePng, fakeWebp } from './helpers/fake-images.ts';

describe('魔数匹配', () => {
  test('JPEG 签名匹配', () => {
    assert.equal(matchesMagicBytes(fakeJpeg(), 'image/jpeg'), true);
  });

  test('PNG 签名匹配', () => {
    assert.equal(matchesMagicBytes(fakePng(), 'image/png'), true);
  });

  test('WebP 签名匹配', () => {
    assert.equal(matchesMagicBytes(fakeWebp(), 'image/webp'), true);
  });

  test('文本内容不匹配 JPEG', () => {
    assert.equal(
      matchesMagicBytes(Buffer.from('<html>evil</html>'), 'image/jpeg'),
      false
    );
  });

  test('PNG 内容不匹配 JPEG', () => {
    assert.equal(matchesMagicBytes(fakePng(), 'image/jpeg'), false);
  });

  test('JPEG 内容不匹配 PNG', () => {
    assert.equal(matchesMagicBytes(fakeJpeg(), 'image/png'), false);
  });

  test('空内容不匹配任何图片类型', () => {
    assert.equal(matchesMagicBytes(Buffer.alloc(0), 'image/jpeg'), false);
    assert.equal(matchesMagicBytes(Buffer.alloc(0), 'image/png'), false);
  });

  test('未登记签名的类型放行（避免误杀合法文件）', () => {
    // application/pdf 没登记签名 —— 不做校验
    assert.equal(matchesMagicBytes(Buffer.from('%PDF-1.7'), 'application/pdf'), true);
  });
});

describe('类型嗅探', () => {
  test('嗅探出 JPEG', () => {
    assert.equal(sniffImageMimeType(fakeJpeg()), 'image/jpeg');
  });

  test('嗅探出 PNG', () => {
    assert.equal(sniffImageMimeType(fakePng()), 'image/png');
  });

  test('嗅探出 WebP', () => {
    assert.equal(sniffImageMimeType(fakeWebp()), 'image/webp');
  });

  test('嗅探出 PDF', () => {
    assert.equal(sniffImageMimeType(Buffer.from('%PDF-1.7')), 'application/pdf');
  });

  test('无法识别时返回 null', () => {
    assert.equal(sniffImageMimeType(Buffer.from('random text')), null);
    assert.equal(sniffImageMimeType(Buffer.alloc(0)), null);
  });

  test('HTML 内容不会被误判成图片', () => {
    assert.equal(
      sniffImageMimeType(Buffer.from('<!DOCTYPE html><script>alert(1)</script>')),
      null
    );
  });
});

describe('存储时拒绝内容不符的文件', () => {
  let dir: string;
  let storage: FileStorage;

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-test-'));
    const db = new FileDatabase(dir);
    storage = new FileStorage({ dataDir: dir, db });
  }

  test('内容与声明类型不符时拒绝保存', async () => {
    setup();
    try {
      await assert.rejects(
        () =>
          storage.save(Buffer.from('<html>not an image</html>'), {
            studentId: 'stu-1',
            paperId: 'p1',
            originalName: 'evil.jpg',
            mimeType: 'image/jpeg',
          }),
        /内容与声明的类型不符/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('内容与声明类型相符时正常保存', async () => {
    setup();
    try {
      const stored = await storage.save(fakeJpeg(), {
        studentId: 'stu-1',
        paperId: 'p1',
        originalName: 'ok.jpg',
        mimeType: 'image/jpeg',
      });
      assert.ok(stored.id);
      assert.ok(fs.existsSync(path.join(dir, stored.relativePath)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('被拒绝的文件不会落盘', async () => {
    setup();
    try {
      await assert.rejects(() =>
        storage.save(Buffer.from('evil'), {
          studentId: 'stu-1',
          paperId: 'p1',
          originalName: 'evil.jpg',
          mimeType: 'image/jpeg',
        })
      );

      const papersDir = path.join(dir, 'files', 'papers');
      const exists =
        fs.existsSync(papersDir) &&
        fs.readdirSync(papersDir, { recursive: true } as never).length > 0;
      assert.equal(exists, false, '被拒绝的文件不应留下任何痕迹');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
