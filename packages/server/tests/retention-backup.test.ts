/**
 * 数据保留与备份测试。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { FileStorage } from '../src/infrastructure/storage/file-storage.ts';
import {
  RetentionService,
  type RetentionPolicy,
} from '../src/infrastructure/retention/retention-service.ts';
import { BackupService, isSafeRelativePath } from '../src/infrastructure/backup/backup-service.ts';

let tmpDir: string;
let dataDir: string;
let backupDir: string;
let db: FileDatabase;
let storage: FileStorage;

const FAST_RETENTION: RetentionPolicy = {
  eventLogDays: 1,
  attemptDays: 1,
  completedJobDays: 1,
  uploadDays: 1,
  auditLogDays: 730,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  dataDir = path.join(tmpDir, 'data');
  backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  db = new FileDatabase(dataDir);
  // FileStorage 需要 db 做元数据索引（与 container.ts 的接线一致）
  storage = new FileStorage({ dataDir, db });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('数据保留清理', () => {
  test('清理过期的事件日志，保留未过期的', async () => {
    const retention = new RetentionService(db, storage, FAST_RETENTION);

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const newDate = new Date().toISOString().slice(0, 10);

    await db.append(['events', `${oldDate}.jsonl`], '{"event":"old"}');
    await db.append(['events', `${newDate}.jsonl`], '{"event":"new"}');

    const result = await retention.cleanup();
    assert.equal(result.deleted.eventLogs, 1);

    const remaining = await db.list(['events']);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes(newDate));
  });

  test('清理过期的事件文件不影响其他目录', async () => {
    const retention = new RetentionService(db, storage, FAST_RETENTION);
    await db.append(['events', '2020-01-01.jsonl'], '{"event":"old"}');
    await db.append(['audit', '2020-01-01.jsonl'], '{"event":"audit"}');

    await retention.cleanup();

    const auditFiles = await db.list(['audit']);
    assert.equal(auditFiles.length, 1, '审计日志不应被清理');
  });

  test('清理已完成的任务，保留运行中的', async () => {
    const retention = new RetentionService(db, storage, FAST_RETENTION);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await db.write(['db', 'jobs', 'job_done.json'], {
      id: 'job_done',
      type: 'test',
      status: 'SUCCEEDED',
      input: {},
      attempts: 1,
      maxAttempts: 3,
      createdAt: old,
      completedAt: old,
    });
    await db.write(['db', 'jobs', 'job_running.json'], {
      id: 'job_running',
      type: 'test',
      status: 'RUNNING',
      input: {},
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    });

    const result = await retention.cleanup();
    assert.equal(result.deleted.jobs, 1);

    const remaining = await db.list(['db', 'jobs']);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes('job_running'));
  });
});

describe('学生数据删除', () => {
  test('删除学生全部数据但保留审计记录', async () => {
    const studentId = 'stu-delete-test';

    await db.write(['db', 'students', `${studentId}.json`], { id: studentId });
    await db.write(['db', 'mastery', `${studentId}.json`], { studentId, records: {} });
    await db.append(['db', 'attempts', studentId, '2026-01-01.jsonl'], '{"a":1}');
    await db.write(['db', 'coaching', studentId, 'math-1.json'], { messages: [] });
    await db.write(['db', 'error-records', studentId, 'err-1.json'], { id: 'err-1' });

    const retention = new RetentionService(db, storage, FAST_RETENTION);
    const result = await retention.deleteStudentData(studentId);

    assert.equal(result.studentId, studentId);

    assert.equal(await db.exists(['db', 'students', `${studentId}.json`]), false);
    assert.equal(await db.exists(['db', 'mastery', `${studentId}.json`]), false);
    assert.equal(await db.exists(['db', 'attempts', studentId]), false);
    assert.equal(await db.exists(['db', 'coaching', studentId]), false);
    assert.equal(
      await db.exists(['db', 'error-records', studentId, 'err-1.json']),
      false
    );

    // 审计记录保留
    const today = new Date().toISOString().slice(0, 10);
    const auditEntries = await db.readLines<{ event_type: string }>([
      'audit',
      `${today}.jsonl`,
    ]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].event_type, 'StudentDataDeleted');
  });

  /**
   * 回归：删除学生 A 的数据**不得**删掉学生 B 的文件。
   *
   * 历史缺陷：`deleteStudentData` 遍历 `storage.listAll()`
   * （全部学生的文件）并逐个删除 ——
   * 于是「删除学生 A」把**学生 B 的试卷也删了**，
   * 跨越学生的数据丢失，且没有任何报错。
   */
  test('删除一个学生不影响另一个学生的试卷文件', async () => {
    const studentA = 'stu-files-a';
    const studentB = 'stu-files-b';

    const savedA = await storage.save(Buffer.from('paper-a'), {
      studentId: studentA,
      paperId: 'paper-a',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });
    const savedB = await storage.save(Buffer.from('paper-b'), {
      studentId: studentB,
      paperId: 'paper-b',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    assert.ok(fs.existsSync(path.join(dataDir, savedA.relativePath)));
    assert.ok(fs.existsSync(path.join(dataDir, savedB.relativePath)));

    const retention = new RetentionService(db, storage, FAST_RETENTION);
    await retention.deleteStudentData(studentA);

    assert.equal(
      fs.existsSync(path.join(dataDir, savedA.relativePath)),
      false,
      '目标学生的文件应被删除'
    );
    assert.equal(
      fs.existsSync(path.join(dataDir, savedB.relativePath)),
      true,
      '其它学生的文件必须保留'
    );
  });

  test('删除学生后元数据索引中也不再有该学生的文件', async () => {
    const studentA = 'stu-index-a';
    const studentB = 'stu-index-b';

    await storage.save(Buffer.from('a'), {
      studentId: studentA,
      paperId: 'p',
      originalName: 'a.jpg',
      mimeType: 'image/jpeg',
    });
    await storage.save(Buffer.from('b'), {
      studentId: studentB,
      paperId: 'p',
      originalName: 'b.jpg',
      mimeType: 'image/jpeg',
    });

    const retention = new RetentionService(db, storage, FAST_RETENTION);
    await retention.deleteStudentData(studentA);

    const remainingForA = await storage.listForStudent(studentA);
    const remainingForB = await storage.listForStudent(studentB);
    assert.equal(remainingForA.length, 0, '目标学生的索引应清空');
    assert.equal(remainingForB.length, 1, '其它学生的索引应保留');
  });
});

describe('备份与恢复', () => {
  test('创建备份并包含数据文件', async () => {
    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1', name: '测试' });
    await db.append(['events', '2026-01-01.jsonl'], '{"event":"x"}');

    const backup = new BackupService(dataDir, backupDir);
    const { path: backupPath, manifest } = await backup.create('test');

    assert.equal(manifest.fileCount, 2);
    assert.ok(manifest.checksum);
    assert.ok(fs.existsSync(path.join(backupPath, 'manifest.json')));
  });

  test('备份可验证（校验和不匹配会被发现）', async () => {
    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1' });

    const backup = new BackupService(dataDir, backupDir);
    const { path: backupPath } = await backup.create('test');

    // 正常情况：验证通过
    const ok = await backup.verify(backupPath);
    assert.equal(ok.valid, true);
    assert.equal(ok.checked, 1);

    // 篡改备份文件后：验证失败
    const target = path.join(backupPath, 'files', 'db', 'students', 'stu_1.json');
    fs.writeFileSync(target, '{"id":"tampered"}', 'utf8');

    const bad = await backup.verify(backupPath);
    assert.equal(bad.valid, false);
    assert.equal(bad.corrupted.length, 1);
  });

  test('dry-run 恢复不写入数据目录', async () => {
    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1', name: '原始' });

    const backup = new BackupService(dataDir, backupDir);
    const { path: backupPath } = await backup.create('test');

    // 改坏原数据
    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1', name: '被破坏' });

    const dry = await backup.restore(backupPath, { dryRun: true });
    assert.equal(dry.restored, 1);

    const current = await db.read<{ name: string }>([
      'db',
      'students',
      'stu_1.json',
    ]);
    assert.equal(current?.name, '被破坏', 'dry-run 不应修改数据');
  });

  test('实际恢复还原被破坏的数据', async () => {
    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1', name: '原始' });

    const backup = new BackupService(dataDir, backupDir);
    const { path: backupPath } = await backup.create('test');

    await db.write(['db', 'students', 'stu_1.json'], { id: 'stu_1', name: '被破坏' });

    const result = await backup.restore(backupPath);
    assert.equal(result.restored, 1);
    assert.equal(result.mismatched.length, 0);

    const restored = await db.read<{ name: string }>([
      'db',
      'students',
      'stu_1.json',
    ]);
    assert.equal(restored?.name, '原始', '数据应被还原');
  });

  test('列出备份按时间倒序', async () => {
    const backup = new BackupService(dataDir, backupDir);
    await backup.create('first');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await backup.create('second');

    const list = await backup.list();
    assert.equal(list.length, 2);
    assert.ok(list[0].createdAt >= list[1].createdAt);
  });

  /**
   * 回归：清单里的路径含 `..` 时，恢复不得写到 dataDir 之外。
   *
   * 历史缺陷：`restore()` 直接 `path.join(this.dataDir, entry.path)` 后 copyFile，
   * 而 `entry.path` 来自**磁盘上的清单文件**（可被篡改的数据）。
   * 清单里写 `../evil.txt` 就会把文件写到 `dataDir/../` 下 —— 实测确认可写出去。
   */
  test('恢复时拒绝清单里的穿越路径（不写到 dataDir 之外）', async () => {
    const payload = 'PWNED CONTENT';
    const sha = createHash('sha256').update(payload).digest('hex');

    // 构造一个恶意备份：清单项的 path 含 ../
    const malicious = path.join(backupDir, 'malicious');
    fs.mkdirSync(path.join(malicious, 'files'), { recursive: true });
    // source 真实存在（否则会被「缺失」分支提前跳过，测不出穿越）
    fs.writeFileSync(path.join(malicious, 'files', '..', 'evil.txt'), payload);
    fs.writeFileSync(
      path.join(malicious, 'manifest.json'),
      JSON.stringify({
        version: '1',
        createdAt: new Date().toISOString(),
        dataDir,
        fileCount: 1,
        totalBytes: payload.length,
        checksum: 'x',
        files: [{ path: '../evil.txt', size: payload.length, sha256: sha }],
      })
    );

    const backup = new BackupService(dataDir, backupDir);
    const result = await backup.restore(malicious);

    assert.equal(result.restored, 0, '穿越路径不应被恢复');
    assert.equal(
      result.skipped.length,
      1,
      '穿越路径应被跳过而不是被恢复'
    );
    assert.equal(
      fs.existsSync(path.join(path.dirname(dataDir), 'evil.txt')),
      false,
      '绝不能写到 dataDir 之外'
    );
  });

  test('校验时把穿越路径标记为非法', async () => {
    const malicious = path.join(backupDir, 'malicious2');
    fs.mkdirSync(path.join(malicious, 'files'), { recursive: true });
    fs.writeFileSync(
      path.join(malicious, 'manifest.json'),
      JSON.stringify({
        version: '1',
        createdAt: new Date().toISOString(),
        dataDir,
        fileCount: 1,
        totalBytes: 0,
        checksum: 'x',
        files: [{ path: '../evil.txt', size: 0, sha256: 'x' }],
      })
    );

    const backup = new BackupService(dataDir, backupDir);
    const result = await backup.verify(malicious);

    assert.equal(result.valid, false);
    assert.ok(
      result.corrupted.some((c) => c.includes('非法路径')),
      `应标记为非法路径，实际: ${JSON.stringify(result.corrupted)}`
    );
  });

  test('路径安全校验函数', () => {
    assert.equal(isSafeRelativePath('db/students/a.json'), true);
    assert.equal(isSafeRelativePath('files/papers/x/y.jpg'), true);

    assert.equal(isSafeRelativePath('../evil.txt'), false);
    assert.equal(isSafeRelativePath('a/../../b'), false);
    assert.equal(isSafeRelativePath('/etc/passwd'), false);
    assert.equal(isSafeRelativePath('..\\evil.txt'), false);
    assert.equal(isSafeRelativePath(''), false);
  });
});
