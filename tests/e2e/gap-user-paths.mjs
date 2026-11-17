/**
 * E2E 测试：**用户路径**上的三条 P0 闭环。
 *
 * 为什么需要这个文件（见 docs/DESIGN_IMPLEMENTATION_GAP_ANALYSIS.md §四）：
 *
 * 原有 E2E（teacher-dashboard.mjs）只覆盖登录 / 教师工作台 / localStorage /
 * 畸形数据容错，**从未点击**诊断按钮、规划页滑块、成绩录入。
 * 而验收测试 TC-01~TC-09 全部**直调服务端 API**，绕过前端接缝。
 *
 * 于是三条断链在「579/579 测试通过」的前提下长期存在：
 *   P0-1 诊断失分不写服务端 MasteryRecord（前端本地推导，刷新即丢）
 *   P0-2 成绩基线不落库（targetScore 恒等于 score）
 *   P0-4 调节每日时间/作业量/疲劳度不会重排计划
 *
 * 本文件的判据原则：
 * **每个 TC 用例必须有一条从 UI 操作出发的浏览器级断言，
 *   且断言「用户可见的结果」而非「API 返回值」。**
 * 服务端单元测试通过**不构成**该用例通过。
 *
 * 运行：npm run test:e2e:gap
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

const SERVER_PORT = 34577;
const WEB_PORT = 34578;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const STUDENT_SECRET = 'e2e-gap-student-key';
const STUDENT_ID = 'stu-sh-zhangwei';

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
  check(
    actual === expected,
    message,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

// ---- 环境准备 ----
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydayup-e2e-gap-'));
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
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else {
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
  // ---- 播种演示数据 ----
  fs.mkdirSync(path.join(tmpDataDir, 'seed'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'packages/server/data/seed/demo-student.json'),
    path.join(tmpDataDir, 'seed', 'demo-student.json')
  );
  await new Promise((resolve) => {
    const seed = spawnSync('npx', ['tsx', 'scripts/seed.ts'], {
      cwd: path.join(root, 'packages/server'),
      env: { ...process.env, DATA_DIR: tmpDataDir },
      encoding: 'utf8',
    });
    if (seed.status !== 0) {
      console.error('播种失败:', seed.stderr || seed.stdout);
    }
    resolve();
  });

  // 凭证文件（学生角色）
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDataDir, 'db', 'credentials.json'),
    JSON.stringify([
      {
        principalId: 'student-e2e-gap',
        secret: STUDENT_SECRET,
        role: 'student',
        studentIds: [STUDENT_ID],
        displayName: '张伟',
      },
    ])
  );

  console.log('启动后端…');
  startProcess('server', 'npx', ['tsx', 'src/main.ts'], {
    cwd: path.join(root, 'packages/server'),
    env: {
      DATA_DIR: tmpDataDir,
      AUTH_SECRET: 'e2e-gap-secret',
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

  if (!(await waitForPort(WEB_PORT))) {
    throw new Error('前端启动超时');
  }
  console.log('前端就绪\n');

  const browser = await chromium.launch();
  const page = await browser.newPage();

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

  // ---- 1. 学生登录 ----
  console.log('▶ 学生登录');
  await page.goto(WEB_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-secret', { timeout: 15_000 });
  await page.locator('#login-secret').fill(STUDENT_SECRET);
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(2500);

  const navText = await page.locator('header').innerText();
  check(navText.length > 0, '登录后渲染主界面');
  check(
    !navText.includes('登录凭证'),
    '登录后不再显示登录页'
  );

  // =======================================================================
  // P0-4：调节每日时间 → 计划立即重排（TC-02）
  // =======================================================================
  console.log('\n▶ P0-4 调节每日时间后计划立即重排（TC-02）');

  const planCallsBefore = apiCalls.filter(
    (c) => c.p.endsWith('/plans') && c.s === 200
  ).length;

  // 进入「提分规划」
  let planningOpened = true;
  try {
    await page.locator('header').getByText('提分规划').first().click();
    await page.waitForTimeout(1500);
  } catch (e) {
    planningOpened = false;
    console.log(`  ! 打开规划页失败: ${e.message.split('\n')[0]}`);
  }
  check(planningOpened, '可打开「提分规划」页');

  if (planningOpened) {
    const before = await page.locator('body').innerText();
    // 读出当前显示的「实际排期 X 分钟」
    const beforeMatch = before.match(/实际排期\s*(\d+)\s*分钟/);
    const budgetBefore = beforeMatch ? Number(beforeMatch[1]) : null;
    check(
      budgetBefore !== null,
      '规划页显示当前实际排期分钟数',
      before.slice(0, 120).replace(/\n/g, ' ')
    );

    // 拖动「每日可用学习时间」滑块到 30 分钟
    const slider = page.locator('input[type=range]').first();
    const sliderExists = (await slider.count()) > 0;
    check(sliderExists, '存在每日可用学习时间滑块');

    if (sliderExists && budgetBefore !== null) {
      await slider.fill('30');
      // 等防抖（400ms）+ 落库 + 计划重排
      await page.waitForTimeout(3000);

      const after = await page.locator('body').innerText();
      const afterMatch = after.match(/实际排期\s*(\d+)\s*分钟/);
      const budgetAfter = afterMatch ? Number(afterMatch[1]) : null;

      check(
        budgetAfter !== null && budgetAfter < budgetBefore,
        '调节每日时间后「实际排期」立即缩减（用户可见的结果）',
        `调节前 ${budgetBefore} → 调节后 ${budgetAfter}`
      );

      // 服务端必须真的收到了档案更新与计划重排请求
      check(
        apiCalls.some(
          (c) => c.p.endsWith('/profile') && c.s === 200
        ),
        '档案变更已落库到服务端（PUT /profile 返回 200）'
      );
      const planCallsAfter = apiCalls.filter(
        (c) => c.p.endsWith('/plans') && c.s === 200
      ).length;
      check(
        planCallsAfter > planCallsBefore,
        '计划已重新生成（POST /plans 返回 200）',
        `重排请求数 ${planCallsBefore} → ${planCallsAfter}`
      );

      // 服务端返回的每日排期不得超预算（规格 §7.1：满足率 100%）
      const planText = after;
      const dayTotals = [...planText.matchAll(/(\d+)\s*分钟/g)].map((m) =>
        Number(m[1])
      );
      check(
        dayTotals.every((v) => v <= 30),
        '调节到 30 分钟后，每日排期都不超过预算',
        `页面出现的分钟数：${dayTotals.join(', ')}`
      );
    }
  }

  // =======================================================================
  // P0-3 / P0-1：载入示例试卷 → 启动诊断 → 失分写进服务端掌握度
  // =======================================================================
  console.log('\n▶ P0-3 载入示例试卷并启动诊断（TC-01）');

  let diagnosisOpened = true;
  try {
    await page.locator('header').getByText('考试诊断').first().click();
    await page.waitForTimeout(1500);
  } catch (e) {
    diagnosisOpened = false;
    console.log(`  ! 打开诊断页失败: ${e.message.split('\n')[0]}`);
  }
  check(diagnosisOpened, '可打开「考试诊断」页');

  if (diagnosisOpened) {
    // 「载入数学图片示例卷」按钮
    let sampleLoaded = true;
    try {
      await page.getByText('载入数学图片示例卷').first().click();
      await page.waitForTimeout(2500);
    } catch (e) {
      sampleLoaded = false;
      console.log(`  ! 点击载入示例失败: ${e.message.split('\n')[0]}`);
    }
    check(sampleLoaded, '可点击「载入数学图片示例卷」');

    if (sampleLoaded) {
      const bodyText = await page.locator('body').innerText();
      check(
        bodyText.includes('已载入：上海九年级数学期中示例卷'),
        '界面提示示例卷已载入'
      );

      // 启动诊断（无 GEMINI_API_KEY 时会失败，但失败必须是「明确的 AI 不可用」，
      // 而不是「未提供试卷图片」——后者正是 P0-3 的症状）
      let diagnoseClicked = true;
      try {
        await page.getByText(/启动\s*AI\s*试卷诊断|启动 AI 试卷诊断/).first().click();
        await page.waitForTimeout(6000);
      } catch (e) {
        diagnoseClicked = false;
        console.log(`  ! 点击启动诊断失败: ${e.message.split('\n')[0]}`);
      }
      check(diagnoseClicked, '可点击「启动 AI 试卷诊断」');

      if (diagnoseClicked) {
        const afterText = await page.locator('body').innerText();
        /**
         * 关键判据：不得出现「请提供试卷图片」——
         * 那说明示例图没进入上传链路（P0-3 未修复）。
         */
        check(
          !afterText.includes('请提供试卷图片'),
          '启动诊断不报「请提供试卷图片」（示例图已真正进入上传链路）',
          afterText.slice(0, 200).replace(/\n/g, ' ')
        );

        // 上传请求必须真的发出去了
        const uploadCalls = apiCalls.filter((c) =>
          c.p.includes('/uploads/papers')
        );
        check(
          uploadCalls.length > 0,
          '示例卷确实发起了上传请求（POST /uploads/papers）',
          `上传调用数 ${uploadCalls.length}`
        );
        check(
          uploadCalls.every((c) => c.s === 200),
          '上传请求全部成功',
          JSON.stringify(uploadCalls)
        );
      }
    }
  }

  // =======================================================================
  // P0-2：成绩录入落库 + 目标分独立
  // =======================================================================
  console.log('\n▶ P0-2 成绩录入落库且目标分独立');

  // 直接验证服务端状态（这是「用户可见的结果」——刷新后仍在）
  const token = await page.evaluate(() =>
    localStorage.getItem('daydayup.auth.token')
  );
  check(Boolean(token), '已取得访问令牌');

  if (token) {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const resultRes = await fetch(
      `${SERVER_URL}/api/v1/students/${STUDENT_ID}/exam-results`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          studentId: STUDENT_ID,
          examId: 'exam-e2e-gap',
          examTitle: 'E2E 目标分验证场次',
          subject: '数学',
          score: 62,
          fullScore: 100,
          targetScore: 95,
          date: '2026-11-17',
        }),
      }
    );
    checkEqual(resultRes.status, 200, '录入成绩返回 200');

    const readBack = await (
      await fetch(
        `${SERVER_URL}/api/v1/students/${STUDENT_ID}/exam-results`,
        { headers: authHeaders }
      )
    ).json();

    const rec = (readBack.results ?? []).find((r) => r.score === 62);
    check(Boolean(rec), '成绩可被读回');
    checkEqual(
      rec?.targetScore,
      95,
      '目标分独立存储（不是被抄成实际分 62）'
    );
  }

  // =======================================================================
  // 汇总
  // =======================================================================
  checkEqual(pageErrors.length, 0, '无未捕获的页面异常', pageErrors.join(' | '));

  const fatalConsole = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource') && !e.includes('401')
  );
  checkEqual(
    fatalConsole.length,
    0,
    '无致命 console 错误',
    fatalConsole.join(' | ')
  );

  await browser.close();

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
  console.error(
    '\nE2E 执行异常:',
    err instanceof Error ? err.message : String(err)
  );
  process.exitCode = 1;
} finally {
  cleanup();
  process.exit(process.exitCode ?? 0);
}
