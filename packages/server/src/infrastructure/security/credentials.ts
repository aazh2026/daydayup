/**
 * 凭证存储：学生 PIN ↔ Token 的映射。
 *
 * 现状痛点：server.ts 的 5 个接口全部无鉴权，任何人都能用
 * 你的 GEMINI_API_KEY 无限调用（真金白银）。
 *
 * 存储用文件（保持零外部基础设施），支持后续替换为数据库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Role } from './token.ts';

export interface Credential {
  /** 主体 ID */
  principalId: string;
  /** 登录凭证（学生为 PIN，家长/老师为 API Key） */
  secret: string;
  role: Role;
  /** 可访问的学生 ID 列表 */
  studentIds: string[];
  displayName?: string;
  disabled?: boolean;
}

export interface CredentialStore {
  findBySecret(secret: string): Promise<Credential | null>;
  list(): Promise<Credential[]>;
}

export class FileCredentialStore implements CredentialStore {
  private cache: Credential[] | null = null;

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Credential[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as Credential[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = [];
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  async findBySecret(secret: string): Promise<Credential | null> {
    const all = await this.load();
    const found = all.find((c) => c.secret === secret && !c.disabled);
    return found ?? null;
  }

  async list(): Promise<Credential[]> {
    return this.load();
  }

  async reload(): Promise<void> {
    this.cache = null;
    await this.load();
  }
}

/**
 * 内存凭证存储（测试与开发用）。
 */
export class MemoryCredentialStore implements CredentialStore {
  constructor(private credentials: Credential[]) {}

  async findBySecret(secret: string): Promise<Credential | null> {
    return this.credentials.find((c) => c.secret === secret && !c.disabled) ?? null;
  }

  async list(): Promise<Credential[]> {
    return this.credentials;
  }
}

/**
 * 开发模式凭证：
 * 未配置 AUTH_SECRET 时启用，允许用 demo PIN 登录。
 *
 * 生产环境必须配置 AUTH_SECRET，否则此模式不启用。
 */
export function createDefaultCredentials(): Credential[] {
  return [
    {
      principalId: 'demo-student',
      secret: '1234',
      role: 'student',
      studentIds: ['stu-sh-zhangwei'],
      displayName: '张伟',
    },
  ];
}

/**
 * 解析凭证存储。
 *
 * - 配置了 AUTH_SECRET：读取 db/credentials.json（文件不存在时回落到内存默认凭证，
 *   保证首次部署不会因缺文件而无法登录）
 * - 未配置：使用内存演示凭证（仅本地开发）
 */
export function resolveCredentialStore(
  dataDir: string,
  authSecret: string
): CredentialStore {
  const fileStore = new FileCredentialStore(
    path.join(dataDir, 'db', 'credentials.json')
  );
  const fallback = new MemoryCredentialStore(createDefaultCredentials());

  if (!authSecret) {
    // 开发模式：直接用内存凭证
    return fallback;
  }

  // 生产模式：文件凭证优先，文件缺失时回落默认凭证（便于首次部署）
  return {
    async findBySecret(secret: string) {
      const found = await fileStore.findBySecret(secret);
      return found ?? (await fallback.findBySecret(secret));
    },
    async list() {
      const fileList = await fileStore.list();
      return fileList.length > 0 ? fileList : fallback.list();
    },
  };
}
