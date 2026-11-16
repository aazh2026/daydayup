/**
 * 备份与恢复。
 *
 * 原设计文档 §4.3 要求：
 * 「定期备份数据目录，并验证备份可恢复。」
 *
 * 备份格式：tar 风格的 JSON 清单 + 文件内容拷贝。
 * 为了不引入第三方依赖，采用「逐文件拷贝到备份目录」的方式，
 * 恢复时反向拷贝。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logging/logger.ts';

export interface BackupManifest {
  version: string;
  createdAt: string;
  dataDir: string;
  fileCount: number;
  totalBytes: number;
  /** 每个文件的 SHA-256，用于恢复后校验 */
  files: Array<{ path: string; size: number; sha256: string }>;
  checksum: string;
}

export interface RestoreResult {
  restored: number;
  verified: number;
  mismatched: string[];
  skipped: string[];
}

const MANIFEST_NAME = 'manifest.json';
const FILES_DIR = 'files';

/** 需要纳入备份的目录（相对 dataDir） */
const BACKUP_TARGETS = ['db', 'files', 'events', 'audit', 'knowledge', 'questions'];

export class BackupService {
  constructor(
    private readonly dataDir: string,
    private readonly backupDir: string
  ) {}

  /**
   * 创建备份。
   *
   * @param label 备份标签（如日期）
   */
  async create(label: string): Promise<{ path: string; manifest: BackupManifest }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetDir = path.join(this.backupDir, `${label}-${timestamp}`);

    await fs.mkdir(path.join(targetDir, FILES_DIR), { recursive: true });

    const manifest: BackupManifest = {
      version: '1',
      createdAt: new Date().toISOString(),
      dataDir: this.dataDir,
      fileCount: 0,
      totalBytes: 0,
      files: [],
      checksum: '',
    };

    for (const target of BACKUP_TARGETS) {
      const sourceDir = path.join(this.dataDir, target);
      if (!(await this.exists(sourceDir))) continue;

      await this.copyDir(sourceDir, path.join(targetDir, FILES_DIR, target), target);
    }

    // 汇总清单
    const filesRoot = path.join(targetDir, FILES_DIR);
    manifest.files = await this.collectFiles(filesRoot);
    manifest.fileCount = manifest.files.length;
    manifest.totalBytes = manifest.files.reduce((s, f) => s + f.size, 0);
    manifest.checksum = this.computeChecksum(manifest.files);

    await fs.writeFile(
      path.join(targetDir, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    logger.info('backup.created', {
      label,
      path: targetDir,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    });

    return { path: targetDir, manifest };
  }

  /**
   * 列出可用备份。
   */
  async list(): Promise<Array<{ path: string; createdAt: string; fileCount: number; totalBytes: number }>> {
    const entries = await fs.readdir(this.backupDir, { withFileTypes: true }).catch(() => []);
    const backups = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(this.backupDir, entry.name);
      const manifest = await this.readManifest(fullPath);
      if (!manifest) continue;
      backups.push({
        path: fullPath,
        createdAt: manifest.createdAt,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
      });
    }

    backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return backups;
  }

  /**
   * 从备份恢复。
   *
   * @param backupPath 备份目录
   * @param options.dryRun 仅校验不实际写入
   */
  async restore(
    backupPath: string,
    options: { dryRun?: boolean } = {}
  ): Promise<RestoreResult> {
    const manifest = await this.readManifest(backupPath);
    if (!manifest) {
      throw new Error(`备份无效或缺少清单: ${backupPath}`);
    }

    const result: RestoreResult = {
      restored: 0,
      verified: 0,
      mismatched: [],
      skipped: [],
    };

    for (const entry of manifest.files) {
      const source = path.join(backupPath, FILES_DIR, entry.path);
      const target = path.join(this.dataDir, entry.path);

      if (!(await this.exists(source))) {
        result.skipped.push(entry.path);
        continue;
      }

      // 校验备份文件完整性
      const actualHash = await this.hashFile(source);
      if (actualHash !== entry.sha256) {
        result.mismatched.push(entry.path);
        continue;
      }

      if (!options.dryRun) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      }
      result.restored++;
    }

    logger.info('backup.restored', {
      path: backupPath,
      dryRun: Boolean(options.dryRun),
      restored: result.restored,
      mismatched: result.mismatched.length,
      skipped: result.skipped.length,
    });

    return result;
  }

  /**
   * 验证备份可恢复性（只校验，不写入）。
   *
   * 这是原设计文档明确要求的：「验证备份可恢复」。
   */
  async verify(backupPath: string): Promise<{
    valid: boolean;
    checked: number;
    corrupted: string[];
  }> {
    const manifest = await this.readManifest(backupPath);
    if (!manifest) {
      return { valid: false, checked: 0, corrupted: ['缺少清单'] };
    }

    let checked = 0;
    const corrupted: string[] = [];

    for (const entry of manifest.files) {
      const source = path.join(backupPath, FILES_DIR, entry.path);
      if (!(await this.exists(source))) {
        corrupted.push(`${entry.path}（缺失）`);
        continue;
      }
      const hash = await this.hashFile(source);
      if (hash !== entry.sha256) {
        corrupted.push(`${entry.path}（校验和不匹配）`);
        continue;
      }
      checked++;
    }

    const valid = corrupted.length === 0 && checked === manifest.files.length;

    logger.info('backup.verified', {
      path: backupPath,
      valid,
      checked,
      corrupted: corrupted.length,
    });

    return { valid, checked, corrupted };
  }

  // ---- 内部实现 ----

  private async readManifest(backupPath: string): Promise<BackupManifest | null> {
    try {
      const raw = await fs.readFile(
        path.join(backupPath, MANIFEST_NAME),
        'utf8'
      );
      return JSON.parse(raw) as BackupManifest;
    } catch {
      return null;
    }
  }

  private async copyDir(
    sourceDir: string,
    targetDir: string,
    relativeBase: string
  ): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await this.copyDir(source, target, relativeBase);
      } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        await fs.copyFile(source, target);
      }
    }
  }

  private async collectFiles(root: string): Promise<BackupManifest['files']> {
    const out: BackupManifest['files'] = [];

    const walk = async (dir: string, relativeTo: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relative = path.join(relativeTo, entry.name);
        if (entry.isDirectory()) {
          await walk(full, relative);
        } else if (entry.isFile()) {
          const stat = await fs.stat(full);
          out.push({
            path: relative,
            size: stat.size,
            sha256: await this.hashFile(full),
          });
        }
      }
    };

    await walk(root, '');
    return out;
  }

  private async hashFile(filePath: string): Promise<string> {
    const data = await fs.readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
  }

  private computeChecksum(files: BackupManifest['files']): string {
    const hash = createHash('sha256');
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`${f.path}:${f.sha256}\n`);
    }
    return hash.digest('hex');
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }
}
