/**
 * 数据保留与清理服务。
 *
 * 未成年人个人信息合规要求（原设计文档 §13）：
 * 「认证、权限隔离、数据备份、删除机制和安全审计也不能因为不引入第三方依赖而省略。」
 *
 * 本服务实现删除机制：
 * - 按保留期自动清理旧数据
 * - 支持按学生显式删除（家长/学生行使删除权）
 * - 清理操作写入审计日志
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDatabase } from '../persistence/file-database.ts';
import type { FileStorage } from '../storage/file-storage.ts';
import { logger } from '../logging/logger.ts';

export interface RetentionPolicy {
  /** 事件日志保留天数 */
  eventLogDays: number;
  /** 作答流水保留天数 */
  attemptDays: number;
  /** 已完成任务保留天数 */
  completedJobDays: number;
  /** 上传文件保留天数（试卷图片） */
  uploadDays: number;
  /** 审计日志保留天数 */
  auditLogDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  eventLogDays: 180,
  attemptDays: 365,
  completedJobDays: 30,
  uploadDays: 180,
  auditLogDays: 730,
};

export interface CleanupResult {
  deleted: {
    eventLogs: number;
    attemptLogs: number;
    jobs: number;
    uploads: number;
  };
  students: string[];
  ranAt: string;
}

export class RetentionService {
  constructor(
    private readonly db: FileDatabase,
    private readonly storage: FileStorage,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION
  ) {}

  /**
   * 清理过期数据。
   */
  async cleanup(now: Date = new Date()): Promise<CleanupResult> {
    const result: CleanupResult = {
      deleted: { eventLogs: 0, attemptLogs: 0, jobs: 0, uploads: 0 },
      students: [],
      ranAt: now.toISOString(),
    };

    // ---- 事件日志（按文件日期）----
    result.deleted.eventLogs = await this.cleanupByDate(
      ['events'],
      now,
      this.policy.eventLogDays
    );

    // ---- 作答流水（按学生目录下的日期文件）----
    result.deleted.attemptLogs = await this.cleanupAttempts(now);

    // ---- 已完成的任务 ----
    result.deleted.jobs = await this.cleanupJobs(now);

    // ---- 上传文件 ----
    result.deleted.uploads = await this.cleanupUploads(now);

    logger.info('retention.cleanup', {
      ranAt: result.ranAt,
      ...result.deleted,
    });

    return result;
  }

  /**
   * 删除某个学生的全部数据（家长/学生行使删除权）。
   *
   * @param studentId 学生 ID
   * @param audit 是否保留审计记录（合规要求应保留）
   */
  async deleteStudentData(
    studentId: string,
    options: { keepAudit?: boolean } = {}
  ): Promise<{ deletedAt: string; studentId: string }> {
    const deletedAt = new Date().toISOString();

    // 删除各聚合
    await this.db.remove(['db', 'students', `${studentId}.json`]);
    await this.db.remove(['db', 'mastery', `${studentId}.json`]);
    await this.db.remove(['db', 'attempts', studentId]);
    await this.db.remove(['db', 'coaching', studentId]);
    await this.db.remove(['db', 'plans', studentId]);
    await this.db.remove(['db', 'error-records', studentId]);

    // 删除试卷文件
    const allFiles = await this.storage.listAll();
    for (const relativePath of allFiles) {
      await this.storage.remove(relativePath);
    }

    // 删除错题记录（分散在 error-records/{studentId}/ 下）
    const errorIds = await this.db.list(['db', 'error-records', studentId]);
    for (const id of errorIds) {
      await this.db.remove([
        'db',
        'error-records',
        studentId,
        id.replace(/\.json$/, ''),
      ]);
    }

    // 审计记录（保留，合规要求可追溯）
    if (options.keepAudit !== false) {
      await this.db.append(
        ['audit', `${deletedAt.slice(0, 10)}.jsonl`],
        JSON.stringify({
          event_id: `audit_${Date.now()}`,
          event_type: 'StudentDataDeleted',
          aggregate_id: studentId,
          occurred_at: deletedAt,
          payload: {
            studentId,
            scope: 'all',
            reason: 'data_subject_request',
          },
        })
      );
    }

    logger.info('retention.student_deleted', { studentId, deletedAt });

    return { deletedAt, studentId };
  }

  /** 清理按日期命名的文件（events/） */
  private async cleanupByDate(
    dir: string[],
    now: Date,
    maxAgeDays: number
  ): Promise<number> {
    const ids = await this.db.list(dir);
    const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const id of ids) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(id);
      if (!match) continue;
      const fileTime = new Date(`${match[1]}T00:00:00.000Z`).getTime();
      if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;

      await this.db.remove([...dir, id]);
      deleted++;
    }

    return deleted;
  }

  /** 清理作答流水 */
  private async cleanupAttempts(now: Date): Promise<number> {
    const studentIds = await this.db.list(['db', 'attempts']);
    const cutoff =
      now.getTime() - this.policy.attemptDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const studentId of studentIds) {
      const files = await this.db.list(['db', 'attempts', studentId]);
      for (const file of files) {
        const match = /^(\d{4}-\d{2})\.jsonl$/.exec(file);
        if (!match) continue;
        const fileTime = new Date(`${match[1]}-01T00:00:00.000Z`).getTime();
        if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;

        await this.db.remove(['db', 'attempts', studentId, file]);
        deleted++;
      }
    }

    return deleted;
  }

  /** 清理已完成的任务 */
  private async cleanupJobs(now: Date): Promise<number> {
    const ids = await this.db.list(['db', 'jobs']);
    const cutoff =
      now.getTime() - this.policy.completedJobDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const id of ids) {
      const job = await this.db.read<{ status: string; completedAt?: string }>([
        'db',
        'jobs',
        id.replace(/\.json$/, ''),
      ]);
      if (!job) continue;
      if (job.status !== 'SUCCEEDED' && job.status !== 'FAILED' && job.status !== 'CANCELLED') {
        continue;
      }
      if (!job.completedAt) continue;
      if (new Date(job.completedAt).getTime() >= cutoff) continue;

      await this.db.remove(['db', 'jobs', id.replace(/\.json$/, '')]);
      deleted++;
    }

    return deleted;
  }

  /** 清理上传文件（按文件修改时间） */
  private async cleanupUploads(now: Date): Promise<number> {
    const allFiles = await this.storage.listAll();
    const cutoff = now.getTime() - this.policy.uploadDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const relativePath of allFiles) {
      const mtime = await this.fileMtime(relativePath);
      // 无修改时间信息时保守跳过（宁可不删，不可误删）
      if (mtime === null || mtime >= cutoff) continue;

      await this.storage.remove(relativePath);
      deleted++;
    }

    return deleted;
  }

  private async fileMtime(relativePath: string): Promise<number | null> {
    try {
      const filesDir = (
        this.storage as unknown as { options: { dataDir: string } }
      ).options.dataDir;
      const stat = await fs.stat(path.join(filesDir, relativePath));
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }
}
