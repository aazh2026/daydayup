/**
 * 文件存储服务。
 *
 * 分离后试卷图片不再 base64 直传模型，而是：
 * 1. 上传时落盘（data/files/papers/{paperId}/）
 * 2. 诊断时按 paperId 读取
 * 3. 访问时鉴权 —— 不提供静态目录服务
 *
 * 原设计文档 §13 特别强调：
 * 「试卷图片和学生个人信息，应采用独立访问控制，不能直接暴露文件目录。」
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

export class FileStorage {
  private readonly filesDir: string;
  private readonly maxFileSize: number;
  private readonly allowedMimeTypes: string[];

  constructor(private readonly options: FileStorageOptions) {
    this.filesDir = path.join(options.dataDir, 'files');
    this.maxFileSize = options.maxFileSize ?? 20 * 1024 * 1024;
    this.allowedMimeTypes = options.allowedMimeTypes ?? DEFAULT_ALLOWED;
  }

  /**
   * 保存上传文件。
   *
   * @param buffer 文件内容
   * @param meta 文件元信息
   */
  async save(
    buffer: Buffer,
    meta: { studentId: string; paperId?: string; originalName: string; mimeType: string }
  ): Promise<StoredFile> {
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
    const relativeDir = path.join('files', 'papers', meta.paperId ?? 'unassigned');
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

    return stored;
  }

  /** 读取文件内容 */
  async read(relativePath: string): Promise<Buffer | null> {
    try {
      const absolute = this.resolveSafe(relativePath);
      return await fs.readFile(absolute);
    } catch {
      return null;
    }
  }

  /** 读取文件元信息（从路径推断） */
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

  /**
   * 列出全部上传文件（相对 dataDir 的路径）。
   *
   * 注：当前存储结构未按学生分目录，因此无法仅凭路径过滤学生。
   * 需要按学生隔离时应改为 `{studentId}/{paperId}/` 三级目录。
   */
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
   * 文件名格式：`file_{uuid}.{ext}`，位于 `files/papers/{paperId}/` 下。
   */
  async findById(fileId: string): Promise<string | null> {
    const all = await this.listAll();
    const match = all.find((p) => path.basename(p).startsWith(`${fileId}.`));
    return match ?? null;
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
    return ext || '.bin';
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
