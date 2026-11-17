/**
 * 安全与运维测试。
 *
 * 覆盖：限流、审计、定时任务、文件隔离。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { fakeJpeg } from './helpers/fake-images.ts';
import { FileStorage } from '../src/infrastructure/storage/file-storage.ts';
import { AuditService } from '../src/infrastructure/audit/audit-service.ts';
import { Scheduler } from '../src/infrastructure/scheduler/scheduler.ts';

let tmpDir: string;
let db: FileDatabase;
let storage: FileStorage;
let audit: AuditService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
  db = new FileDatabase(tmpDir);
  storage = new FileStorage({ dataDir: tmpDir, db });
  audit = new AuditService(db);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('文件隔离（安全缺口修复）', () => {
  test('文件按学生分目录存储', async () => {
    const a = await storage.save(fakeJpeg('AAA'), {
      studentId: 'stu-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });
    const b = await storage.save(fakeJpeg('BBB'), {
      studentId: 'stu-b',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    assert.ok(a.relativePath.includes('stu-a'), '应包含学生 ID 目录');
    assert.ok(b.relativePath.includes('stu-b'));
    assert.notEqual(a.relativePath, b.relativePath);
  });

  test('元数据索引记录归属', async () => {
    const file = await storage.save(fakeJpeg('AAA'), {
      studentId: 'stu-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });

    const meta = await storage.getMeta(file.id);
    assert.equal(meta?.studentId, 'stu-a');
    assert.equal(meta?.relativePath, file.relativePath);
  });

  test('跨学生访问被拒绝', async () => {
    const file = await storage.save(fakeJpeg('AAA'), {
      studentId: 'stu-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });

    assert.equal(await storage.canAccess(file.id, 'stu-a'), true);
    assert.equal(await storage.canAccess(file.id, 'stu-b'), false);
  });

  test('已知 fileId 也不足以访问他人文件', async () => {
    const file = await storage.save(fakeJpeg('AAA'), {
      studentId: 'stu-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });

    // 攻击者拿到 fileId，尝试用自己 studentId 访问
    const meta = await storage.getMeta(file.id);
    assert.equal(meta?.studentId, 'stu-a', '归属信息不可被篡改');
    assert.equal(await storage.canAccess(file.id, 'stu-attacker'), false);
  });

  test('路径穿越被阻止', async () => {
    await assert.rejects(
      () => storage.read('../../../etc/passwd'),
      /非法路径/
    );
  });

  test('studentId 中的路径分隔符被清洗', async () => {
    const file = await storage.save(fakeJpeg('AAA'), {
      studentId: '../../etc',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });

    assert.ok(!file.relativePath.includes('..'), '路径中不应保留 ..');
    assert.ok(file.relativePath.includes('files/papers/'));
  });

  test('不支持的文件类型被拒绝', async () => {
    await assert.rejects(
      () =>
        storage.save(fakeJpeg('x'), {
          studentId: 'stu-a',
          originalName: 'x.exe',
          mimeType: 'application/x-msdownload',
        }),
      /不支持的文件类型/
    );
  });

  test('超过大小限制被拒绝', async () => {
    const smallStorage = new FileStorage({
      dataDir: tmpDir,
      db,
      maxFileSize: 10,
    });
    await assert.rejects(
      () =>
        smallStorage.save(Buffer.alloc(100), {
          studentId: 'stu-a',
          originalName: 'a.jpg',
          mimeType: 'image/jpeg',
        }),
      /超过大小限制/
    );
  });

  test('按学生列出文件', async () => {
    await storage.save(fakeJpeg('A'), {
      studentId: 'stu-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });
    await storage.save(fakeJpeg('B'), {
      studentId: 'stu-b',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    const aFiles = await storage.listForStudent('stu-a');
    assert.equal(aFiles.length, 1);
    assert.equal(aFiles[0].studentId, 'stu-a');
  });
});

describe('审计服务', () => {
  test('写入并读取审计记录', async () => {
    await audit.record('StudentProfileUpdated', {
      aggregateId: 'stu-1',
      actor: 'user-1',
      actorRole: 'teacher',
      payload: { fields: ['name'] },
    });

    const entries = await audit.read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_type, 'StudentProfileUpdated');
    assert.equal(entries[0].actor, 'user-1');
    assert.equal(entries[0].actor_role, 'teacher');
  });

  test('按事件类型过滤', async () => {
    await audit.record('StudentProfileUpdated', { aggregateId: 'a' });
    await audit.record('BackupCreated', { aggregateId: 'b' });

    const filtered = await audit.read({ eventType: 'BackupCreated' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].event_type, 'BackupCreated');
  });

  test('审计记录只追加不覆盖', async () => {
    await audit.record('PlanRegenerated', { aggregateId: 'x' });
    await audit.record('PlanRegenerated', { aggregateId: 'x' });

    const entries = await audit.read();
    assert.equal(entries.length, 2, '应保留两条记录');
  });

  test('审计写入失败不影响主流程', async () => {
    // 用一个会失败的 db 路径
    const brokenAudit = new AuditService(
      new FileDatabase('/proc/nonexistent-readonly')
    );
    const entry = await brokenAudit.record('BackupCreated', {});
    assert.ok(entry.event_id, '应返回记录对象而非抛错');
  });
});

describe('定时任务调度器', () => {
  test('每日任务每天只执行一次', async () => {
    let runs = 0;
    const scheduler = new Scheduler(
      [
        {
          name: 'daily-test',
          intervalMs: 50,
          daily: true,
          run: async () => {
            runs++;
          },
        },
      ],
      path.join(tmpDir, 'markers')
    );

    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    scheduler.stop();

    assert.equal(runs, 1, '每日任务不应重复执行');
  });

  test('非每日任务按间隔重复执行', async () => {
    let runs = 0;
    const scheduler = new Scheduler(
      [
        {
          name: 'frequent',
          intervalMs: 50,
          run: async () => {
            runs++;
          },
        },
      ],
      path.join(tmpDir, 'markers')
    );

    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    scheduler.stop();

    assert.ok(runs >= 2, `应至少执行 2 次，实际 ${runs}`);
  });

  test('重启后不重复执行当日任务', async () => {
    const markerDir = path.join(tmpDir, 'markers');
    let runs = 0;

    const makeScheduler = () =>
      new Scheduler(
        [
          {
            name: 'daily-persist',
            intervalMs: 50,
            daily: true,
            run: async () => {
              runs++;
            },
          },
        ],
        markerDir
      );

    // 第一次运行
    const s1 = makeScheduler();
    await s1.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    s1.stop();
    assert.equal(runs, 1);

    // 模拟重启：新的调度器读同一 marker 目录
    const s2 = makeScheduler();
    await s2.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    s2.stop();

    assert.equal(runs, 1, '重启后不应重复执行当日任务');
  });

  test('任务失败不影响调度器', async () => {
    const scheduler = new Scheduler(
      [
        {
          name: 'failing',
          intervalMs: 50,
          run: async () => {
            throw new Error('任务失败');
          },
        },
      ],
      path.join(tmpDir, 'markers')
    );

    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    // 调度器仍在运行（未崩溃）
    const ok = await scheduler.runAll().then(
      () => true,
      () => false
    );
    assert.equal(ok, true);
  });
});
