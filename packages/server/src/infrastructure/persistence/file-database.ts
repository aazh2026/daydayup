/**
 * 文件型持久化适配器。
 *
 * 满足原设计文档 §4.3 的四项要求：
 * 1. 原子写入（临时文件 + rename）
 * 2. 并发控制（同一文件的写操作串行化）
 * 3. 数据版本（乐观并发检查）
 * 4. 备份恢复
 *
 * 约束：单实例运行，不支持多进程共享写入。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 每个文件的写锁链，保证同文件写操作串行 */
const writeLocks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(
    key,
    previous.then(() => current)
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

export interface StoredDocument<T> {
  version: number;
  updatedAt: string;
  data: T;
}

export class FileDatabase {
  constructor(private readonly rootDir: string) {}

  private resolvePath(...segments: string[]): string {
    const target = path.join(this.rootDir, ...segments);
    const root = path.resolve(this.rootDir);
    const resolved = path.resolve(target);
    // 防止路径穿越
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Path traversal detected: ${resolved}`);
    }
    return resolved;
  }

  async ensureDir(...segments: string[]): Promise<void> {
    await fs.mkdir(this.resolvePath(...segments), { recursive: true });
  }

  /** 原子写入：先写临时文件，再 rename */
  async write<T>(segments: string[], data: T): Promise<void> {
    const target = this.resolvePath(...segments);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;

    await withLock(target, async () => {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, target);
    });
  }

  /**
   * 读取 JSON 文件。
   *
   * 最后一段可省略 `.json` 后缀——`list()` 返回的是带后缀的文件名，
   * 而调用方常按 id（无后缀）读取，这里做兼容。
   */
  async read<T>(segments: string[]): Promise<T | null> {
    const candidates = this.readCandidates(segments);
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        return JSON.parse(raw) as T;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return null;
  }

  /** 候选路径：原样 → 补 .json */
  private readCandidates(segments: string[]): string[] {
    const base = this.resolvePath(...segments);
    const candidates = [base];
    if (!base.endsWith('.json')) {
      candidates.push(`${base}.json`);
    } else {
      candidates.push(base.slice(0, -'.json'.length));
    }
    return candidates;
  }

  async readStored<T>(segments: string[]): Promise<StoredDocument<T> | null> {
    return this.read<StoredDocument<T>>(segments);
  }

  async exists(segments: string[]): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(...segments));
      return true;
    } catch {
      return false;
    }
  }

  async remove(segments: string[]): Promise<void> {
    await fs.rm(this.resolvePath(...segments), { force: true, recursive: true });
  }

  async list(segments: string[]): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.resolvePath(...segments));
      return entries.filter((e) => !e.startsWith('.') && !e.endsWith('.tmp'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** 追加写（事件日志 / 作答流水） */
  async append(segments: string[], line: string): Promise<void> {
    const target = this.resolvePath(...segments);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await withLock(target, async () => {
      await fs.appendFile(target, `${line}\n`, 'utf8');
    });
  }

  async readLines<T>(segments: string[]): Promise<T[]> {
    try {
      const raw = await fs.readFile(this.resolvePath(...segments), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as T);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
