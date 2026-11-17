/**
 * 配置解析测试。
 *
 * 配置是全服务的开关来源，其中几项直接决定**安全性**：
 * - `AUTH_SECRET` / `AUTH_REQUIRED` → 认证是否强制、令牌用什么密钥签发
 * - `DAILY_TOKEN_QUOTA` → 成本护栏是否生效
 * - `PORT` → 服务是否监听在预期端口
 *
 * 危险之处在于**配置写错不会报错**，只会静默产生错误行为：
 * `Number('abc')` = NaN，而 NaN 让配额检查形同虚设。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/bootstrap/config.ts';

/** 临时改环境变量并在结束后还原 */
function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const AUTH_KEYS = ['AUTH_SECRET', 'AUTH_REQUIRED'];
const NUM_KEYS = [
  'PORT',
  'DAILY_TOKEN_QUOTA',
  'RETENTION_EVENT_LOG_DAYS',
  'RETENTION_ATTEMPT_DAYS',
  'RETENTION_JOB_DAYS',
  'RETENTION_UPLOAD_DAYS',
  'RETENTION_AUDIT_DAYS',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of [...AUTH_KEYS, ...NUM_KEYS]) savedEnv[k] = process.env[k];
  for (const k of [...AUTH_KEYS, ...NUM_KEYS]) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('认证配置', () => {
  test('未配置任何认证项 → 开发模式（不强制）', () => {
    const config = loadConfig();
    assert.equal(config.authRequired, false);
    assert.equal(config.authSecret, '');
  });

  test('配置 AUTH_SECRET → 强制认证', () => {
    const config = withEnv({ AUTH_SECRET: 'prod-secret' }, loadConfig);
    assert.equal(config.authRequired, true);
    assert.equal(config.authSecret, 'prod-secret');
  });

  test('AUTH_REQUIRED=false 且有密钥 → 不强制（显式覆盖）', () => {
    const config = withEnv(
      { AUTH_SECRET: 'prod-secret', AUTH_REQUIRED: 'false' },
      loadConfig
    );
    assert.equal(config.authRequired, false);
  });

  /**
   * 回归：强制认证必须有签名密钥。
   *
   * 历史缺陷：`AUTH_REQUIRED=true` 但 `AUTH_SECRET` 为空时，
   * `authRequired` 仍为 true，而 TokenService 回落到源码里写死的
   * 开发密钥（container.ts 的 'dev-insecure-secret-do-not-use-in-prod'）。
   *
   * 后果：「要求登录」却用**公开的密钥**签发令牌 ——
   * 任何人读一下源码就能伪造合法令牌，认证形同虚设。
   */
  test('强制认证但无密钥 → 回退为不强制（不留公开密钥后门）', () => {
    const config = withEnv({ AUTH_REQUIRED: 'true' }, loadConfig);
    assert.equal(
      config.authRequired,
      false,
      '没有 AUTH_SECRET 时不应强制认证（否则用公开密钥签发令牌）'
    );
  });

  test('布尔值接受常见写法', () => {
    for (const raw of ['true', 'TRUE', 'True', '1', 'yes', 'on']) {
      const config = withEnv(
        { AUTH_SECRET: 's', AUTH_REQUIRED: raw },
        loadConfig
      );
      assert.equal(config.authRequired, true, `AUTH_REQUIRED=${raw} 应为 true`);
    }
    for (const raw of ['false', 'FALSE', 'False', '0', 'no', 'off']) {
      const config = withEnv(
        { AUTH_SECRET: 's', AUTH_REQUIRED: raw },
        loadConfig
      );
      assert.equal(config.authRequired, false, `AUTH_REQUIRED=${raw} 应为 false`);
    }
  });

  test('无法识别的布尔值回落默认值并告警', () => {
    const config = withEnv(
      { AUTH_SECRET: 's', AUTH_REQUIRED: 'maybe' },
      loadConfig
    );
    // 默认值由「有无密钥」决定
    assert.equal(config.authRequired, true);
  });
});

describe('数值配置', () => {
  test('默认值正确', () => {
    const config = loadConfig();
    assert.equal(config.port, 3000);
    assert.equal(config.dailyTokenQuota, 0);
    assert.equal(config.retention.eventLogDays, 180);
    assert.equal(config.retention.attemptDays, 365);
    assert.equal(config.retention.completedJobDays, 30);
    assert.equal(config.retention.uploadDays, 180);
    assert.equal(config.retention.auditLogDays, 730);
  });

  test('合法数字被采用', () => {
    const config = withEnv(
      { PORT: '8080', DAILY_TOKEN_QUOTA: '100', RETENTION_JOB_DAYS: '7' },
      loadConfig
    );
    assert.equal(config.port, 8080);
    assert.equal(config.dailyTokenQuota, 100);
    assert.equal(config.retention.completedJobDays, 7);
  });

  /**
   * 回归：非法数字不能变成 NaN。
   *
   * `Number('abc')` = NaN。NaN 的危险在于**静默破坏语义**：
   * - `DAILY_TOKEN_QUOTA=abc` → `NaN <= 0` 为 false（不走「不限制」分支），
   *   而 `used >= NaN` 恒为 false → **配额检查永远放行，成本护栏消失**
   * - `PORT=abc` → `listen(NaN)` 行为不可预期
   */
  test('非法数字回落默认值（不是 NaN）', () => {
    const config = withEnv(
      {
        PORT: 'abc',
        DAILY_TOKEN_QUOTA: 'xyz',
        RETENTION_EVENT_LOG_DAYS: 'not-a-number',
      },
      loadConfig
    );

    assert.equal(config.port, 3000);
    assert.equal(config.dailyTokenQuota, 0);
    assert.equal(config.retention.eventLogDays, 180);

    // 关键：不得出现 NaN
    assert.ok(Number.isFinite(config.port), 'port 不得为 NaN');
    assert.ok(
      Number.isFinite(config.dailyTokenQuota),
      '配额不得为 NaN（否则护栏失效）'
    );
  });

  test('空字符串按未设置处理', () => {
    const config = withEnv({ PORT: '', DAILY_TOKEN_QUOTA: '  ' }, loadConfig);
    assert.equal(config.port, 3000);
    assert.equal(config.dailyTokenQuota, 0);
  });

  test('小数被接受', () => {
    const config = withEnv({ DAILY_TOKEN_QUOTA: '10.5' }, loadConfig);
    assert.equal(config.dailyTokenQuota, 10.5);
  });

  test('Infinity 被拒绝（回落默认值）', () => {
    const config = withEnv({ DAILY_TOKEN_QUOTA: 'Infinity' }, loadConfig);
    assert.equal(config.dailyTokenQuota, 0);
  });
});

describe('跨域来源', () => {
  test('默认单一来源', () => {
    const config = withEnv({ CORS_ORIGINS: undefined }, loadConfig);
    assert.deepEqual(config.corsOrigins, ['http://localhost:5173']);
  });

  test('多个来源被拆分并裁剪空白', () => {
    const config = withEnv(
      { CORS_ORIGINS: ' http://a.com , ,http://b.com ' },
      loadConfig
    );
    assert.deepEqual(config.corsOrigins, ['http://a.com', 'http://b.com']);
  });

  test('空项被过滤掉', () => {
    const config = withEnv({ CORS_ORIGINS: 'http://a.com,,http://b.com' }, loadConfig);
    assert.deepEqual(config.corsOrigins, ['http://a.com', 'http://b.com']);
  });
});

describe('路径配置', () => {
  test('DATA_DIR 被解析为绝对路径', () => {
    const config = withEnv({ DATA_DIR: 'relative/dir' }, loadConfig);
    assert.ok(path.isAbsolute(config.dataDir), 'DATA_DIR 应解析为绝对路径');
  });

  test('未配置 STATIC_DIR 时为空（不托管前端）', () => {
    const config = withEnv({ STATIC_DIR: undefined }, loadConfig);
    assert.equal(config.staticDir, '');
  });

  test('配置 STATIC_DIR 时为绝对路径', () => {
    const config = withEnv({ STATIC_DIR: 'web/dist' }, loadConfig);
    assert.ok(path.isAbsolute(config.staticDir));
  });
});
