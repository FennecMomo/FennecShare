/**
 * 浏览器验收：用本机已安装的 Microsoft Edge（playwright-core 驱动，不下载 Chromium）
 * 检查首页布局、筛选、详情弹窗、键盘操作、移动端宽度与 reduced-motion。
 *
 *   node tools/browser-check.mjs [--base http://127.0.0.1:8790] [--out artifacts]
 *
 * 这是本地验收脚本，不属于生产运行时。服务器部署不需要执行它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const base = argValue('--base', 'http://127.0.0.1:8790').replace(/\/+$/, '');
const outDir = path.resolve(argValue('--out', 'artifacts'));
await fs.promises.mkdir(outDir, { recursive: true });

// 所有数量断言都从真实接口推导，换数据不用改测试
const catalogResponse = await fetch(`${base}/api/projects`);
if (!catalogResponse.ok) throw new Error(`读取 /api/projects 失败：${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const projects = catalog.projects ?? [];
const imageCount = (project) => (project.cover ? 1 : 0) + (project.screenshots?.length ?? 0);
const countOf = (category) => projects.filter((project) => project.categories.includes(category)).length;
const galleryTarget = [...projects].sort((a, b) => imageCount(b) - imageCount(a))[0];
const downloadTarget = projects.find((project) => project.web && (project.downloads ?? []).length > 0)
  ?? projects.find((project) => project.web)
  ?? projects[0];
process.stdout.write(`数据：${projects.length} 个项目，revision ${catalog.revision}；` +
  `画廊用例用「${galleryTarget?.title}」（${imageCount(galleryTarget)} 张图），按钮用例用「${downloadTarget?.title}」\n`);

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const edgePath = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  process.stdout.write(`\n## ${name}\n`);
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name: `${currentSection} / ${name}`, ok: true });
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name: `${currentSection} / ${name}`, ok: false, error: message });
    process.stdout.write(`  ✘ ${name}\n      → ${message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ['--disable-gpu', '--no-first-run'],
});

try {
  // ---------- 桌面 ----------
  section('桌面端 1440×900');
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await desktop.newPage();
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });

  await check(`首页加载出全部 ${projects.length} 张项目卡片`, async () => {
    await page.waitForSelector('.card', { timeout: 10_000 });
    assertEqual(await page.locator('.card').count(), projects.length, '卡片数量');
    assertEqual(await page.locator('.card .card-cover img').count(), projects.length, '封面数量');
  });

  await check('桌面宽度无横向溢出且为多列网格', async () => {
    const metrics = await page.evaluate(() => {
      const grid = document.querySelector('.project-grid');
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        columns,
      };
    });
    assert(metrics.scrollWidth <= metrics.innerWidth, `横向溢出：scrollWidth=${metrics.scrollWidth} > ${metrics.innerWidth}`);
    assert(metrics.columns >= 3, `桌面端列数应 >= 3，实际 ${metrics.columns}`);
  });

  await check('筛选：单类型、多选 OR、清空恢复全部', async () => {
    const chips = page.locator('.filter-chips .chip');
    const categories = [['web', 1], ['desktop', 2], ['mobile', 3]];

    for (const [category, index] of categories) {
      await chips.nth(0).click(); // 先回到「全部」
      await chips.nth(index).click();
      const expected = countOf(category);
      if (expected > 0) {
        assertEqual(await page.locator('.card').count(), expected, `${category} 单类型数量`);
      } else {
        await page.waitForSelector('.panel', { timeout: 5000 });
        const text = await page.locator('.panel').innerText();
        assert(text.includes('没有符合筛选条件'), `${category} 为空时应显示筛选空状态，实际「${text}」`);
      }
    }

    await chips.nth(0).click();
    assertEqual(await page.locator('.card').count(), projects.length, '清空筛选后数量');

    // 多选 OR：把有内容的分类全选，结果应是并集；再加一个空分类，结果不应变化
    const populated = categories.filter(([category]) => countOf(category) > 0);
    const union = new Set(
      projects
        .filter((project) => project.categories.some((category) => populated.some(([name]) => name === category)))
        .map((project) => project.slug),
    );
    for (const [, index] of populated) await chips.nth(index).click();
    assertEqual(await page.locator('.card').count(), union.size, '多选 OR 数量');
    assertEqual(await chips.nth(0).getAttribute('aria-pressed'), 'false', '全部按钮状态');

    const emptyCategory = categories.find(([category]) => countOf(category) === 0);
    if (emptyCategory) {
      await chips.nth(emptyCategory[1]).click();
      assertEqual(await page.locator('.card').count(), union.size, `叠加空分类（${emptyCategory[0]}）后数量不变`);
    }

    const summary = await page.locator('.result-summary').innerText();
    assert(summary.includes(String(union.size)), `结果摘要应包含 ${union.size}，实际「${summary}」`);

    await chips.nth(0).click();
    assertEqual(await page.locator('.card').count(), projects.length, '恢复全部');
  });

  await check('整卡点击打开详情弹窗并锁定背景滚动', async () => {
    await page.locator('.card', { hasText: galleryTarget.title }).locator('.card-open').click();
    const dialog = page.locator('dialog.dialog');
    assertEqual(await dialog.getAttribute('open') !== null, true, 'dialog 应打开');
    assertEqual(await page.evaluate(() => document.body.style.overflow), 'hidden', '背景滚动应被锁定');
    const title = await page.locator('.dialog-title').innerText();
    assert(title.includes(galleryTarget.title), `弹窗标题应是被点击的项目，实际「${title}」`);
  });

  await check('兼容模式：弹窗内点击不会误关闭', async () => {
    await page.locator('.dialog-body').click({ position: { x: 30, y: 30 } });
    assertEqual(await page.locator('dialog.dialog[open]').count(), 1, '点击内部后仍应打开');
  });

  await check('图片切换：方向键与缩略图', async () => {
    const total = imageCount(galleryTarget);
    const counter = page.locator('.gallery-counter');
    assertEqual(await counter.innerText(), `1 / ${total}`, '初始序号');
    assertEqual(await page.locator('.gallery-thumb').count(), total, '缩略图数量');
    await page.locator('.gallery-stage').focus();
    await page.keyboard.press('ArrowRight');
    assertEqual(await counter.innerText(), `2 / ${total}`, '方向键后序号');
    await page.keyboard.press('ArrowLeft');
    assertEqual(await counter.innerText(), `1 / ${total}`, '方向键回退序号');
    await page.locator('.gallery-thumb').nth(total - 1).click();
    assertEqual(await counter.innerText(), `${total} / ${total}`, '点击最后一张缩略图后序号');
    const src = await page.locator('.gallery-stage img').getAttribute('src');
    assert(src && src.includes('/media/'), `主图应切换到媒体资源，实际 ${src}`);
  });

  await check('Esc 关闭弹窗并把焦点还给原卡片', async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog.dialog')?.open !== true, undefined, { timeout: 3000 });
    assertEqual(await page.locator('dialog.dialog[open]').count(), 0, 'dialog 应关闭');
    await page.waitForFunction(() => document.body.style.overflow !== 'hidden', undefined, { timeout: 3000 });
    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    assert(focusedClass.includes('card-open'), `焦点应回到卡片按钮，实际 class=${focusedClass}`);
  });

  await check('点击遮罩关闭弹窗（背景模糊仍可用）', async () => {
    await page.locator('.card-open').first().click();
    await page.locator('dialog.dialog[open]').waitFor({ state: 'visible' });
    // 点在弹窗面板之外、dialog 自身区域（左上角）
    await page.mouse.click(8, 8);
    await page.waitForFunction(() => document.querySelector('dialog.dialog')?.open !== true, undefined, { timeout: 3000 });
    assertEqual(await page.locator('dialog.dialog[open]').count(), 0, '遮罩点击后应关闭');
  });

  await check('键盘可达：Tab 进入卡片并用 Enter 打开', async () => {
    await page.locator('.brand-title').click();
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.className ?? '');
    assert(active.length > 0, 'Tab 后应有焦点元素');
    // 用程序聚焦第一张卡片按钮，验证 Enter 可以打开（原生 button 的键盘语义）
    await page.locator('.card-open').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.dialog[open]', { timeout: 3000 });
    assertEqual(await page.locator('dialog.dialog[open]').count(), 1, 'Enter 应打开弹窗');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog.dialog')?.open !== true, undefined, { timeout: 3000 });
  });

  await check('详情里按钮来自真实数据（有网页/有下载才出现）', async () => {
    await page.locator('.card', { hasText: downloadTarget.title }).locator('.card-open').click();
    await page.waitForSelector('dialog.dialog[open]');
    assertEqual(await page.locator('.dialog .btn-primary').count(), 1, '在线体验按钮');
    const href = await page.locator('.dialog .btn-primary').getAttribute('href');
    assert(href && href.startsWith('/play/'), `在线体验应指向 /play/，实际 ${href}`);
    const target = await page.locator('.dialog .btn-primary').getAttribute('target');
    assertEqual(target, '_blank', '在线体验应新标签打开');
    const rel = await page.locator('.dialog .btn-primary').getAttribute('rel');
    assert(rel && rel.includes('noopener'), 'rel 应包含 noopener');
    assertEqual(
      await page.locator('.dialog .download-item').count(),
      (downloadTarget.downloads ?? []).length,
      '下载项数量应等于 catalog 里的下载记录数',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog.dialog')?.open !== true);
  });

  await check('没有可体验内容时不显示假按钮', async () => {
    // 站上已经没有纯占位项目了，这里用接口拦截造一个「只有简介」的项目来验证
    const synthetic = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const syntheticPage = await synthetic.newPage();
    await syntheticPage.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const template = json.projects[0];
      json.projects = [
        {
          ...template,
          id: 'placeholder-demo',
          slug: 'placeholder-demo',
          title: '只有简介的项目',
          summary: '用来验证没有可体验内容时的卡片与详情。',
          description: '',
          categories: ['desktop'],
          web: null,
          downloads: [],
          screenshots: [],
          releaseHistory: [],
        },
      ];
      await route.fulfill({ response, json });
    });
    await syntheticPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await syntheticPage.locator('.card-open').first().click();
    await syntheticPage.waitForSelector('dialog.dialog[open]');
    assertEqual(await syntheticPage.locator('.dialog .btn-primary').count(), 0, '不应有在线体验按钮');
    assertEqual(await syntheticPage.locator('.dialog .download-item').count(), 0, '不应有下载项');
    const note = await syntheticPage.locator('.dialog .note-muted').innerText();
    assert(note.includes('暂未提供'), `应显示明确说明，实际「${note}」`);
    await synthetic.close();
  });

  await check('分享按钮复制链接且不会打开详情', async () => {
    await page.locator('.card', { hasText: galleryTarget.title }).locator('.card-share').click();
    await page.waitForSelector('.toast', { timeout: 3000 });
    const toastText = await page.locator('.toast').innerText();
    assert(toastText.includes('已复制'), `应提示已复制，实际「${toastText}」`);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert(clipboard.includes(`?p=${galleryTarget.slug}`), `剪贴板里应是带 ?p= 的分享链接，实际「${clipboard}」`);
    assertEqual(await page.locator('dialog.dialog[open]').count(), 0, '点分享不应打开详情');
  });

  await check('分享链接打开后自动弹出对应项目', async () => {
    const shared = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    const sharedPage = await shared.newPage();
    await sharedPage.goto(`${base}/?p=${galleryTarget.slug}`, { waitUntil: 'networkidle' });
    await sharedPage.waitForSelector('dialog.dialog[open]', { timeout: 6000 });
    const title = await sharedPage.locator('.dialog-title').innerText();
    assert(title.includes(galleryTarget.title), `应打开被分享的项目，实际「${title}」`);
    // 关闭后地址栏里的 ?p= 应该被清掉，避免刷新又弹出来
    await sharedPage.keyboard.press('Escape');
    await sharedPage.waitForFunction(() => !location.search.includes('p='), undefined, { timeout: 3000 });
    await shared.close();
  });

  await check('卡片展示试玩/分享/下载计数', async () => {
    const stats = page.locator('.card').first().locator('.card-stats');
    assertEqual(await stats.count(), 1, '每张卡片都应有数据行');
    const text = await stats.innerText();
    assert(/\d/.test(text), `数据行里应有数字，实际「${text}」`);
  });

  const tagChipSelector = '.tag-filter .tag-chip:not(.tag-chip-clear)';
  const tagChipCount = await page.locator(tagChipSelector).count();
  if (tagChipCount > 0) {
    await check('标签筛选：选中标签后只剩带该标签的项目，清除后恢复', async () => {
      const total = await page.locator('.card').count();
      const firstChip = page.locator(tagChipSelector).first();
      const label = (await firstChip.innerText()).split('\n')[0].trim();
      await firstChip.click();
      await page.waitForFunction((limit) => {
        const cards = document.querySelectorAll('.card');
        return cards.length > 0 && cards.length <= limit;
      }, total, { timeout: 5000 });
      const filtered = await page.locator('.card').count();
      assert(filtered <= total, `筛选后卡片数不应变多：${filtered} > ${total}`);
      const tagsText = await page.locator('.card .tag-project').allInnerTexts();
      assert(
        tagsText.some((text) => text.includes(label)),
        `可见卡片里应至少有一张带 #${label}`,
      );

      await page.locator('.tag-chip-clear').click();
      await page.waitForFunction((limit) => document.querySelectorAll('.card').length === limit, total, {
        timeout: 5000,
      });
    });
  } else {
    process.stdout.write('\n## 标签筛选\n  （跳过：当前数据还没有标签）\n');
  }

  await page.screenshot({ path: path.join(outDir, 'home-desktop.png'), fullPage: true });

  // ---------- 在线体验与下载 ----------
  section('在线体验与下载');
  const playPage = await desktop.newPage();
  await check('试玩页可直接访问且脚本真的在跑', async () => {
    await playPage.goto(`${base}/play/paper-notes/`, { waitUntil: 'load' });
    assert(playPage.url().includes('/play/paper-notes/r/'), `稳定入口应重定向到版本目录，实际 ${playPage.url()}`);
    await playPage.locator('#note').fill('浏览器验收用的便签');
    await playPage.locator('.composer button[type=submit]').click();
    await playPage.waitForSelector('.notes li');
    assertEqual(await playPage.locator('.notes li').count(), 1, '添加后的便签数量');
    const counterText = await playPage.locator('#counter').innerText();
    assert(counterText.includes('0 / 1'), `计数应更新，实际「${counterText}」`);
    await playPage.locator('.notes input[type=checkbox]').check();
    assert((await playPage.locator('#counter').innerText()).includes('1 / 1'), '勾选后计数应为 1 / 1');
    await playPage.screenshot({ path: path.join(outDir, 'play-paper-notes.png'), fullPage: true });
  });

  await check('多页面试玩站子目录可直接刷新', async () => {
    const about = await desktop.newPage();
    await about.goto(`${base}/play/pixel-garden/about/`, { waitUntil: 'load' });
    // body 的 background 是渐变（background-image），所以用只有样式表才会设置的 color 判断是否真的加载到 CSS
    const color = await about.evaluate(() => getComputedStyle(document.body).color);
    assertEqual(color, 'rgb(230, 247, 238)', '子页面应加载到共享样式表（body 文字颜色）');
    const text = await about.locator('h1').innerText();
    assert(text.includes('关于'), `子页面标题异常：${text}`);
    await about.close();
  });

  await check('下载按钮触发真实文件下载', async () => {
    const downloadPage = await desktop.newPage();
    await downloadPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await downloadPage.locator('.card', { hasText: '便签纸' }).locator('.card-open').click();
    await downloadPage.waitForSelector('dialog.dialog[open]');
    const [download] = await Promise.all([
      downloadPage.waitForEvent('download'),
      downloadPage.locator('.dialog .download-action a').first().click(),
    ]);
    const failure = await download.failure();
    assertEqual(failure, null, '下载不应失败');
    assert(download.suggestedFilename().endsWith('.zip'), `文件名应为 .zip，实际 ${download.suggestedFilename()}`);
    await downloadPage.close();
  });

  // ---------- 移动端 ----------
  section('移动端 390×844');
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await mobilePage.waitForSelector('.card');

  await check('移动端无横向溢出，卡片单列', async () => {
    const metrics = await mobilePage.evaluate(() => {
      const grid = document.querySelector('.project-grid');
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        columns,
        chipsWrap: [...document.querySelectorAll('.chip')].every((chip) => {
          const rect = chip.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth + 0.5;
        }),
      };
    });
    assert(metrics.scrollWidth <= metrics.innerWidth, `横向溢出：${metrics.scrollWidth} > ${metrics.innerWidth}`);
    assertEqual(metrics.columns, 1, '移动端列数');
    assert(metrics.chipsWrap, '筛选按钮不应溢出视口');
  });

  await check('移动端弹窗为全屏面板且内部可滚动', async () => {
    await mobilePage.locator('.card-open').first().click();
    await mobilePage.waitForSelector('dialog.dialog[open]');
    const box = await mobilePage.locator('dialog.dialog').boundingBox();
    assert(box && box.width >= 380, `弹窗宽度应接近视口，实际 ${box?.width}`);
    const scrollable = await mobilePage.evaluate(() => {
      const body = document.querySelector('.dialog-body');
      return body ? body.scrollHeight > body.clientHeight : false;
    });
    assert(scrollable, '长内容应可在弹窗内部滚动');
    // 等面板入场动画结束再截图，否则会拍到半透明中间态
    await mobilePage.waitForTimeout(350);
    await mobilePage.screenshot({ path: path.join(outDir, 'home-mobile-dialog.png') });
    await mobilePage.keyboard.press('Escape');
    await mobilePage.waitForFunction(() => document.querySelector('dialog.dialog')?.open !== true);
  });

  await mobilePage.screenshot({ path: path.join(outDir, 'home-mobile.png'), fullPage: true });

  // ---------- reduced motion ----------
  section('prefers-reduced-motion');
  const reduced = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await check('减少动效时卡片过渡被禁用', async () => {
    const duration = await reducedPage.evaluate(() => {
      const card = document.querySelector('.card');
      return card ? getComputedStyle(card).transitionDuration : null;
    });
    assert(duration !== null, '应能找到卡片');
    const seconds = Number.parseFloat((duration.split(',')[0] ?? '1').replace('s', ''));
    assert(seconds < 0.01, `过渡时长应接近 0，实际 ${duration}`);
  });

  // ---------- 空列表 / 错误状态（用接口拦截模拟）----------
  section('异常状态');
  await check('接口失败时显示错误与重试入口', async () => {
    const failing = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const failingPage = await failing.newPage();
    await failingPage.route('**/api/projects', (route) => route.abort());
    await failingPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await failingPage.waitForSelector('.panel', { timeout: 10_000 });
    const panelText = await failingPage.locator('.panel').innerText();
    assert(panelText.includes('加载失败'), `应提示加载失败，实际「${panelText}」`);
    assertEqual(await failingPage.locator('.panel button').count(), 1, '应有重试按钮');
    await failingPage.screenshot({ path: path.join(outDir, 'state-error.png') });
    await failing.close();
  });

  await check('空列表显示空状态', async () => {
    const empty = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const emptyPage = await empty.newPage();
    await emptyPage.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, revision: 0, generatedAt: new Date().toISOString(), serverTime: new Date().toISOString(), projects: [] }),
      }),
    );
    await emptyPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await emptyPage.waitForSelector('.panel', { timeout: 10_000 });
    const text = await emptyPage.locator('.panel').innerText();
    assert(text.includes('还没有发布任何项目'), `空状态文案异常：${text}`);
    await emptyPage.screenshot({ path: path.join(outDir, 'state-empty.png') });
    await empty.close();
  });

  await check('筛选无结果时给出清除入口', async () => {
    // 只留一个「不带 mobile 分类」的项目，再选手机APP → 就会命中「筛选后为空」而不是「还没发布项目」
    const only = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const onlyPage = await only.newPage();
    await onlyPage.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const kept = json.projects.find((project) => !project.categories.includes('mobile')) ?? json.projects[0];
      json.projects = [{ ...kept, categories: kept.categories.filter((category) => category !== 'mobile') }];
      await route.fulfill({ response, json });
    });
    await onlyPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await onlyPage.locator('.filter-chips .chip').nth(3).click(); // 手机APP
    await onlyPage.waitForSelector('.panel', { timeout: 5000 });
    const text = await onlyPage.locator('.panel').innerText();
    assert(text.includes('没有符合筛选条件'), `筛选空状态文案异常：${text}`);
    await onlyPage.locator('.panel button').click();
    await onlyPage.waitForSelector('.card');
    assert((await onlyPage.locator('.card').count()) > 0, '清除筛选后应重新出现卡片');
    await only.close();
  });
  // ---------- 管理页面（只在提供了 ADMIN_PASSWORD 时跑，密码不写进仓库） ----------
  const adminPassword = process.env.ADMIN_PASSWORD ?? null;
  if (adminPassword) {
    section('管理页面');
    await check('未登录时显示登录框，错误密码给出提示', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      const adminPage = await context.newPage();
      await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await adminPage.waitForSelector('.login-card', { timeout: 8000 });
      await adminPage.fill('input[type=password]', 'definitely-wrong');
      await adminPage.click('button[type=submit]');
      await adminPage.waitForSelector('.error', { timeout: 6000 });
      const text = await adminPage.locator('.error').innerText();
      assert(text.includes('密码'), `应提示密码错误，实际「${text}」`);
      await context.close();
    });

    await check('正确密码登录后能看到项目列表与编辑器', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      const adminPage = await context.newPage();
      await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await adminPage.fill('input[type=password]', adminPassword);
      await adminPage.click('button[type=submit]');
      await adminPage.waitForSelector('.admin-list-item', { timeout: 10_000 });
      const count = await adminPage.locator('.admin-list-item').count();
      assert(count >= projects.length, `管理列表应包含全部项目（至少 ${projects.length}），实际 ${count}`);
      await adminPage.waitForSelector('.editor-card', { timeout: 6000 });
      await adminPage.screenshot({ path: path.join(outDir, 'admin-console.png'), fullPage: true });
      await context.close();
    });

    await check('退出登录后回到登录框', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      const adminPage = await context.newPage();
      await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await adminPage.fill('input[type=password]', adminPassword);
      await adminPage.click('button[type=submit]');
      await adminPage.waitForSelector('.admin-list-item', { timeout: 10_000 });
      await adminPage.getByRole('button', { name: '退出登录' }).click();
      await adminPage.waitForSelector('.login-card', { timeout: 6000 });
      const cookie = await context.cookies();
      assertEqual(cookie.filter((item) => item.name === 'fh_admin').length, 0, '退出后不应保留会话 cookie');
      await context.close();
    });
    await check('管理页三个 Tab 都能切换并渲染内容', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
      const adminPage = await context.newPage();
      await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await adminPage.fill('input[type=password]', adminPassword);
      await adminPage.click('button[type=submit]');
      await adminPage.waitForSelector('.admin-list-item', { timeout: 10_000 });

      await adminPage.locator('.admin-tab', { hasText: '标签' }).click();
      await adminPage.waitForSelector('.tag-admin-list', { timeout: 6000 });
      const tagRows = await adminPage.locator('.tag-admin-list li').count();
      assert(tagRows > 0, '标签页应至少渲染一行（标签或空状态）');

      await adminPage.locator('.admin-tab', { hasText: '数据' }).click();
      await adminPage.waitForSelector('.stat-card', { timeout: 8000 });
      const totals = await adminPage.locator('.stat-card strong').allInnerTexts();
      assert(totals.length >= 4, `数据总览应有 4 个指标，实际 ${totals.length}`);
      assert(totals.every((text) => text.trim().length > 0), '指标都应有内容');
      await adminPage.screenshot({ path: path.join(outDir, 'admin-stats.png'), fullPage: true });

      await adminPage.locator('.admin-tab', { hasText: '项目' }).click();
      await adminPage.waitForSelector('.editor-card', { timeout: 6000 });
      await context.close();
    });

    await check('添加项目弹窗可以打开并校验必填项（不写入数据）', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
      const adminPage = await context.newPage();
      await adminPage.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await adminPage.fill('input[type=password]', adminPassword);
      await adminPage.click('button[type=submit]');
      await adminPage.waitForSelector('.admin-list-item', { timeout: 10_000 });
      await adminPage.click('button:has-text("＋ 添加项目")');
      await adminPage.waitForSelector('.modal-card', { timeout: 6000 });
      const submit = adminPage.locator('.modal-card button[type=submit]');
      assert(await submit.isDisabled(), 'slug 和标题都没填时创建按钮应禁用');
      await adminPage.fill('input[placeholder="my-tool"]', 'not valid slug');
      await adminPage.fill('.modal-card input[maxlength="120"]', 'x');
      await submit.click();
      await adminPage.waitForTimeout(400);
      assertEqual(await adminPage.locator('.modal-card').count(), 1, 'slug 不合规时浏览器原生校验应拦住提交');
      await adminPage.click('button:has-text("取消")');
      await adminPage.waitForSelector('.modal-card', { state: 'detached', timeout: 5000 });
      await context.close();
    });
  } else {
    process.stdout.write('\n## 管理页面\n  （跳过：未设置 ADMIN_PASSWORD 环境变量）\n');
  }
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
process.stdout.write('\n===================\n');
process.stdout.write(`浏览器检查 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
for (const item of failed) process.stdout.write(`  ✘ ${item.name}\n      → ${item.error ?? ''}\n`);
process.stdout.write(`截图目录：${outDir}\n`);
if (failed.length > 0) process.exit(1);
