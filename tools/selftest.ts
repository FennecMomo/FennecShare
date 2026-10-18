/**
 * Fennec Share 自测：在临时目录里跑完整发布事务 + 真实 HTTP 断言。
 *
 *   npm run build && npm run selftest
 *
 * 覆盖：发布/幂等/多平台更新/并发/无效包/zip-slip/下架/回滚/备份恢复、
 * 试玩路由与版本目录、SPA fallback、下载头/HEAD/Range/中文名/哈希、
 * 路径穿越拒绝、catalog 热更新等。
 */
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createLogger } from '../server/logger.js';
import type { AppConfig, PublisherConfig } from '../server/config.js';
import { findProject } from '../shared/catalog.js';
import { publishProject } from './lib/publish.js';
import { rollbackProject, unpublishProject, updateProjectMeta } from './lib/manage.js';
import { backupData, restoreData } from './lib/backup.js';
import { readCatalogFile } from './lib/catalog-io.js';
import { buildZip } from './lib/ziptest.js';
import { isPublishError } from './lib/errors.js';
import { writeAuth } from '../server/admin/auth.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const webDistDir = path.resolve(repoRoot, 'dist', 'web');

interface Check {
  name: string;
  ok: boolean;
  error?: string;
}

const checks: Check[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  process.stdout.write(`\n## ${name}\n`);
}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    checks.push({ name: `${currentSection} / ${name}`, ok: true });
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: `${currentSection} / ${name}`, ok: false, error: message });
    process.stdout.write(`  ✘ ${name}\n      → ${message}\n`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
}

async function expectError(fn: () => Promise<unknown>, codePrefix: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (isPublishError(error) && error.code.startsWith(codePrefix)) return;
    throw new Error(`${label}：期望错误码 ${codePrefix}，实际 ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label}：期望抛出 ${codePrefix}，但操作成功了`);
}

async function write(relative: string, content: string | Buffer): Promise<string> {
  const target = path.join(fixturesDir, relative);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content);
  return target;
}

function sha256(text: Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fennec-selftest-'));
const dataDir = path.join(root, 'data');
const fixturesDir = path.join(root, 'fixtures');

const publisherConfig: PublisherConfig = {
  dataDir,
  publicBaseUrl: 'https://share.example.test',
  logLevel: 'error',
};

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
    throw new Error(`缺少前端构建产物：${webDistDir}。先执行 npm run build。`);
  }

  section('准备测试夹具');
  const fixture = await prepareFixtures();
  process.stdout.write(`  临时目录：${root}\n`);

  // ---- 启动服务器（端口 0，避免占用已有端口）----
  const logger = createLogger('error');
  const appConfig: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webDistDir,
    publicBaseUrl: publisherConfig.publicBaseUrl,
    logLevel: 'error',
  };
  const { app } = createApp({ config: appConfig, logger });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    section('发布事务');
    await check('新增项目：网页 + EXE + 中文名 APK', async () => {
      const result = await publishProject(publisherConfig, { manifestPath: fixture.manifestFull });
      assertEqual(result.status, 'created', '状态');
      assertEqual(result.parts.includes('web'), true, 'parts 含 web');
      assertEqual(result.downloads.length, 2, '下载数量');
      assertEqual(result.catalogRevision, 1, 'catalog revision');

      const catalog = await readCatalogFile(dataDir);
      const project = findProject(catalog, 'demo-tool');
      assert(project, 'catalog 里应有 demo-tool');
      assertEqual(project.web?.entry, 'index.html', '入口');
      assertEqual(project.published, true, 'published');
      const apk = project.downloads.find((item) => item.fileName.endsWith('.apk'));
      assert(apk, '应有 APK 下载记录');
      assertEqual(apk.fileName, '演示工具-1.0.0.apk', '中文文件名');
      const storagePath = path.join(dataDir, apk.storage);
      assert(fs.existsSync(storagePath), `下载文件应落盘：${apk.storage}`);
      assertEqual(apk.size, fs.statSync(storagePath).size, '记录大小与实际一致');
    });

    await check('重复发布相同 manifest 报告无需更新', async () => {
      const before = await readCatalogFile(dataDir);
      const result = await publishProject(publisherConfig, { manifestPath: fixture.manifestFull });
      const after = await readCatalogFile(dataDir);
      assertEqual(result.status, 'unchanged', '状态');
      assertEqual(after.revision, before.revision, 'revision 不应变化');
    });

    await check('只更新 APK 时保留 EXE 与网页入口', async () => {
      const before = await readCatalogFile(dataDir);
      const beforeProject = findProject(before, 'demo-tool');
      assert(beforeProject?.web, '更新前应有 web');
      const result = await publishProject(publisherConfig, { manifestPath: fixture.manifestApkOnly });
      assertEqual(result.status, 'updated', '状态');

      const after = await readCatalogFile(dataDir);
      const project = findProject(after, 'demo-tool');
      assert(project, '项目仍应存在');
      // 下载文件名带版本号，因此旧 APK 默认保留（不会被静默替换成不同内容）
      assertEqual(project.downloads.length, 3, '默认合并后下载数量');
      assert(
        project.downloads.some((item) => item.fileName === 'DemoTool-1.0.0.exe'),
        'EXE 应被保留',
      );
      assert(
        project.downloads.some((item) => item.fileName === '演示工具-1.0.0.apk'),
        '旧版本 APK 默认保留',
      );
      assert(
        project.downloads.some((item) => item.fileName === '演示工具-2.0.0.apk'),
        '新 APK 应存在',
      );
      assertEqual(project.web?.releaseId, beforeProject?.web?.releaseId, '网页入口版本不应变化');
    });

    await check('用 removeDownloads 明确移除旧文件', async () => {
      const result = await publishProject(publisherConfig, { manifestPath: fixture.manifestApkCleanup });
      assertEqual(result.status, 'updated', '状态');
      const after = await readCatalogFile(dataDir);
      const project = findProject(after, 'demo-tool');
      assert(project, '项目仍应存在');
      assertEqual(project.downloads.length, 2, '移除后下载数量');
      assert(
        !project.downloads.some((item) => item.fileName === '演示工具-1.0.0.apk'),
        '旧 APK 应被移除',
      );
      assert(
        project.downloads.some((item) => item.fileName === 'DemoTool-1.0.0.exe'),
        'EXE 不应被误删',
      );
    });

    await check('并发发布两个项目不丢记录', async () => {
      const before = await readCatalogFile(dataDir);
      const results = await Promise.all([
        publishProject(publisherConfig, { manifestPath: fixture.manifestSpa }),
        publishProject(publisherConfig, { manifestPath: fixture.manifestSecond }),
      ]);
      assertEqual(results.length, 2, '两个发布都应有结果');
      const after = await readCatalogFile(dataDir);
      assertEqual(after.revision, before.revision + 2, 'revision 应 +2');
      assert(findProject(after, 'spa-app'), 'spa-app 应存在');
      assert(findProject(after, 'second-project'), 'second-project 应存在');
    });

    await check('无效 manifest 被拒绝且不修改 catalog', async () => {
      const before = await readCatalogFile(dataDir);
      await expectError(
        () => publishProject(publisherConfig, { manifestPath: fixture.manifestInvalid }),
        'manifest_invalid',
        '非法 slug',
      );
      const after = await readCatalogFile(dataDir);
      assertEqual(after.revision, before.revision, 'revision 不应变化');
    });

    await check('ZIP 路径穿越包被拒绝', async () => {
      const before = await readCatalogFile(dataDir);
      await expectError(
        () => publishProject(publisherConfig, { manifestPath: fixture.manifestSlip }),
        'invalid_package',
        'zip-slip',
      );
      const after = await readCatalogFile(dataDir);
      assertEqual(after.revision, before.revision, 'revision 不应变化');
      assert(!fs.existsSync(path.join(root, 'evil.txt')), '不应在包外写入文件');
    });

    await check('缺少 index.html 的包被拒绝', async () => {
      await expectError(
        () => publishProject(publisherConfig, { manifestPath: fixture.manifestNoIndex }),
        'invalid_package',
        '缺少入口',
      );
    });

    await check('多入口包未指定 entry 时被拒绝', async () => {
      await expectError(
        () => publishProject(publisherConfig, { manifestPath: fixture.manifestMultiNoEntry }),
        'invalid_package',
        '多入口',
      );
    });

    await check('多入口包显式指定 entry 后可发布', async () => {
      const result = await publishProject(publisherConfig, { manifestPath: fixture.manifestMultiWithEntry });
      assertEqual(result.status, 'created', '状态');
      assertEqual(result.web?.entry, 'index.html', '入口');
    });

    section('HTTP 行为');
    const catalog = await readCatalogFile(dataDir);
    const demo = findProject(catalog, 'demo-tool');
    assert(demo?.web, 'demo-tool 应有 web');
    const releaseId = demo.web.releaseId;
    const playBase = `/play/demo-tool/r/${releaseId}/`;
    const exeRecord = demo.downloads.find((item) => item.fileName === 'DemoTool-1.0.0.exe');
    assert(exeRecord, '应有 EXE 记录');
    const exePath = path.join(dataDir, exeRecord.storage);
    const exeBytes = await fs.promises.readFile(exePath);

    await check('GET / 返回站点 HTML 并带 CSP', async () => {
      const response = await fetch(`${base}/`);
      assertEqual(response.status, 200, '状态码');
      assert((response.headers.get('content-type') ?? '').includes('text/html'), 'Content-Type 应为 html');
      assert((response.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), '应有 CSP');
      assertEqual(response.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
    });

    await check('GET /healthz 返回服务状态与项目计数', async () => {
      const response = await fetch(`${base}/healthz`);
      assertEqual(response.status, 200, '状态码');
      const body = (await response.json()) as {
        status: string;
        service: string;
        catalogRevision: number;
        projects: { total: number; published: number };
      };
      assertEqual(body.status, 'ok', 'status');
      assertEqual(body.service, 'fennec-share', 'service');
      assert(body.catalogRevision >= 1, 'catalogRevision');
      assert(body.projects.total >= body.projects.published, '项目计数关系');
    });

    await check('GET /api/projects 不泄露内部字段', async () => {
      const response = await fetch(`${base}/api/projects`);
      assertEqual(response.status, 200, '状态码');
      const body = (await response.json()) as { projects: Array<Record<string, unknown>>; revision: number };
      assert(body.projects.length >= 2, '应至少有两个项目');
      const text = JSON.stringify(body);
      assert(!text.includes('storage'), '不应暴露 storage 字段');
      assert(!text.includes(dataDir), '不应暴露数据目录绝对路径');
      const downloads = body.projects.flatMap((project) => (project.downloads as unknown[]) ?? []);
      assert(downloads.length > 0, '应有下载记录');
    });

    await check('GET /play/<slug> 规范化到带斜杠地址', async () => {
      const response = await fetch(`${base}/play/demo-tool`, { redirect: 'manual' });
      assertEqual(response.status, 308, '状态码');
      assertEqual(response.headers.get('location'), '/play/demo-tool/', 'Location');
    });

    await check('GET /play/<slug>/ 重定向到版本目录', async () => {
      const response = await fetch(`${base}/play/demo-tool/`, { redirect: 'manual' });
      assertEqual(response.status, 302, '状态码');
      assertEqual(response.headers.get('location'), `/play/demo-tool/r/${releaseId}/`, 'Location');
    });

    await check('版本目录直接访问返回 HTML', async () => {
      const response = await fetch(`${base}${playBase}`);
      assertEqual(response.status, 200, '状态码');
      assert((response.headers.get('content-type') ?? '').includes('text/html'), 'Content-Type');
      assertEqual(response.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
      assert((response.headers.get('cache-control') ?? '').includes('immutable'), '应发长缓存');
      assertEqual(response.headers.get('content-security-policy'), null, '试玩内容不应套用站点 CSP');
      const html = await response.text();
      assert(html.includes('./assets/app.js'), '页面应引用相对资源');
    });

    await check('试玩静态资源 MIME 正确', async () => {
      const js = await fetch(`${base}${playBase}assets/app.js`);
      assertEqual(js.status, 200, 'js 状态码');
      assert((js.headers.get('content-type') ?? '').includes('text/javascript'), 'js Content-Type');
      const css = await fetch(`${base}${playBase}assets/style.css`);
      assert((css.headers.get('content-type') ?? '').includes('text/css'), 'css Content-Type');
      const svg = await fetch(`${base}${playBase}assets/logo.svg`);
      assert((svg.headers.get('content-type') ?? '').includes('image/svg+xml'), 'svg Content-Type');
    });

    await check('缺失的 js 返回 404 而不是 HTML', async () => {
      const response = await fetch(`${base}${playBase}assets/missing.js`);
      assertEqual(response.status, 404, '状态码');
      assert(!(response.headers.get('content-type') ?? '').includes('text/html'), '不应回落成 HTML');
    });

    await check('未启用 SPA fallback 时深层路径 404', async () => {
      const response = await fetch(`${base}${playBase}some/deep/link`);
      assertEqual(response.status, 404, '状态码');
    });

    const spaCatalog = await readCatalogFile(dataDir);
    const spa = findProject(spaCatalog, 'spa-app');
    assert(spa?.web, 'spa-app 应有 web');
    const spaBase = `/play/spa-app/r/${spa.web.releaseId}/`;

    await check('启用 SPA fallback 后深层路径返回入口 HTML', async () => {
      const response = await fetch(`${base}${spaBase}dashboard`, { headers: { accept: 'text/html' } });
      assertEqual(response.status, 200, '状态码');
      assert((response.headers.get('content-type') ?? '').includes('text/html'), 'Content-Type');
      const missingAsset = await fetch(`${base}${spaBase}assets/missing.js`);
      assertEqual(missingAsset.status, 404, '缺失资源仍应 404');
    });

    await check('不存在的项目 / 版本返回 404', async () => {
      assertEqual((await fetch(`${base}/play/not-a-project/`)).status, 404, '未知项目');
      assertEqual((await fetch(`${base}/play/demo-tool/r/r-19700101t000000z-000000/`)).status, 404, '未知版本');
      assertEqual((await fetch(`${base}/play/demo-tool/not-a-release/`)).status, 404, '非法版本路径');
    });

    await check('下载响应头正确（含中文文件名）', async () => {
      const response = await fetch(`${base}${exeRecord.publicUrl}`);
      assertEqual(response.status, 200, '状态码');
      const disposition = response.headers.get('content-disposition') ?? '';
      assert(disposition.startsWith('attachment;'), 'Content-Disposition 应为附件');
      assertEqual(response.headers.get('content-length'), String(exeBytes.length), 'Content-Length');
      assertEqual(response.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges');
      assertEqual(response.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
      const body = Buffer.from(await response.arrayBuffer());
      assertEqual(body.length, exeBytes.length, '响应体长度');
      assertEqual(sha256(body), exeRecord.sha256, 'SHA-256 应与 catalog 一致');

      const apk = demo.downloads.find((item) => item.fileName === '演示工具-2.0.0.apk');
      assert(apk, '应有中文名 APK');
      const apkResponse = await fetch(`${base}${apk.publicUrl}`);
      assertEqual(apkResponse.status, 200, '中文名下载状态码');
      const apkDisposition = apkResponse.headers.get('content-disposition') ?? '';
      assert(apkDisposition.includes("filename*=UTF-8''"), '应带 UTF-8 文件名');
      assert(/^[\x20-\x7e]*$/.test(apkDisposition), 'Content-Disposition 头必须是 ASCII');
    });

    await check('HEAD 请求返回相同头部但没有响应体', async () => {
      const response = await fetch(`${base}${exeRecord.publicUrl}`, { method: 'HEAD' });
      assertEqual(response.status, 200, '状态码');
      assertEqual(response.headers.get('content-length'), String(exeBytes.length), 'Content-Length');
      const body = Buffer.from(await response.arrayBuffer());
      assertEqual(body.length, 0, '响应体应为空');
    });

    await check('Range 请求返回 206 与正确分片', async () => {
      const response = await fetch(`${base}${exeRecord.publicUrl}`, { headers: { range: 'bytes=0-9' } });
      assertEqual(response.status, 206, '状态码');
      assertEqual(response.headers.get('content-range'), `bytes 0-9/${exeBytes.length}`, 'Content-Range');
      assertEqual(response.headers.get('content-length'), '10', 'Content-Length');
      const body = Buffer.from(await response.arrayBuffer());
      assertEqual(sha256(body), sha256(exeBytes.subarray(0, 10)), '分片内容');

      const suffix = await fetch(`${base}${exeRecord.publicUrl}`, { headers: { range: 'bytes=-8' } });
      assertEqual(suffix.status, 206, '后缀范围状态码');
      const suffixBody = Buffer.from(await suffix.arrayBuffer());
      assertEqual(suffixBody.length, 8, '后缀范围长度');
      assertEqual(sha256(suffixBody), sha256(exeBytes.subarray(exeBytes.length - 8)), '后缀范围内容');
    });

    await check('非法 Range 被忽略，越界 Range 返回 416', async () => {
      const invalid = await fetch(`${base}${exeRecord.publicUrl}`, { headers: { range: 'bytes=abc' } });
      assertEqual(invalid.status, 200, '语法无效应按 RFC 忽略');
      const unsatisfiable = await fetch(`${base}${exeRecord.publicUrl}`, { headers: { range: 'bytes=999999999-' } });
      assertEqual(unsatisfiable.status, 416, '越界应 416');
      assertEqual(
        unsatisfiable.headers.get('content-range'),
        `bytes */${exeBytes.length}`,
        '416 Content-Range',
      );
    });

    await check('/download/<slug> 快捷地址跳到默认项', async () => {
      const response = await fetch(`${base}/download/demo-tool`, { redirect: 'manual' });
      assertEqual(response.status, 302, '状态码');
      assertEqual(response.headers.get('location'), exeRecord.publicUrl, 'Location');
    });

    await check('多下载且没有默认项时快捷地址返回 409 并列出选项', async () => {
      await publishProject(publisherConfig, { manifestPath: fixture.manifestMultiDownload });
      const response = await fetch(`${base}/download/multi-download`, { redirect: 'manual' });
      assertEqual(response.status, 409, '状态码');
      const body = (await response.json()) as {
        error?: { code?: string };
        downloads?: Array<{ fileName: string; publicUrl: string }>;
      };
      assertEqual(body.error?.code, 'multiple_download_choices', '错误码');
      assertEqual(body.downloads?.length, 2, '可选项数量');
      assert(
        body.downloads?.every((item) => item.publicUrl.startsWith('/download/multi-download/')) ?? false,
        '每个选项都应带公开下载地址',
      );
    });

    await check('未登记的文件名 404', async () => {
      assertEqual((await fetch(`${base}/download/demo-tool/not-listed.exe`)).status, 404, '未知文件');
      assertEqual((await fetch(`${base}/download/not-a-project`)).status, 404, '未知项目');
      assertEqual((await fetch(`${base}/download/demo-tool/a/b/c.exe`)).status, 404, '多余路径段');
    });

    await check('媒体资源只暴露登记过的图片', async () => {
      const cover = demo.cover;
      assert(cover, 'demo-tool 应有封面');
      const response = await fetch(`${base}${cover.url}`);
      assertEqual(response.status, 200, '状态码');
      assert((response.headers.get('content-type') ?? '').includes('image/svg+xml'), 'Content-Type');
      assert((response.headers.get('cache-control') ?? '').includes('immutable'), '应发长缓存');
      const wrong = await fetch(`${base}${cover.url.replace('cover', 'hack')}`);
      assertEqual(wrong.status, 404, '未登记文件名应 404');
    });

    await check('路径穿越与数据目录泄露被拒绝', async () => {
      const attempts = [
        `${base}/play/demo-tool/r/${releaseId}/..%2F..%2F..%2Fcatalog.json`,
        `${base}/play/demo-tool/r/${releaseId}/%2e%2e%2f%2e%2e%2fcatalog.json`,
        `${base}/download/demo-tool/..%2Fcatalog.json`,
        `${base}/media/demo-tool/r/${releaseId}/..%2F..%2Fcatalog.json`,
        `${base}/catalog.json`,
        `${base}/projects/demo-tool/releases/${releaseId}/release.json`,
      ];
      for (const url of attempts) {
        const response = await fetch(url);
        assert(response.status === 404 || response.status === 400, `${url} 应被拒绝，实际 ${response.status}`);
        const text = await response.text();
        assert(!text.includes('"schemaVersion"'), `${url} 不应返回 catalog 内容`);
      }
    });

    await check('发布后无需重启即可看到新内容', async () => {
      const before = (await (await fetch(`${base}/api/projects`)).json()) as {
        projects: Array<{ slug: string }>;
      };
      assert(!before.projects.some((project) => project.slug === 'hot-reload'), '热更新前不应存在');
      await publishProject(publisherConfig, { manifestPath: fixture.manifestHotReload });
      const after = (await (await fetch(`${base}/api/projects`)).json()) as {
        projects: Array<{ slug: string }>;
      };
      assert(after.projects.some((project) => project.slug === 'hot-reload'), '热更新后应立刻可见');
    });

    section('下架与回滚');
    await check('下架后首页、试玩、下载统一 404 且文件保留', async () => {
      const result = await unpublishProject(publisherConfig, { slug: 'demo-tool', reason: '自测下架' });
      assertEqual(result.status, 'unpublished', '状态');
      const api = (await (await fetch(`${base}/api/projects`)).json()) as { projects: Array<{ slug: string }> };
      assert(!api.projects.some((project) => project.slug === 'demo-tool'), '首页不应再出现');
      assertEqual((await fetch(`${base}/play/demo-tool/`)).status, 404, '试玩应 404');
      assertEqual((await fetch(`${base}${exeRecord.publicUrl}`)).status, 404, '下载应 404');
      assert(fs.existsSync(exePath), '文件应仍然保留');
    });

    await check('回滚恢复到上一个状态', async () => {
      const result = await rollbackProject(publisherConfig, { slug: 'demo-tool' });
      assertEqual(result.status, 'rolled_back', '状态');
      const api = (await (await fetch(`${base}/api/projects`)).json()) as { projects: Array<{ slug: string }> };
      assert(api.projects.some((project) => project.slug === 'demo-tool'), '回滚后应重新出现在首页');
      assertEqual((await fetch(`${base}${exeRecord.publicUrl}`)).status, 200, '下载应恢复');
    });

    await check('回滚历史可列出且能指定目标', async () => {
      const listed = await rollbackProject(publisherConfig, { slug: 'demo-tool', listOnly: true });
      assertEqual(listed.status, 'listed', '状态');
      assert(listed.history.length >= 3, '历史状态应至少 3 个');
    });

    section('备份与恢复');
    await check('备份后恢复能回到备份时的状态', async () => {
      await publishProject(publisherConfig, { manifestPath: fixture.manifestThirdVersion });
      const backup = await backupData(publisherConfig, { out: path.join(root, 'backups') });
      assert(backup.fileCount > 0, '备份文件数应大于 0');
      const backedUpCatalog = await readCatalogFile(dataDir);
      const revisionAtBackup = backedUpCatalog.revision;

      // 备份之后再做一次发布，然后恢复
      await publishProject(publisherConfig, { manifestPath: fixture.manifestFourthVersion });
      const afterPublish = await readCatalogFile(dataDir);
      assert(afterPublish.revision > revisionAtBackup, '恢复前 revision 应更大');

      const restored = await restoreData(publisherConfig, { from: backup.path });
      assertEqual(restored.status, 'restored', '状态');
      const afterRestore = await readCatalogFile(dataDir);
      assertEqual(afterRestore.revision, revisionAtBackup, '恢复后 revision 应回到备份时');
      const project = findProject(afterRestore, 'demo-tool');
      assert(project, '恢复后项目应存在');
      assertEqual(
        project.downloads.some((item) => item.fileName === '演示工具-2.0.0.apk'),
        true,
        '恢复后应回到 2.0.0 APK',
      );
    });

    await check('校验失败的备份拒绝恢复', async () => {
      const broken = path.join(root, 'broken-backup');
      await fs.promises.mkdir(broken, { recursive: true });
      await fs.promises.writeFile(
        path.join(broken, 'backup-manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          catalogRevision: 1,
          projectCount: 1,
          files: [{ path: 'catalog.json', size: 999, sha256: 'a'.repeat(64) }],
        }),
      );
      await fs.promises.writeFile(path.join(broken, 'catalog.json'), '{}');
      await expectError(() => restoreData(publisherConfig, { from: broken }), 'invalid_backup', '坏备份');
    });

    section('管理页面');
    const adminPassword = 'selftest-pass-2026';
    await writeAuth(dataDir, adminPassword);
    const adminHeaders = { 'x-fennec-admin': '1' };
    const login = async (password: string) => {
      const response = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ password }),
      });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
    };

    await check('未携带标记的写请求被拒绝', async () => {
      const response = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: adminPassword }),
      });
      assertEqual(response.status, 403, '状态');
    });

    await check('跨站 Origin 被拒绝', async () => {
      const response = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders, origin: 'https://evil.example' },
        body: JSON.stringify({ password: adminPassword }),
      });
      assertEqual(response.status, 403, '状态');
    });

    await check('密码错误被拒，密码正确可登录并下发 HttpOnly 会话', async () => {
      const wrong = await login('not-the-password');
      assertEqual(wrong.status, 401, '错误密码状态');
      assertEqual(wrong.cookie, '', '错误密码不应下发 cookie');

      const right = await login(adminPassword);
      assertEqual(right.status, 200, '正确密码状态');
      assert(right.cookie.startsWith('fh_admin='), '应下发会话 cookie');

      const raw = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ password: adminPassword }),
      });
      const setCookie = raw.headers.get('set-cookie') ?? '';
      assert(setCookie.includes('HttpOnly'), `cookie 应带 HttpOnly：${setCookie}`);
      assert(setCookie.includes('SameSite=Strict'), `cookie 应带 SameSite=Strict：${setCookie}`);
    });

    const sessionCookie = (await login(adminPassword)).cookie;

    await check('未登录读取项目列表返回 401', async () => {
      const response = await fetch(`${base}/api/admin/projects`);
      assertEqual(response.status, 401, '状态');
    });

    await check('登录后可以读到全部项目（含已下架）', async () => {
      // 先造一个下架状态：管理列表应该照样看得到它
      await unpublishProject(publisherConfig, { slug: 'demo-tool', reason: '自测下架' });

      const response = await fetch(`${base}/api/admin/projects`, { headers: { cookie: sessionCookie } });
      assertEqual(response.status, 200, '状态');
      const body = (await response.json()) as { revision: number; projects: Array<{ slug: string; published: boolean }> };
      const catalog = await readCatalogFile(dataDir);
      assertEqual(body.projects.length, catalog.projects.length, '应返回全部项目');
      assert(
        body.projects.some((project) => project.slug === 'demo-tool' && !project.published),
        '已下架项目应出现在管理列表里',
      );

      await updateProjectMeta(publisherConfig, 'demo-tool', { published: true });
    });

    await check('修改元信息：生效且不新增版本目录', async () => {
      const before = await readCatalogFile(dataDir);
      const beforeProject = findProject(before, 'demo-tool');
      assert(beforeProject, '应有 demo-tool');
      const releasesBefore = fs.readdirSync(path.join(dataDir, 'projects', 'demo-tool', 'releases')).length;

      const response = await fetch(`${base}/api/admin/projects/demo-tool`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...adminHeaders, cookie: sessionCookie },
        body: JSON.stringify({ title: '演示工具（管理页改过）', sortOrder: 42, displayVersion: '9.9.9' }),
      });
      assertEqual(response.status, 200, '状态');

      const after = await readCatalogFile(dataDir);
      const afterProject = findProject(after, 'demo-tool');
      assertEqual(afterProject?.title, '演示工具（管理页改过）', '标题');
      assertEqual(afterProject?.sortOrder, 42, '排序值');
      assertEqual(afterProject?.displayVersion, '9.9.9', '版本号');
      assertEqual(after.revision, before.revision + 1, 'revision 应 +1');
      assertEqual(
        fs.readdirSync(path.join(dataDir, 'projects', 'demo-tool', 'releases')).length,
        releasesBefore,
        '只改元信息不应产生新版本目录',
      );
    });

    const pngOnePixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    await check('上传封面：生成新版本、旧版本保留、图片可访问', async () => {
      const before = await readCatalogFile(dataDir);
      const beforeProject = findProject(before, 'demo-tool');
      assert(beforeProject?.cover, '上传前应已有封面');
      const oldRelease = beforeProject.cover.releaseId;

      const response = await fetch(`${base}/api/admin/projects/demo-tool/cover`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', ...adminHeaders, cookie: sessionCookie },
        body: pngOnePixel,
      });
      assertEqual(response.status, 200, '状态');
      const body = (await response.json()) as { releaseId: string; cover: { url: string; releaseId: string } };
      assert(body.releaseId !== oldRelease, '应生成新的发布版本');

      const after = await readCatalogFile(dataDir);
      const afterProject = findProject(after, 'demo-tool');
      assertEqual(afterProject?.cover?.releaseId, body.releaseId, 'catalog 应指向新版本');
      assert(fs.existsSync(path.join(dataDir, 'projects', 'demo-tool', 'releases', oldRelease)), '旧版本目录应保留');
      assert(afterProject?.web, 'web 记录应保留');

      const image = await fetch(`${base}${body.cover.url}`);
      assertEqual(image.status, 200, '封面应可访问');
      assertEqual(image.headers.get('content-type'), 'image/png', '封面 content-type');
      const bytes = Buffer.from(await image.arrayBuffer());
      assert(bytes.equals(pngOnePixel), '取回的封面应与上传内容一致');
    });

    await check('上传非图片被拒绝', async () => {
      const response = await fetch(`${base}/api/admin/projects/demo-tool/cover`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', ...adminHeaders, cookie: sessionCookie },
        body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
      });
      assertEqual(response.status, 415, '状态');
    });

    await check('增删截图', async () => {
      const add = await fetch(`${base}/api/admin/projects/demo-tool/screenshots?alt=${encodeURIComponent('测试截图')}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', ...adminHeaders, cookie: sessionCookie },
        body: pngOnePixel,
      });
      assertEqual(add.status, 200, '新增状态');
      let catalog = await readCatalogFile(dataDir);
      let project = findProject(catalog, 'demo-tool');
      const countAfterAdd = project?.screenshots.length ?? 0;
      assert(countAfterAdd >= 1, '应有截图');
      assertEqual(project?.screenshots[countAfterAdd - 1]?.alt, '测试截图', '截图 alt');

      const remove = await fetch(`${base}/api/admin/projects/demo-tool/screenshots/${countAfterAdd - 1}`, {
        method: 'DELETE',
        headers: { ...adminHeaders, cookie: sessionCookie },
      });
      assertEqual(remove.status, 200, '删除状态');
      catalog = await readCatalogFile(dataDir);
      project = findProject(catalog, 'demo-tool');
      assertEqual(project?.screenshots.length, countAfterAdd - 1, '删除后数量');
    });

    await check('越界截图序号返回 400', async () => {
      const response = await fetch(`${base}/api/admin/projects/demo-tool/screenshots/99`, {
        method: 'DELETE',
        headers: { ...adminHeaders, cookie: sessionCookie },
      });
      assertEqual(response.status, 400, '状态');
    });

    await check('修改密码后旧密码失效、其它会话被踢', async () => {
      const other = (await login(adminPassword)).cookie;
      assert(other.length > 0, '应能再登录一个会话');
      const nextPassword = 'selftest-pass-2027';

      const change = await fetch(`${base}/api/admin/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders, cookie: sessionCookie },
        body: JSON.stringify({ currentPassword: adminPassword, newPassword: nextPassword }),
      });
      assertEqual(change.status, 200, '改密码状态');
      const body = (await change.json()) as { kickedSessions: number };
      assert(body.kickedSessions >= 1, '应踢掉其它会话');

      const otherAfter = await fetch(`${base}/api/admin/projects`, { headers: { cookie: other } });
      assertEqual(otherAfter.status, 401, '被踢的会话应失效');
      const currentStill = await fetch(`${base}/api/admin/projects`, { headers: { cookie: sessionCookie } });
      assertEqual(currentStill.status, 200, '当前会话应继续可用');

      const oldLogin = await login(adminPassword);
      assertEqual(oldLogin.status, 401, '旧密码应失效');
      const newLogin = await login(nextPassword);
      assertEqual(newLogin.status, 200, '新密码应可用');
    });

    // ---------- 管理页面：标签 / 新建项目 / 发布新版本 / 埋点 ----------
    const adminFetch = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { ...adminHeaders, cookie: sessionCookie, ...(init.headers as Record<string, string> | undefined) },
      });

    await check('标签：新增、幂等、删除时从项目上摘掉', async () => {
      const created = await adminFetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: '自测标签' }),
      });
      assertEqual(created.status, 200, '新增标签状态');
      const createdBody = (await created.json()) as { tag: { label: string } };
      assertEqual(createdBody.tag.label, '自测标签', '标签名');

      const again = await adminFetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: '自测标签' }),
      });
      assertEqual(again.status, 200, '重复新增应幂等');

      let catalog = await readCatalogFile(dataDir);
      assertEqual(catalog.tags.filter((tag) => tag.label === '自测标签').length, 1, '登记表里只有一条');

      const overview = await adminFetch('/api/admin/tags');
      const overviewBody = (await overview.json()) as { tags: Array<{ label: string; projectCount: number }> };
      assert(overviewBody.tags.some((tag) => tag.label === '自测标签'), '标签总览应包含新标签');

      const remove = await adminFetch(`/api/admin/tags/${encodeURIComponent('自测标签')}`, { method: 'DELETE' });
      assertEqual(remove.status, 200, '删除标签状态');
      catalog = await readCatalogFile(dataDir);
      assertEqual(catalog.tags.some((tag) => tag.label === '自测标签'), false, '登记表里应已删除');
      assertEqual(
        catalog.projects.every((project) => !project.tags.includes('自测标签')),
        true,
        '项目上不应残留该标签',
      );
    });

    await check('新建项目：出现在 catalog，未上架时公开接口看不到', async () => {
      await adminFetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: '自测' }),
      });

      const created = await adminFetch('/api/admin/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'admin-created',
          title: '管理页建的项目',
          summary: '来自管理页的测试项目',
          categories: ['web'],
          tags: ['自测'],
          published: false,
        }),
      });
      assertEqual(created.status, 201, '创建状态');
      const body = (await created.json()) as { slug: string };
      assertEqual(body.slug, 'admin-created', 'slug');

      const catalog = await readCatalogFile(dataDir);
      const project = findProject(catalog, 'admin-created');
      assert(project, 'catalog 里应有新项目');
      assertEqual(project?.published, false, '默认未上架');
      assertEqual(project?.tags.join(','), '自测', '标签');
      assertEqual(project?.web, null, '还没有试玩包');
      assertEqual(project?.releaseHistory.length, 0, '新建项目还没有发布版本');

      const publicList = await fetch(`${base}/api/projects`);
      const publicBody = (await publicList.json()) as { projects: Array<{ slug: string }>; tags: string[] };
      assertEqual(publicBody.projects.some((item) => item.slug === 'admin-created'), false, '未上架不应出现在公开列表');
      assert(publicBody.tags.includes('自测'), '公开接口应返回标签表');

      const publish = await adminFetch('/api/admin/projects/admin-created', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ published: true }),
      });
      assertEqual(publish.status, 200, '上架状态');
    });

    await check('一键发布试玩（单文件 HTML）：入口保留原文件名且能打开', async () => {
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>自测页</title></head><body><h1>ADMIN-HTML-MARK</h1></body></html>';
      const response = await adminFetch('/api/admin/projects/admin-created/web', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-file-name': encodeURIComponent('演示页.html') },
        body: html,
      });
      assertEqual(response.status, 200, '上传状态');
      const body = (await response.json()) as { entry: string; releaseId: string };
      assertEqual(body.entry, '演示页.html', '入口应保留原文件名');

      const play = await fetch(`${base}/play/admin-created/`, { redirect: 'manual' });
      assertEqual(play.status, 302, '试玩入口重定向');
      const location = play.headers.get('location') ?? '';
      const page = await fetch(`${base}${location}`);
      assertEqual(page.status, 200, '试玩页面状态');
      const text = await page.text();
      assert(text.includes('ADMIN-HTML-MARK'), '页面内容应是刚上传的 HTML');

      const catalog = await readCatalogFile(dataDir);
      const project = findProject(catalog, 'admin-created');
      assertEqual(project?.web?.releaseId, body.releaseId, 'catalog 指向新版本');
    });

    await check('一键发布试玩（ZIP）：自动识别入口', async () => {
      const zip = buildZip([
        { name: 'site/index.html', content: '<!doctype html><html><body><h1>ZIP-MARK</h1><script src="app.js"></script></body></html>' },
        { name: 'site/app.js', content: 'console.log("zip")' },
      ]);
      const response = await adminFetch('/api/admin/projects/admin-created/web', {
        method: 'PUT',
        headers: { 'content-type': 'application/zip' },
        body: zip,
      });
      assertEqual(response.status, 200, '上传状态');
      const body = (await response.json()) as { entry: string; fileCount: number };
      assertEqual(body.entry, 'index.html', 'ZIP 入口');
      assertEqual(body.fileCount, 2, 'ZIP 文件数');

      const page = await fetch(`${base}/play/admin-created/`);
      const text = await page.text();
      assert(text.includes('ZIP-MARK'), '页面内容应来自 ZIP');

      const catalog = await readCatalogFile(dataDir);
      const project = findProject(catalog, 'admin-created');
      assertEqual(project?.web?.entry, 'index.html', 'catalog 入口');
      assertEqual(project?.releaseHistory.some((entry) => entry.parts.includes('web')), true, '应有 web 历史');
    });

    await check('非 HTML/ZIP 内容被拒绝', async () => {
      const response = await adminFetch('/api/admin/projects/admin-created/web', {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('just some text, not a page', 'utf8'),
      });
      assertEqual(response.status, 415, '状态');
    });

    await check('上传下载包：可下载、可覆盖、平台记录正确', async () => {
      const first = Buffer.from('PK\u0003\u0004 假的下载内容 v1', 'utf8');
      const upload = await adminFetch('/api/admin/projects/admin-created/downloads', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent('演示包-1.0.0.zip'),
          'x-platform': 'android',
          'x-version': encodeURIComponent('1.0.0'),
        },
        body: first,
      });
      assertEqual(upload.status, 200, '上传状态');
      const uploadBody = (await upload.json()) as { replaced: boolean; download: { publicUrl: string; platform: string } };
      assertEqual(uploadBody.replaced, false, '首次上传不算替换');
      assertEqual(uploadBody.download.platform, 'android', '平台');

      const download = await fetch(`${base}${uploadBody.download.publicUrl}`);
      assertEqual(download.status, 200, '下载状态');
      const bytes = Buffer.from(await download.arrayBuffer());
      assert(bytes.equals(first), '下载内容应与上传一致');

      const second = Buffer.from('PK\u0003\u0004 假的下载内容 v2 更长一点', 'utf8');
      const replace = await adminFetch('/api/admin/projects/admin-created/downloads', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent('演示包-1.0.0.zip'),
          'x-platform': 'android',
        },
        body: second,
      });
      assertEqual(replace.status, 200, '替换状态');
      const replaceBody = (await replace.json()) as { replaced: boolean };
      assertEqual(replaceBody.replaced, true, '同名文件应走替换');

      const after = await fetch(`${base}${uploadBody.download.publicUrl}`);
      const afterBytes = Buffer.from(await after.arrayBuffer());
      assert(afterBytes.equals(second), '替换后下载内容应更新');

      const catalog = await readCatalogFile(dataDir);
      const project = findProject(catalog, 'admin-created');
      assertEqual(project?.downloads.length, 1, '同名文件只保留一条记录');
      assertEqual(project?.downloads[0]?.isDefault, true, '第一个下载包应自动成为默认');
    });

    await check('埋点：分享/试玩上报后公开接口与后台都能看到', async () => {
      const report = (type: string) =>
        fetch(`${base}/api/stats/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type, slug: 'admin-created', source: 'selftest' }),
        });

      const share = await report('share_click');
      assertEqual(share.status, 204, '分享上报状态');
      const play = await report('play_click');
      assertEqual(play.status, 204, '试玩上报状态');
      const bogus = await report('not_a_type');
      assertEqual(bogus.status, 400, '未知类型应拒绝');

      const publicList = await fetch(`${base}/api/projects`);
      const publicBody = (await publicList.json()) as {
        projects: Array<{ slug: string; stats: { playClicks: number; shareClicks: number; downloads: number } }>;
      };
      const target = publicBody.projects.find((item) => item.slug === 'admin-created');
      assert(target, '公开列表里应有这个项目');
      assertEqual(target?.stats.shareClicks, 1, '分享计数');
      assertEqual(target?.stats.playClicks, 1, '试玩计数');
      assert((target?.stats.downloads ?? 0) >= 2, '下载计数应包含前面两次下载');

      const stats = await adminFetch('/api/admin/stats?days=14');
      assertEqual(stats.status, 200, '后台数据接口');
      const statsBody = (await stats.json()) as {
        totals: { playClicks: number; shareClicks: number; downloads: number };
        byPlatform: Record<string, number>;
        byProject: Record<string, { downloads: number }>;
      };
      assert(statsBody.totals.shareClicks >= 1, '总分享数');
      assert(statsBody.totals.downloads >= 2, '总下载数');
      assert((statsBody.byPlatform.android ?? 0) >= 3, '平台分布里应有 android 下载');
      assert((statsBody.byProject['admin-created']?.downloads ?? 0) >= 2, '按项目统计');
    });

    await check('未登录不能新建项目或上传试玩包', async () => {
      const create = await fetch(`${base}/api/admin/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ slug: 'nope', title: 'nope', categories: ['web'] }),
      });
      assertEqual(create.status, 401, '创建应 401');

      const upload = await fetch(`${base}/api/admin/projects/admin-created/web`, {
        method: 'PUT',
        headers: { 'content-type': 'text/html', ...adminHeaders },
        body: '<html></html>',
      });
      assertEqual(upload.status, 401, '上传应 401');
    });
    await check('弱密码被拒绝', async () => {
      const response = await fetch(`${base}/api/admin/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders, cookie: sessionCookie },
        body: JSON.stringify({ currentPassword: 'selftest-pass-2027', newPassword: '123' }),
      });
      assertEqual(response.status, 400, '状态');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---- 汇总 ----
  const failed = checks.filter((item) => !item.ok);
  process.stdout.write('\n===================\n');
  process.stdout.write(`共 ${checks.length} 项检查：通过 ${checks.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length > 0) {
    for (const item of failed) process.stdout.write(`  ✘ ${item.name}\n      → ${item.error ?? ''}\n`);
  }
  process.stdout.write(`临时数据目录：${root}\n`);

  if (process.env.SELFTEST_KEEP !== '1') {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  if (failed.length > 0) process.exit(1);
}

interface Fixtures {
  manifestFull: string;
  manifestApkOnly: string;
  manifestApkCleanup: string;
  manifestSpa: string;
  manifestSecond: string;
  manifestInvalid: string;
  manifestSlip: string;
  manifestNoIndex: string;
  manifestMultiNoEntry: string;
  manifestMultiWithEntry: string;
  manifestHotReload: string;
  manifestMultiDownload: string;
  manifestThirdVersion: string;
  manifestFourthVersion: string;
}

const SITE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Demo</title>
<link rel="stylesheet" href="./assets/style.css"></head><body><h1>Demo tool</h1>
<img src="./assets/logo.svg" alt="logo"><script src="./assets/app.js"></script></body></html>`;

async function prepareFixtures(): Promise<Fixtures> {
  await write('site/index.html', SITE_HTML);
  await write('site/assets/app.js', 'document.title = "demo-tool running";\n');
  await write('site/assets/style.css', 'body{font-family:system-ui;color:#0d2433}\n');
  await write('site/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0e7490"/></svg>');

  await write(
    'spa/index.html',
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>SPA</title></head>' +
      '<body><div id="app"></div><script src="./assets/app.js"></script></body></html>',
  );
  await write('spa/assets/app.js', 'document.getElementById("app").textContent = "spa ready";\n');

  await write('bin/DemoTool-1.0.0.exe', 'TEST FIXTURE ONLY - this is not a real Windows executable.\n');
  await write('bin/演示工具-1.0.0.apk', 'TEST FIXTURE ONLY - this is not a real Android package.\n');
  await write('bin/演示工具-2.0.0.apk', 'TEST FIXTURE ONLY - version 2 pseudo apk payload.\n');

  await write('media/cover.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="#0f766e"/></svg>');
  await write('media/shot.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="#0e7490"/><circle cx="8" cy="5" r="2" fill="#fff"/></svg>');

  // 正常 ZIP：带一层外包装目录
  await fs.promises.mkdir(path.join(fixturesDir, 'zips'), { recursive: true });
  await fs.promises.writeFile(
    path.join(fixturesDir, 'zips/valid.zip'),
    buildZip([
      { name: 'site/index.html', content: SITE_HTML },
      { name: 'site/assets/app.js', content: 'window.__demo = true;\n' },
    ]),
  );

  await fs.promises.writeFile(
    path.join(fixturesDir, 'zips/slip.zip'),
    buildZip([
      { name: 'index.html', content: '<html><body>ok</body></html>' },
      { name: '../evil.txt', content: 'escaped' },
    ]),
  );
  await fs.promises.writeFile(
    path.join(fixturesDir, 'zips/no-index.zip'),
    buildZip([{ name: 'readme.txt', content: 'no entry here' }]),
  );
  await fs.promises.writeFile(
    path.join(fixturesDir, 'zips/multi.zip'),
    buildZip([
      { name: 'a/index.html', content: '<html><body>a</body></html>' },
      { name: 'b/index.html', content: '<html><body>b</body></html>' },
    ]),
  );
  await fs.promises.writeFile(
    path.join(fixturesDir, 'zips/spa.zip'),
    buildZip([
      { name: 'index.html', content: '<html><body><div id="app"></div></body></html>' },
      { name: 'assets/app.js', content: 'console.log("spa");\n' },
    ]),
  );

  const baseFields = {
    title: '演示工具',
    summary: '自测用的项目：网页 + EXE + APK。',
    description: '第一行\n第二行',
    categories: ['web', 'desktop', 'mobile'],
    displayVersion: '1.0.0',
    cover: { path: '../media/cover.svg', alt: '演示工具封面' },
    screenshots: ['../media/shot.svg'],
  };

  const manifestFull = await write(
    'manifests/demo-tool.json',
    JSON.stringify(
      {
        slug: 'demo-tool',
        ...baseFields,
        web: { directory: '../site', entry: 'index.html', spaFallback: false },
        downloads: [
          { fileName: 'DemoTool-1.0.0.exe', path: '../bin/DemoTool-1.0.0.exe', platform: 'windows', version: '1.0.0', default: true },
          { fileName: '演示工具-1.0.0.apk', path: '../bin/演示工具-1.0.0.apk', platform: 'android', version: '1.0.0' },
        ],
      },
      null,
      2,
    ),
  );

  const manifestApkOnly = await write(
    'manifests/demo-tool-apk.json',
    JSON.stringify(
      {
        slug: 'demo-tool',
        title: '演示工具',
        summary: baseFields.summary,
        description: baseFields.description,
        categories: baseFields.categories,
        displayVersion: '2.0.0',
        downloads: [
          { fileName: '演示工具-2.0.0.apk', path: '../bin/演示工具-2.0.0.apk', platform: 'android', version: '2.0.0' },
        ],
      },
      null,
      2,
    ),
  );

  const manifestApkCleanup = await write(
    'manifests/demo-tool-apk-cleanup.json',
    JSON.stringify(
      {
        slug: 'demo-tool',
        title: '演示工具',
        summary: baseFields.summary,
        description: baseFields.description,
        categories: baseFields.categories,
        displayVersion: '2.0.0',
        downloads: [
          { fileName: '演示工具-2.0.0.apk', path: '../bin/演示工具-2.0.0.apk', platform: 'android', version: '2.0.0' },
        ],
        removeDownloads: ['演示工具-1.0.0.apk'],
      },
      null,
      2,
    ),
  );

  const manifestSpa = await write(
    'manifests/spa-app.json',
    JSON.stringify(
      {
        slug: 'spa-app',
        title: 'SPA 应用',
        summary: '验证 SPA fallback 的项目。',
        categories: ['web'],
        web: { package: '../zips/spa.zip', entry: 'index.html', spaFallback: true },
      },
      null,
      2,
    ),
  );

  const manifestSecond = await write(
    'manifests/second-project.json',
    JSON.stringify(
      {
        slug: 'second-project',
        title: '第二个项目',
        summary: '并发发布测试用项目。',
        categories: ['desktop'],
        downloads: [
          { fileName: 'Second-1.0.0.exe', path: '../bin/DemoTool-1.0.0.exe', platform: 'windows', version: '1.0.0' },
        ],
      },
      null,
      2,
    ),
  );

  const manifestInvalid = await write(
    'manifests/invalid.json',
    JSON.stringify({ slug: 'Bad Slug!', title: '', categories: ['unknown'] }, null, 2),
  );

  const manifestSlip = await write(
    'manifests/slip.json',
    JSON.stringify(
      { slug: 'slip-demo', title: '路径穿越包', categories: ['web'], web: { package: '../zips/slip.zip' } },
      null,
      2,
    ),
  );

  const manifestNoIndex = await write(
    'manifests/no-index.json',
    JSON.stringify(
      { slug: 'no-index-demo', title: '无入口包', categories: ['web'], web: { package: '../zips/no-index.zip' } },
      null,
      2,
    ),
  );

  const manifestMultiNoEntry = await write(
    'manifests/multi-no-entry.json',
    JSON.stringify(
      { slug: 'multi-demo', title: '多入口包', categories: ['web'], web: { package: '../zips/multi.zip' } },
      null,
      2,
    ),
  );

  const manifestMultiWithEntry = await write(
    'manifests/multi-with-entry.json',
    JSON.stringify(
      {
        slug: 'multi-demo',
        title: '多入口包',
        categories: ['web'],
        web: { package: '../zips/multi.zip', entry: 'a/index.html' },
      },
      null,
      2,
    ),
  );

  const manifestMultiDownload = await write(
    'manifests/multi-download.json',
    JSON.stringify(
      {
        slug: 'multi-download',
        title: '多下载项目',
        summary: '两个平台文件、没有默认项，用来验证 /download/<slug> 的 409 分支。',
        categories: ['desktop', 'mobile'],
        downloads: [
          { fileName: 'DemoTool-1.0.0.exe', path: '../bin/DemoTool-1.0.0.exe', platform: 'windows', version: '1.0.0' },
          { fileName: '演示工具-2.0.0.apk', path: '../bin/演示工具-2.0.0.apk', platform: 'android', version: '2.0.0' },
        ],
      },
      null,
      2,
    ),
  );

  const manifestHotReload = await write(
    'manifests/hot-reload.json',
    JSON.stringify(
      {
        slug: 'hot-reload',
        title: '热更新项目',
        summary: '用于验证发布后无需重启即可看到。',
        categories: ['web'],
        web: { directory: '../site', entry: 'index.html' },
      },
      null,
      2,
    ),
  );

  const manifestThirdVersion = await write(
    'manifests/demo-tool-third.json',
    JSON.stringify(
      {
        slug: 'demo-tool',
        title: '演示工具',
        summary: baseFields.summary,
        description: baseFields.description,
        categories: baseFields.categories,
        displayVersion: '3.0.0',
        downloads: [
          { fileName: '演示工具-2.0.0.apk', path: '../bin/演示工具-2.0.0.apk', platform: 'android', version: '2.0.0' },
        ],
      },
      null,
      2,
    ),
  );

  const manifestFourthVersion = await write(
    'manifests/demo-tool-fourth.json',
    JSON.stringify(
      {
        slug: 'demo-tool',
        title: '演示工具',
        summary: baseFields.summary,
        description: baseFields.description,
        categories: baseFields.categories,
        displayVersion: '4.0.0',
        downloads: [
          { fileName: '演示工具-2.0.0.apk', path: '../bin/演示工具-2.0.0.apk', platform: 'android', version: '2.0.0' },
          { fileName: 'DemoTool-1.0.0.exe', path: '../bin/DemoTool-1.0.0.exe', platform: 'windows', version: '1.0.0' },
        ],
        sortOrder: 5,
      },
      null,
      2,
    ),
  );

  return {
    manifestFull,
    manifestApkOnly,
    manifestApkCleanup,
    manifestSpa,
    manifestSecond,
    manifestInvalid,
    manifestSlip,
    manifestNoIndex,
    manifestMultiNoEntry,
    manifestMultiWithEntry,
    manifestHotReload,
    manifestMultiDownload,
    manifestThirdVersion,
    manifestFourthVersion,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`自测启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
