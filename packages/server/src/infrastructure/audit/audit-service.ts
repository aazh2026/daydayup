/**
 * 审计服务。
 *
 * 原设计文档 §13：「安全审计也不能因为不引入第三方依赖而省略。」
 *
 * 记录范围：
 * - 数据主体权利行使（数据删除、导出）
 * - 越权尝试（403）
 * - 教师/家长访问他人学生数据
 * - AI 调用（配额消耗）
 * - 配置变更
 *
 * 审计日志只追加、不修改，保留期长于业务数据（默认 730 天）。
 */
import { randomUUID } from 'node:crypto';
import type { FileDatabase } from '../persistence/file-database.ts';
import { logger } from '../logging/logger.ts';

export type AuditEventType =
  // 数据主体权利
  | 'StudentDataDeleted'
  | 'StudentDataExported'
  // 访问
  | 'CrossStudentAccessDenied'
  | 'UnauthorizedAccessAttempt'
  | 'ParentReadOnlyViolation'
  // AI 消耗
  | 'AiQuotaExceeded'
  | 'AiCallCompleted'
  // 数据变更
  | 'StudentProfileUpdated'
  | 'ErrorRecordUpdated'
  | 'ExamResultRecorded'
  | 'PaperMetadataConfirmed'
  | 'MasteryTransitionApplied'
  | 'PlanRegenerated'
  | 'CoachingSessionSaved'
  // 运维
  | 'BackupCreated'
  | 'BackupRestored'
  | 'DataCleanupRun'
  | 'ConfigChanged';

export interface AuditEntry {
  event_id: string;
  event_type: AuditEventType;
  aggregate_id: string;
  occurred_at: string;
  actor: string;
  actor_role: string;
  ip?: string;
  request_id?: string;
  payload: Record<string, unknown>;
}

export class AuditService {
  private readonly db: FileDatabase;

  constructor(db: FileDatabase) {
    this.db = db;
  }

  /**
   * 写入审计记录。
   */
  async record(
    eventType: AuditEventType,
    params: {
      aggregateId?: string;
      actor?: string;
      actorRole?: string;
      ip?: string;
      requestId?: string;
      payload?: Record<string, unknown>;
    } = {}
  ): Promise<AuditEntry> {
    const occurredAt = new Date().toISOString();

    const entry: AuditEntry = {
      event_id: `audit_${randomUUID()}`,
      event_type: eventType,
      aggregate_id: params.aggregateId ?? '',
      occurred_at: occurredAt,
      actor: params.actor ?? 'system',
      actor_role: params.actorRole ?? 'system',
      ip: params.ip,
      request_id: params.requestId,
      payload: params.payload ?? {},
    };

    try {
      await this.db.append(
        ['audit', `${occurredAt.slice(0, 10)}.jsonl`],
        JSON.stringify(entry)
      );
    } catch (err) {
      // 审计写入失败不应影响主流程，但必须告警
      logger.error('audit.write_failed', {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return entry;
  }

  /**
   * 读取审计记录。
   */
  async read(
    options: { date?: string; limit?: number; eventType?: AuditEventType } = {}
  ): Promise<AuditEntry[]> {
    const date = options.date ?? new Date().toISOString().slice(0, 10);
    const entries = await this.db.readLines<AuditEntry>([
      'audit',
      `${date}.jsonl`,
    ]);

    let filtered = entries;
    if (options.eventType) {
      filtered = filtered.filter((e) => e.event_type === options.eventType);
    }
    filtered.reverse();

    return options.limit ? filtered.slice(0, options.limit) : filtered;
  }

  /**
   * 列出有审计记录的日期。
   */
  async listDates(): Promise<string[]> {
    const files = await this.db.list(['audit']);
    return files
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  }
}
