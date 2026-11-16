/**
 * 教师工作台 E2E 测试。
 *
 * 前置条件：
 *   1. 后端运行在 :3000（需配置 AUTH_SECRET 与教师凭证）
 *   2. 前端运行在 :5173
 *   3. 已安装浏览器：npx playwright install chromium
 *
 * 运行：npm run test:e2e
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const apiCalls = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});
page.on('response', (res) => {
  const u = res.url();
  if (u.includes('/api/v1/')) apiCalls.push({ p: u.replace('http://localhost:5173', ''), s: res.status() });
});

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 检查是否显示登录页
const bodyText = await page.locator('body').innerText();
const hasLogin = bodyText.includes('登录凭证') || bodyText.includes('登录');

if (hasLogin) {
  console.log('✓ 显示登录页');
  await page.locator('#login-secret').fill('teacher-demo-key');
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(2000);
} else {
  console.log('· 开发模式（无登录页），注入教师 token');
  const res = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'teacher-demo-key' }),
  });
  const data = await res.json();
  if (data.token) {
    await page.evaluate((t) => {
      localStorage.setItem('daydayup.auth.token', t);
      localStorage.setItem(
        'daydayup.auth.session',
        JSON.stringify({
          token: t,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          principalId: 'teacher-001',
          role: 'teacher',
          studentIds: ['stu-sh-zhangwei'],
          displayName: '王老师',
        })
      );
    }, data.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }
}

// 检查教师工作台入口
const navText = await page.locator('header').innerText();
console.log('顶部导航含教师工作台:', navText.includes('教师工作台'));
console.log('角色徽章:', navText.includes('教师') ? '✓' : '·');

// 点击教师工作台
try {
  await page.locator('text=教师工作台').first().click();
  await page.waitForTimeout(2000);
  const dashText = await page.locator('body').innerText();
  console.log('工作台内容长度:', dashText.length);
  console.log('含"已掌握":', dashText.includes('已掌握'));
  console.log('含"优先提升":', dashText.includes('优先提升'));
  await page.screenshot({ path: '/tmp/daydayup-shots/09-teacher.png', fullPage: true });
} catch (e) {
  console.log('✗ 无法打开工作台:', e.message.split('\n')[0]);
}

console.log('\n=== API 调用 ===');
for (const c of apiCalls) console.log(`  ${c.s}  ${c.p}`);
console.log('\nERRORS:', errors.length ? errors : 'none');

await browser.close();
