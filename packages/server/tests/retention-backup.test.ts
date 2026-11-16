/**
 * 数据保留与备份测试。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { FileStorage } from '../src/infrastructure/storage/file-storage.ts';
import {
  RetentionService,
  type RetentionPolicy,
} from '../src/infrastructure/retention/retention-service.ts';
import { BackupService } from '../src/infrastructure/backup/backup-service.ts';

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
  storage = new FileStorage({ dataDir });
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
});
