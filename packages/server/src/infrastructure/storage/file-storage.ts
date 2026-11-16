/**
 * 文件存储服务。
 *
 * 分离后试卷图片不再 base64 直传模型，而是：
 * 1. 上传时落盘（data/files/papers/{studentId}/{paperId}/）
 * 2. 诊断时按存储路径读取
 * 3. 访问时鉴权 —— 不提供静态目录服务
 *
 * 原设计文档 §13 特别强调：
 * 「试卷图片和学生个人信息，应采用独立访问控制，不能直接暴露文件目录。」
 *
 * 安全要点：
 * - **按学生分目录**：路径本身即隔离边界，跨学生无法通过路径猜测命中
 * - **元数据索引**：db/files/{fileId}.json 记录归属，鉴权不依赖文件名猜测
 * - **路径穿越防护**：resolveSafe 强制约束在 dataDir 内
 * - **类型与大小校验**：白名单 MIME + 上限
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileDatabase } from '../persistence/file-database.ts';

export interface StoredFile {
  id: string;
  studentId: string;
  paperId?: string;
  originalName: string;
  mimeType: string;
  size: number;
  /** 相对 DATA_DIR 的存储路径（不暴露绝对路径） */
  relativePath: string;
  createdAt: string;
}

export interface FileStorageOptions {
  dataDir: string;
  db?: FileDatabase;
  /** 单文件大小上限（字节），默认 20MB */
  maxFileSize?: number;
  /** 允许的图片 MIME 类型 */
  allowedMimeTypes?: string[];
}

const DEFAULT_ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

const INDEX_DIR = ['db', 'files'];

export class FileStorage {
  private readonly filesDir: string;
  private readonly maxFileSize: number;
  private readonly allowedMimeTypes: string[];
  private readonly options: FileStorageOptions;

  constructor(options: FileStorageOptions) {
    this.options = options;
    this.filesDir = path.join(options.dataDir, 'files');
    this.maxFileSize = options.maxFileSize ?? 20 * 1024 * 1024;
    this.allowedMimeTypes = options.allowedMimeTypes ?? DEFAULT_ALLOWED;
  }

  /**
   * 保存上传文件。
   *
   * 存储路径：`files/papers/{studentId}/{paperId|unassigned}/{fileId}.{ext}`
   */
  async save(
    buffer: Buffer,
    meta: { studentId: string; paperId?: string; originalName: string; mimeType: string }
  ): Promise<StoredFile> {
    if (!meta.studentId) {
      throw new Error('缺少 studentId');
    }
    if (buffer.length > this.maxFileSize) {
      throw new Error(
        `文件超过大小限制（${Math.floor(this.maxFileSize / 1024 / 1024)}MB）`
      );
    }
    if (!this.allowedMimeTypes.includes(meta.mimeType)) {
      throw new Error(`不支持的文件类型: ${meta.mimeType}`);
    }

    const id = `file_${randomUUID()}`;
    const ext = this.extensionFor(meta.mimeType, meta.originalName);

    // 按学生分目录 —— 存储路径即隔离边界
    const relativeDir = path.join(
      'files',
      'papers',
      this.sanitizeSegment(meta.studentId),
      this.sanitizeSegment(meta.paperId ?? 'unassigned')
    );
    const relativePath = path.join(relativeDir, `${id}${ext}`);
    const absolutePath = path.join(this.options.dataDir, relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    const stored: StoredFile = {
      id,
      studentId: meta.studentId,
      paperId: meta.paperId,
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      size: buffer.length,
      relativePath,
      createdAt: new Date().toISOString(),
    };

    // 元数据索引：鉴权不依赖文件名猜测
    await this.options.db?.write([...INDEX_DIR, `${id}.json`], stored);

    return stored;
  }

  /**
   * 读取文件元信息。
   */
  async getMeta(fileId: string): Promise<StoredFile | null> {
    if (!this.options.db) return null;
    return this.options.db.read<StoredFile>([...INDEX_DIR, `${fileId}.json`]);
  }

  /**
   * 校验调用方是否有权访问该文件。
   */
  async canAccess(fileId: string, studentId: string): Promise<boolean> {
    const meta = await this.getMeta(fileId);
    if (!meta) return false;
    return meta.studentId === studentId;
  }

  /** 读取文件内容 */
  async read(relativePath: string): Promise<Buffer | null> {
    // 路径穿越必须抛出（安全边界），不能被吞掉
    const absolute = this.resolveSafe(relativePath);
    try {
      return await fs.readFile(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** 读取文件信息 */
  async stat(relativePath: string): Promise<{
    size: number;
    mimeType: string;
  } | null> {
    try {
      const absolute = this.resolveSafe(relativePath);
      const stat = await fs.stat(absolute);
      return { size: stat.size, mimeType: this.mimeFor(absolute) };
    } catch {
      return null;
    }
  }

  async remove(relativePath: string): Promise<void> {
    try {
      await fs.rm(this.resolveSafe(relativePath), { force: true });
    } catch {
      // 忽略
    }
  }

  /** 按相对路径删除，同时清理索引 */
  async removeByFileId(fileId: string): Promise<void> {
    const meta = await this.getMeta(fileId);
    if (meta) {
      await this.remove(meta.relativePath);
      await this.options.db?.remove([...INDEX_DIR, `${fileId}.json`]);
    }
  }

  /** 列出全部上传文件（相对 dataDir 的路径） */
  async listAll(): Promise<string[]> {
    const root = path.join(this.filesDir, 'papers');
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) {
          await walk(full);
        } else if (!entry.endsWith('.tmp')) {
          out.push(path.relative(this.options.dataDir, full));
        }
      }
    };

    await walk(root);
    return out;
  }

  /**
   * 按文件 ID 查找相对路径。
   *
   * 优先走元数据索引；索引缺失时回退到路径匹配（兼容旧数据）。
   */
  async findById(fileId: string): Promise<string | null> {
    const meta = await this.getMeta(fileId);
    if (meta) return meta.relativePath;

    // 回退：按文件名匹配
    const all = await this.listAll();
    const match = all.find((p) => path.basename(p).startsWith(`${fileId}.`));
    return match ?? null;
  }

  /** 列出某学生的全部文件（按索引） */
  async listForStudent(studentId: string): Promise<StoredFile[]> {
    if (!this.options.db) return [];
    const ids = await this.options.db.list(INDEX_DIR);
    const out: StoredFile[] = [];

    for (const id of ids) {
      const meta = await this.options.db.read<StoredFile>([
        ...INDEX_DIR,
        id.replace(/\.json$/, ''),
      ]);
      if (meta && meta.studentId === studentId) out.push(meta);
    }
    return out;
  }

  /**
   * 安全路径解析：防止路径穿越（`../`）。
   */
  private resolveSafe(relativePath: string): string {
    const dataDir = path.resolve(this.options.dataDir);
    const target = path.resolve(dataDir, relativePath);

    if (!target.startsWith(dataDir + path.sep) && target !== dataDir) {
      throw new Error('非法路径');
    }
    return target;
  }

  /** 清洗路径片段：防止 studentId/paperId 注入路径分隔符 */
  private sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned.slice(0, 64) || 'unknown';
  }

  private extensionFor(mimeType: string, originalName: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'application/pdf': '.pdf',
    };
    if (map[mimeType]) return map[mimeType];
    const ext = path.extname(originalName);
    return ext && /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext : '.bin';
  }

  private mimeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.pdf': 'application/pdf',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
