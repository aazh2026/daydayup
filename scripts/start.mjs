#!/usr/bin/env node
/**
 * 一键启动前后端。
 *
 * 用法：
 *   npm start              启动前后端（开发模式）
 *   npm start -- --no-web  只启动后端
 *   npm start -- --no-srv  只启动前端
 *   npm start -- --seed    启动前先播种演示数据
 *   npm start -- --build   先构建前端产物再启动
 *   npm start -- --prod    生产模式（服务端免编译 + 托管前端产物）
 *   npm start -- --port 4000  指定后端端口
 *
 * 特性：
 * - 自动检查并安装依赖
 * - 自动检查 .env（缺失则从 .env.example 生成）
 * - 自动播种演示数据（首次启动）
 * - 端口占用检测与提示
 * - 统一彩色输出 + 优雅退出（Ctrl+C 同时停止两端）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const customPort =
  portArgIndex !== -1 ? Number(args[portArgIndex + 1]) : undefined;

const flags = {
  web: !args.includes('--no-web'),
  server: !args.includes('--no-srv'),
  seed: args.includes('--seed'),
  build: args.includes('--build'),
  prod: args.includes('--prod'),
};

// ---- 彩色输出 ----
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${c.cyan}[启动]${c.reset} ${msg}`),
  ok: (msg) => console.log(`${c.green}[完成]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[提示]${c.reset} ${msg}`),
  err: (msg) => console.log(`${c.red}[错误]${c.reset} ${msg}`),
  step: (msg) => console.log(`${c.bold}${c.magenta}▸ ${msg}${c.reset}`),
};

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
}

/**
 * 探测端口是否被占用。
 *
 * 注意：需同时尝试 IPv4 与 IPv6——
 * Vite 默认绑定 IPv6 localhost（[::1]），只探 127.0.0.1 会漏判。
 */
function isPortInUse(port) {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const net=require('net');
       const hosts=['127.0.0.1','::1'];
       let pending=hosts.length, found=false;
       for(const host of hosts){
         const s=net.connect(${port},host);
         s.on('connect',()=>{found=true;s.destroy();if(--pending===0)process.exit(found?0:1)});
         s.on('error',()=>{if(--pending===0)process.exit(found?0:1)});
       }
       setTimeout(()=>process.exit(found?0:1),1200);`,
    ],
    { stdio: 'ignore' }
  );
  return probe.status === 0;
}

async function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 读取 .env */
function loadEnvFile() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 去掉引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function main() {
  console.log('');
  console.log(
    `${c.bold}${c.blue}  智学中枢 · 上海初三 AI 提分系统${c.reset}`
  );
  console.log(`${c.dim}  ─────────────────────────────────────────${c.reset}`);
  console.log('');

  // ---- 1. Node 版本检查 ----
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    log.err(`Node.js 版本过低（当前 ${process.versions.node}，需要 22+）`);
    process.exit(1);
  }
  log.ok(`Node.js ${process.versions.node}`);

  // ---- 2. 依赖检查 ----
  const nodeModules = path.join(root, 'node_modules');
  const needsInstall =
    !fs.existsSync(nodeModules) ||
    !fs.existsSync(path.join(nodeModules, 'express')) ||
    !fs.existsSync(path.join(nodeModules, 'react'));

  if (needsInstall) {
    log.step('安装依赖…');
    const result = run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']);
    if (result.status !== 0) {
      log.err('依赖安装失败');
      process.exit(1);
    }
    log.ok('依赖安装完成');
  } else {
    log.ok('依赖已就绪');
  }

  // ---- 3. 环境变量 ----
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
      log.warn('.env 不存在，已从 .env.example 生成');
      log.warn('如需启用 AI 能力，请编辑 .env 填入 GEMINI_API_KEY');
    }
  }

  const fileEnv = loadEnvFile();
  const serverEnv = {
    ...process.env,
    ...fileEnv,
  };

  const hasApiKey = Boolean(serverEnv.GEMINI_API_KEY);
  if (!hasApiKey) {
    log.warn('未配置 GEMINI_API_KEY —— AI 功能不可用，其余功能正常');
  } else {
    log.ok('GEMINI_API_KEY 已配置');
  }

  // 开发模式不需要 AUTH_SECRET（生产必须）
  if (!flags.prod && !serverEnv.AUTH_SECRET) {
    serverEnv.AUTH_SECRET = 'dev-insecure-secret-do-not-use-in-prod';
    serverEnv.AUTH_REQUIRED = 'false';
    log.info('开发模式：不要求登录（演示 PIN 1234）');
  }

  // 生产模式：后端一并托管前端产物（单进程单端口）
  if (flags.prod) {
    serverEnv.STATIC_DIR = serverEnv.STATIC_DIR ?? path.join(root, 'web/dist');
  }

  // ---- 4. 端口检查 ----
  const serverPort = customPort ?? Number(serverEnv.PORT ?? 3000);
  const webPort = 5173;

  if (flags.server && isPortInUse(serverPort)) {
    log.err(`端口 ${serverPort} 已被占用 —— 请先停止占用进程，或设置 PORT 环境变量`);
    process.exit(1);
  }
  if (flags.web && !flags.prod && isPortInUse(webPort)) {
    log.err(`端口 ${webPort} 已被占用 —— 请先停止占用进程`);
    process.exit(1);
  }

  // ---- 5. 播种数据 ----
  const seedPath = path.join(root, 'packages/server/data/seed/demo-student.json');
  const studentPath = path.join(root, 'packages/server/data/db/students');
  const needsSeed = flags.seed || !fs.existsSync(studentPath);

  if (flags.server && needsSeed && fs.existsSync(seedPath)) {
    log.step('播种演示数据…');
    const result = run(
      'npx',
      ['tsx', 'packages/server/scripts/seed.ts'],
      { env: { ...serverEnv, DATA_DIR: path.join(root, 'packages/server/data') } }
    );
    if (result.status === 0) log.ok('演示数据已就绪');
    else log.warn('播种失败（可稍后手动执行 npm run seed）');
  }

  // ---- 6. 构建前端（生产模式） ----
  if (flags.build || flags.prod) {
    log.step('构建前端产物…');
    const result = run('npm', ['run', 'build', '--workspace=@daydayup/web']);
    if (result.status !== 0) {
      log.err('前端构建失败');
      process.exit(1);
    }
    log.ok('前端构建完成');
  }

  // ---- 7. 启动 ----
  const children = [];
  let shuttingDown = false;

  const prefix = (label, color) => (data) => {
    const text = data.toString();
    const lines = text.split('\n').filter((l, i, arr) => l.trim() || i < arr.length - 1);
    for (const line of lines) {
      console.log(`${color}[${label}]${c.reset} ${line}`);
    }
  };

  if (flags.server) {
    log.step(`启动后端 :${serverPort}`);

    let server;
    if (flags.prod) {
      // 生产模式：Node 原生类型剥离，免编译
      // 直接调用 node 而非 npx，避免 npm 误解析 --experimental-strip-types
      server = spawn(
        process.execPath,
        ['--experimental-strip-types', 'packages/server/src/main.ts'],
        {
          cwd: root,
          env: serverEnv,
          shell: process.platform === 'win32',
        }
      );
    } else {
      // 开发模式：tsx watch（热重载）
      server = spawn('npx', ['tsx', 'watch', 'src/main.ts'], {
        cwd: path.join(root, 'packages/server'),
        env: serverEnv,
        shell: process.platform === 'win32',
      });
    }

    server.stdout.on('data', prefix('后端', c.green));
    server.stderr.on('data', prefix('后端', c.green));
    children.push(server);
  }

  if (flags.web && !flags.prod) {
    log.step(`启动前端 :${webPort}`);
    const web = spawn(
      'npx',
      ['vite', '--port', String(webPort), '--host', '127.0.0.1', '--strictPort'],
      {
        cwd: path.join(root, 'web'),
        env: { ...process.env, ...fileEnv },
        shell: process.platform === 'win32',
      }
    );
    web.stdout.on('data', prefix('前端', c.blue));
    web.stderr.on('data', prefix('前端', c.blue));
    children.push(web);
  }

  // ---- 8. 就绪提示 ----
  const readyChecks = [];
  if (flags.server) readyChecks.push(waitForPort(serverPort));
  if (flags.web && !flags.prod) readyChecks.push(waitForPort(webPort));
  await Promise.all(readyChecks);

  console.log('');
  console.log(`${c.dim}  ─────────────────────────────────────────${c.reset}`);
  console.log(`${c.green}${c.bold}  ✓ 服务已启动${c.reset}`);
  console.log('');
  if (flags.prod) {
    console.log(`     应用    ${c.cyan}http://localhost:${serverPort}${c.reset}`);
    console.log(`     API     ${c.dim}http://localhost:${serverPort}/api/v1${c.reset}`);
  } else {
    if (flags.web) {
      console.log(`     前端    ${c.cyan}http://localhost:${webPort}${c.reset}`);
    }
    if (flags.server) {
      console.log(`     后端    ${c.cyan}http://localhost:${serverPort}/api/v1/health${c.reset}`);
    }
    if (flags.web && flags.server) {
      console.log(`     API     ${c.dim}http://localhost:${serverPort}/api/v1${c.reset}`);
    }
  }
  if (!hasApiKey) {
    console.log('');
    console.log(`     ${c.yellow}提示：AI 功能未启用（缺少 GEMINI_API_KEY）${c.reset}`);
  }
  console.log('');
  console.log(`${c.dim}     按 Ctrl+C 停止全部服务${c.reset}`);
  console.log('');

  // ---- 9. 优雅退出 ----
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    log.info(`收到 ${signal}，正在停止服务…`);
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略
      }
    }
    setTimeout(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略
        }
      }
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 子进程意外退出时一并停止其他进程
  for (const child of children) {
    child.on('exit', (code) => {
      if (!shuttingDown) {
        log.err(`子进程退出（code ${code}），正在停止其余服务…`);
        shutdown('child-exit');
      }
    });
  }
}

main().catch((err) => {
  log.err(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
