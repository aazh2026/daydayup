/**
 * E2E 测试：登录 → 教师工作台 → 学生数据边界。
 *
 * 与旧版的区别：
 * - 旧版只 `console.log`，**永远不会失败**（没有断言）
 * - 旧版依赖人工预先启动前后端 + 硬编码凭证
 *
 * 本版：
 * - 自举：临时数据目录 + 自建凭证 + 自动启动前后端
 * - 真实断言：失败即非零退出码
 *
 * 运行：npm run test:e2e
 * 前置：npx playwright install chromium
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const SERVER_PORT = 34567;
const WEB_PORT = 34568;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const TEACHER_SECRET = 'e2e-teacher-key';
const PARENT_SECRET = 'e2e-parent-key';
const STUDENT_SECRET = 'e2e-student-key';
const STUDENT_ID = 'stu-e2e';

// ---- 断言工具 ----
const failures = [];
let checkCount = 0;

function check(condition, message, detail) {
  checkCount += 1;
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
    failures.push(message);
  }
}

function checkEqual(actual, expected, message) {
  check(actual === expected, message, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ---- 环境准备 ----
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-e2e-'));
const children = [];

function startProcess(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] 退出码 ${code}\n${log.join('')}`);
    }
  });
  children.push(child);
  return child;
}

async function waitForPort(port, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function cleanup() {
  for (const child of children) {
    try {
      // 杀掉整个进程组（vite 会再拉起 esbuild 子进程）
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    } catch {
      // 忽略
    }
  }
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
}

async function main() {
  // ---- 播种演示数据（否则教师工作台没有学生可展示）----
  fs.mkdirSync(path.join(tmpDataDir, 'seed'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'packages/server/data/seed/demo-student.json'),
    path.join(tmpDataDir, 'seed', 'demo-student.json')
  );
  await new Promise((resolve) => {
    const seed = spawnSync(
      'npx',
      ['tsx', 'scripts/seed.ts'],
      {
        cwd: path.join(root, 'packages/server'),
        env: { ...process.env, DATA_DIR: tmpDataDir },
        encoding: 'utf8',
      }
    );
    if (seed.status !== 0) {
      console.error('播种失败:', seed.stderr || seed.stdout);
    }
    resolve();
  });

  // 凭证文件（三种角色）
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      { principalId: 'teacher-e2e', secret: TEACHER_SECRET, role: 'teacher', studentIds: [], displayName: '王老师' },
      { principalId: 'parent-e2e', secret: PARENT_SECRET, role: 'parent', studentIds: [STUDENT_ID], displayName: '张爸爸' },
      { principalId: 'student-e2e', secret: STUDENT_SECRET, role: 'student', studentIds: [STUDENT_ID], displayName: '张伟' },
    ])
  );

  console.log('启动后端…');
  startProcess('server', 'npx', ['tsx', 'src/main.ts'], {
    cwd: path.join(root, 'packages/server'),
    env: {
      DATA_DIR: tmpDataDir,
      AUTH_SECRET: 'e2e-test-secret',
      PORT: String(SERVER_PORT),
      HOST: '127.0.0.1',
      GEMINI_API_KEY: '',
      LOG_LEVEL: 'error',
      CORS_ORIGINS: WEB_URL,
    },
  });

  if (!(await waitForPort(SERVER_PORT))) {
    throw new Error('后端启动超时');
  }
  console.log('后端就绪');

  console.log('启动前端…');
  startProcess(
    'web',
    'npx',
    ['vite', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(root, 'web'),
      env: {
        VITE_API_PROXY: SERVER_URL,
        DISABLE_HMR: 'true',
      },
    }
  );

  // 前端启动后访问 /api/health（经 vite proxy 转发到后端）
  const webReady = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      try {
        const res = await fetch(`${WEB_URL}/api/health`);
        if (res.ok) return true;
      } catch {
        // 还没起来
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();
  if (!webReady) throw new Error('前端启动超时');
  console.log('前端就绪\n');

  // ================= 测试开始 =================
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const pageErrors = [];
  const consoleErrors = [];
  const apiCalls = [];

  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/v1/')) {
      apiCalls.push({ p: new URL(u).pathname, s: res.status() });
    }
  });

  // ---- 1. 登录页 ----
  console.log('▶ 登录页');
  await page.goto(WEB_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-secret', { timeout: 15_000 }).catch(() => {});

  const hasLoginForm = (await page.locator('#login-secret').count()) > 0;
  check(hasLoginForm, '未登录时显示登录页');

  // ---- 2. 错误凭证被拒绝 ----
  console.log('\n▶ 错误凭证');
  await page.locator('#login-secret').fill('wrong-secret');
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(1200);
  const bodyAfterFail = await page.locator('body').innerText();
  check(
    bodyAfterFail.includes('凭证无效') || bodyAfterFail.includes('失败'),
    '错误凭证显示错误提示'
  );
  check(
    (await page.locator('#login-secret').count()) > 0,
    '登录失败后仍停留在登录页'
  );

  // ---- 3. 教师登录 ----
  console.log('\n▶ 教师登录');
  await page.locator('#login-secret').fill(TEACHER_SECRET);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(2500);

  const navText = await page.locator('header').innerText();
  check(navText.includes('教师'), '顶部显示教师角色标识', navText.slice(0, 80));
  check(navText.includes('教师工作台'), '教师可见「教师工作台」入口');

  // ---- 4. 教师工作台 ----
  console.log('\n▶ 教师工作台');
  let dashOpened = true;
  try {
    await page.locator('text=教师工作台').first().click();
    await page.waitForTimeout(2500);
  } catch (e) {
    dashOpened = false;
    console.log(`  ! 点击失败: ${e.message.split('\n')[0]}`);
  }
  check(dashOpened, '可打开教师工作台');

  if (dashOpened) {
    const dashText = await page.locator('body').innerText();
    check(dashText.length > 100, '工作台渲染出内容');
    check(
      dashText.includes('已掌握') || dashText.includes('掌握度'),
      '工作台展示掌握度信息'
    );
    check(
      dashText.includes('优先提升') || dashText.includes('优先提分'),
      '工作台展示优先提分点'
    );
  }

  // ---- 5. localStorage 边界 ----
  console.log('\n▶ localStorage 边界');
  const storageKeys = await page.evaluate(() => Object.keys(localStorage));
  const businessKeys = storageKeys.filter((k) =>
    k.includes('shanghai_ai_score_os') || k.includes('appstate')
  );
  checkEqual(businessKeys.length, 0, 'localStorage 不含业务数据 key');
  check(
    storageKeys.some((k) => k.includes('token') || k.includes('auth')),
    'localStorage 保留访问令牌',
    storageKeys.join(', ')
  );

  // 遗留 key 应被清理
  await page.evaluate(() => {
    localStorage.setItem('shanghai_ai_score_os_v5', JSON.stringify({ student: {} }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const legacyGone = await page.evaluate(
    () => localStorage.getItem('shanghai_ai_score_os_v5') === null
  );
  check(legacyGone, '遗留业务数据 key 在加载后被清理');

  // ---- 5b. 畸形知识体系快照不应让应用白屏 ----
  console.log('\n▶ 畸形知识体系快照容错');
  const errorsBefore = pageErrors.length;
  await page.evaluate(() => {
    // 快照里混入 null / 缺字段的元素 —— 写入被中断或旧版本应用可能造成
    localStorage.setItem(
      'daydayup.curriculum.snapshot',
      JSON.stringify({
        version: 'v1',
        knowledgePoints: [null, {}, { id: 'kp-x' }],
      })
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const stillAlive = await page.evaluate(() => document.body.innerText.length);
  check(
    stillAlive > 100,
    '畸形快照下应用仍正常渲染（不应白屏）',
    `页面内容长度 ${stillAlive}`
  );
  const newErrors = pageErrors.slice(errorsBefore);
  checkEqual(
    newErrors.length,
    0,
    '畸形快照不产生未捕获异常',
    newErrors.join(' | ')
  );

  // 恢复正常的快照（由服务端重新拉取）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // ---- 6. 无致命错误 ----
  console.log('\n▶ 运行时错误');
  const fatalConsole = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource') && !e.includes('401')
  );
  checkEqual(pageErrors.length, 0, '无未捕获的页面异常');
  checkEqual(fatalConsole.length, 0, '无致命 console 错误', fatalConsole.join(' | '));

  // ---- 7. API 调用合理性 ----
  console.log('\n▶ API 调用');
  /**
   * 登录后的会话不应出现 401/403。
   *
   * 注意：**错误凭证那次 401 是预期的**（用例刻意验证登录失败），
   * 因此这里只看**非登录类**调用的状态码 ——
   * 登录接口的状态码在下面单独断言。
   *
   * （不能用 `slice(loginCalls.length)` 定位登录之后的调用：
   * 那是按「过滤后数组的下标」切，而登录调用在原始序列里的位置通常更靠后，
   * 切出来的尾巴里仍会包含那次预期内的 401。）
   */
  const loginCalls = apiCalls.filter((c) => c.p === '/api/v1/auth/login');
  const otherCalls = apiCalls.filter((c) => c.p !== '/api/v1/auth/login');
  const authFailures = otherCalls.filter((c) => c.s === 401 || c.s === 403);
  checkEqual(
    authFailures.length,
    0,
    '登录后无 401/403 响应',
    JSON.stringify(authFailures)
  );

  // 登录本身：第一次（错误凭证）应 401，第二次（正确凭证）应 200
  checkEqual(loginCalls[0]?.s, 401, '错误凭证登录返回 401');
  checkEqual(loginCalls[1]?.s, 200, '正确凭证登录返回 200');

  // 教师工作台必须真的取到了学生数据
  check(
    otherCalls.some((c) => c.p === '/api/v1/students' && c.s === 200),
    '教师工作台成功拉取学生列表'
  );
  check(
    otherCalls.some((c) => c.p.endsWith('/mastery') && c.s === 200),
    '教师工作台成功拉取学生掌握度'
  );

  await browser.close();

  // ================= 汇总 =================
  console.log('\n' + '='.repeat(50));
  console.log(`断言总数: ${checkCount}`);
  console.log(`通过: ${checkCount - failures.length}`);
  console.log(`失败: ${failures.length}`);
  if (failures.length) {
    console.log('\n失败项:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(50));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('\nE2E 执行异常:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  cleanup();
  /**
   * 显式退出。
   *
   * 子进程（vite / tsx）与 Playwright 的浏览器会留下活跃句柄，
   * 事件循环不会自然排空 —— 表现为「测试跑完了但进程不退出」。
   */
  process.exit(process.exitCode ?? 0);
}
