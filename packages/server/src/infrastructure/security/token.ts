/**
 * 无状态 Token 签发与校验（HMAC-SHA256）。
 *
 * 为什么自研而非引入第三方 auth 框架：
 * - 保持「零外部基础设施」约束
 * - 需求简单（三种角色：学生/家长/老师），无需 OAuth/OIDC 的复杂度
 * - 无状态：不需要 session 存储，天然水平扩展友好
 *
 * 安全要点：
 * - 签名用 timingSafeEqual，避免时序攻击
 * - payload 带 exp，过期即失效
 * - studentIds 决定资源级访问范围，服务端强制校验
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Role = 'student' | 'parent' | 'teacher';

export interface TokenPayload {
  /** 主体 ID（用户） */
  sub: string;
  /** 可访问的学生 ID 列表 —— 资源级鉴权的依据 */
  sids: string[];
  role: Role;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 小时

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

export class TokenService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(secret: string, ttlSeconds: number = TOKEN_TTL_SECONDS) {
    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * 签发 token。
   *
   * @param sub 主体 ID
   * @param sids 可访问的学生 ID 列表
   * @param role 角色
   */
  issue(sub: string, sids: string[], role: Role): IssuedToken {
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      sub,
      sids,
      role,
      iat: now,
      exp: now + this.ttlSeconds,
    };

    const payloadB64 = base64url(JSON.stringify(payload));
    const signature = base64url(this.sign(payloadB64));

    return {
      token: `${payloadB64}.${signature}`,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /** 校验并解析 token，失败返回 null */
  verify(token: string): TokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadB64, signature] = parts;

    const expected = Buffer.from(this.sign(payloadB64));
    const actual = fromBase64url(signature);

    // 长度不等时 timingSafeEqual 会抛错，先比长度
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(fromBase64url(payloadB64).toString('utf8')) as TokenPayload;
    } catch {
      return null;
    }

    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (!Array.isArray(payload.sids)) return null;

    return payload;
  }

  private sign(payloadB64: string): Buffer {
    return createHmac('sha256', this.secret).update(payloadB64).digest();
  }
}

/**
 * 生成开发用 API Key。
 *
 * 生产环境应由管理员分配，此处仅提供生成工具。
 */
export function generateApiKey(): string {
  return `dk_${randomBytes(24).toString('hex')}`;
}
