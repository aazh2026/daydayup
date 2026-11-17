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
  private readonly db: FileDatabase;
  private readonly limit: number;

  /**
   * 按账号串行化「读-判-写」三步。
   *
   * 为什么必须加锁：原实现是
   *   const current = await getUsed();       // 读
   *   if (current >= limit) return false;    // 判
   *   await write({ used: current + 1 });    // 写
   * 三步之间有 await，并发请求会全部读到同一个 `current`，
   * 于是**全部通过检查**，且全部写成 `current + 1`。
   *
   * 实测：限额 5 时并发 20 个请求 → **20 个全部放行**，
   * 记录到的用量却只有 1 —— 成本护栏在并发下完全失效，
   * 而「并发发请求」正是刷量的典型手法。
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  private async withLock<T>(principalId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(principalId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(principalId, previous.then(() => current));
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(principalId) === current) this.locks.delete(principalId);
    }
  }

  constructor(db: FileDatabase, limit: number) {
    this.db = db;
    this.limit = limit;
  }

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
   *
   * 整个「读-判-写」在同一把账号锁内完成，保证并发下不会超发。
   */
  async consume(principalId: string): Promise<boolean> {
    if (this.limit <= 0) return true; // 不限制

    return this.withLock(principalId, async () => {
      const current = await this.getUsed(principalId);
      if (current >= this.limit) return false;

      await this.db.write(this.path(principalId), {
        date: this.today(),
        used: current + 1,
      } satisfies QuotaRecord);
      return true;
    });
  }

  async remaining(principalId: string): Promise<number> {
    if (this.limit <= 0) return Infinity;
    return Math.max(0, this.limit - (await this.getUsed(principalId)));
  }
}
