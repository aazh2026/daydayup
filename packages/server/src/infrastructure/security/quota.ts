/**
 * AI 用量配额。
 *
 * 现状痛点：任何人都能用你的 GEMINI_API_KEY 无限调用（真金白银）。
 * 分离后如果原样部署到公网，这是最直接的成本风险。
 *
 * 计量方式：按「调用次数」而非 token 数——
 * 原因：Gemini 侧不返回精确 token 用量，而调用次数与成本高度相关，
 * 且足以防止刷量。limit = 0 表示不限制。
 */
import { FileDatabase } from '../persistence/file-database.ts';

interface QuotaRecord {
  date: string;
  used: number;
}

export class QuotaService {
  constructor(
    private readonly db: FileDatabase,
    private readonly limit: number
  ) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private path(principalId: string): string[] {
    return ['db', 'quota', `${principalId}.json`];
  }

  async getUsed(principalId: string): Promise<number> {
    const record = await this.db.read<QuotaRecord>(this.path(principalId));
    if (!record || record.date !== this.today()) return 0;
    return record.used;
  }

  /**
   * 检查并占用一次配额。
   * 超出限额返回 false（调用方应返回 429）。
   */
  async consume(principalId: string): Promise<boolean> {
    if (this.limit <= 0) return true; // 不限制

    const current = await this.getUsed(principalId);
    if (current >= this.limit) return false;

    await this.db.write(this.path(principalId), {
      date: this.today(),
      used: current + 1,
    } satisfies QuotaRecord);
    return true;
  }

  async remaining(principalId: string): Promise<number> {
    if (this.limit <= 0) return Infinity;
    return Math.max(0, this.limit - (await this.getUsed(principalId)));
  }
}
