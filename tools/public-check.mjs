/** 公网端到端：HTTPS 首页、分享链接、管理页登录（只读，不写数据）。 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const base = process.argv[2] ?? 'https://share.fennecmomo.top';
const password = process.env.ADMIN_PASSWORD ?? '';
const outDir = path.resolve('artifacts');

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error).slice(0, 300) });
    process.stdout.write(`  ✘ ${name}\n      → ${String(error).slice(0, 300)}\n`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

process.stdout.write(`公网地址：${base}\n\n## 首页与分享\n`);

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();

await check('HTTPS 首页可用且证书正常', async () => {
  const response = await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 30000 });
  assert(response && response.status() === 200, `状态码 ${response?.status()}`);
  assert(page.url().startsWith('https://'), `协议 ${page.url()}`);
  await page.waitForSelector('.card', { timeout: 10000 });
  const count = await page.locator('.card').count();
  assert(count > 0, '没有卡片');
});

await check('卡片分享按钮复制公网链接', async () => {
  const first = page.locator('.card').first();
  const title = await first.locator('.card-title').innerText();
  await first.locator('.card-share').click();
  await page.waitForSelector('.toast', { timeout: 6000 });
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert(text.startsWith('https://share.fennecmomo.top/'), `链接不是公网地址：${text}`);
  assert(text.includes('?p='), `缺少 ?p= 参数：${text}`);
  process.stdout.write(`      复制到的链接：${text}（卡片「${title.trim()}」）\n`);
});

await check('分享链接在公网打开会自动弹出项目', async () => {
  const slug = 'paper-notes';
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const freshPage = await fresh.newPage();
  await freshPage.goto(`${base}/?p=${slug}`, { waitUntil: 'networkidle', timeout: 30000 });
  await freshPage.waitForSelector('dialog.dialog[open]', { timeout: 8000 });
  const title = await freshPage.locator('.dialog-title').innerText();
  assert(title.includes('便签纸'), `弹出的项目不对：${title}`);
  await freshPage.keyboard.press('Escape');
  await freshPage.waitForFunction(() => !location.search.includes('p='), undefined, { timeout: 5000 });
  await fresh.close();
});

await check('试玩页在公网可打开', async () => {
  const play = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const playPage = await play.newPage();
  const response = await playPage.goto(`${base}/play/paper-notes/`, { waitUntil: 'load', timeout: 30000 });
  assert(response && response.status() === 200, `状态码 ${response?.status()}`);
  assert(playPage.url().includes('/play/paper-notes/r/'), `没有重定向到版本目录：${playPage.url()}`);
  await play.close();
});

await context.close();

if (password) {
  process.stdout.write('\n## 管理页（公网）\n');
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const adminPage = await adminContext.newPage();

  await check('管理页登录并读取项目列表（不修改任何数据）', async () => {
    const response = await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
    assert(response && response.status() === 200, `状态码 ${response?.status()}`);
    await adminPage.waitForSelector('.login-card', { timeout: 10000 });
    await adminPage.fill('input[type=password]', password);
    await adminPage.click('button[type=submit]');
    await adminPage.waitForSelector('.admin-list-item', { timeout: 15000 });
    const count = await adminPage.locator('.admin-list-item').count();
    assert(count >= 7, `列表项目数 ${count}`);
    await adminPage.screenshot({ path: path.join(outDir, 'admin-console-public.png'), fullPage: true });

    const cookies = await adminContext.cookies();
    const cookie = cookies.find((item) => item.name === 'fh_admin');
    assert(cookie, '没有会话 cookie');
    assert(cookie.httpOnly === true, 'cookie 缺少 HttpOnly');
    assert(cookie.secure === true, 'HTTPS 下 cookie 应带 Secure');
    assert(cookie.sameSite === 'Strict', `cookie SameSite=${cookie.sameSite}`);
  });

  await check('退出登录后会话失效', async () => {
    await adminPage.getByRole('button', { name: '退出登录' }).click();
    await adminPage.waitForSelector('.login-card', { timeout: 8000 });
    const session = await adminPage.evaluate(async () => {
      const response = await fetch('/api/admin/session');
      return response.json();
    });
    assert(session.authenticated === false, '退出后仍然处于登录状态');
  });

  await adminContext.close();
}

await browser.close();

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n公网检查 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
if (failed.length > 0) process.exit(1);
