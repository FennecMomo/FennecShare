import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { findProject } from '../../shared/catalog.js';
import type { StoredProject } from '../../shared/types.js';
import type { CatalogStore } from '../catalog.js';
import { resolveWithin, sendText, splitUrlPath, streamFile } from '../http.js';
import { contentTypeFor } from '../mime.js';
import type { Logger } from '../logger.js';

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

interface PlayDeps {
  dataDir: string;
  store: CatalogStore;
  logger: Logger;
}

function hasFileExtension(segment: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(segment);
}

function redirect(res: Response, status: number, location: string): void {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', '0');
  res.end();
}

/**
 * 在线体验路由。
 *
 *   /play/<slug>            → 308 → /play/<slug>/          （规范尾斜杠）
 *   /play/<slug>/           → 302 → /play/<slug>/r/<rid>/  （稳定入口指向版本目录）
 *   /play/<slug>/r/<rid>/*  → 直接提供该发布版本的静态文件
 *
 * 版本目录固定不变，因此这里可以放心发长缓存；已打开的老页面继续请求老版本资源
 * 不会拿到新版本文件。SPA fallback 只在项目显式启用时生效，且只对“看起来是页面”
 * 的请求（无扩展名 + 接受 HTML）生效，缺失的 js/css/图片永远 404。
 */
export function createPlayMiddleware(deps: PlayDeps) {
  return async function playMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const pathname = req.path;
    if (pathname !== '/play' && !pathname.startsWith('/play/')) {
      next();
      return;
    }
    try {
      await handle(req, res, deps);
    } catch (error) {
      deps.logger.error('在线体验路由失败', { path: pathname, error: String(error) });
      if (!res.headersSent) sendText(res, 500, '在线体验内容读取失败');
      else res.destroy();
    }
  };
}

async function handle(req: Request, res: Response, deps: PlayDeps): Promise<void> {
  const segments = splitUrlPath(req.path);
  if (!segments) {
    sendText(res, 400, '请求路径不合法');
    return;
  }

  const slug = segments[1];
  if (!slug) {
    sendText(res, 404, '缺少项目标识');
    return;
  }

  const catalog = await deps.store.read();
  const project = findProject(catalog, slug);
  if (!project || !project.published) {
    sendText(res, 404, '项目不存在或已下架');
    return;
  }

  if (segments.length === 2) {
    if (!req.path.endsWith('/')) {
      redirect(res, 308, `/play/${encodeURIComponent(slug)}/`);
      return;
    }
    if (!project.web) {
      sendText(res, 404, '该项目没有提供在线体验');
      return;
    }
    redirect(res, 302, `/play/${encodeURIComponent(slug)}/r/${project.web.releaseId}/`);
    return;
  }

  // 稳定路径下的深层链接（/play/<slug>/about/ 之类）：重定向到当前版本的同一路径。
  // 这样复制出来的页面内地址、直接粘贴的深层链接、刷新都能落在同一个版本上。
  if (segments[2] !== 'r') {
    if (!project.web) {
      sendText(res, 404, '该项目没有提供在线体验');
      return;
    }
    const rest = segments.slice(2).map((segment) => encodeURIComponent(segment)).join('/');
    const suffix = `${rest}${req.path.endsWith('/') ? '/' : ''}`;
    redirect(res, 302, `/play/${encodeURIComponent(slug)}/r/${project.web.releaseId}/${suffix}`);
    return;
  }

  if (segments.length < 4) {
    sendText(res, 404, '在线体验地址格式不正确');
    return;
  }

  const releaseId = segments[3] ?? '';
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    sendText(res, 404, '发布版本不存在');
    return;
  }
  if (segments.length === 4 && !req.path.endsWith('/')) {
    redirect(res, 308, `/play/${encodeURIComponent(slug)}/r/${encodeURIComponent(releaseId)}/`);
    return;
  }

  const webRoot = path.join(deps.dataDir, 'projects', slug, 'releases', releaseId, 'web');
  let rootStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    rootStat = await fs.stat(webRoot);
  } catch {
    sendText(res, 404, '发布版本不存在');
    return;
  }
  if (!rootStat.isDirectory()) {
    sendText(res, 404, '发布版本不存在');
    return;
  }

  const rest = segments.slice(4);
  const entryRelative = await resolveEntry(project, releaseId, webRoot);

  if (rest.length === 0) {
    const entryPath = entryRelative ? resolveWithin(webRoot, entryRelative) : null;
    if (entryPath && (await isFile(entryPath))) {
      await servePlayFile(req, res, entryPath);
      return;
    }
    const fallbackIndex = path.join(webRoot, 'index.html');
    if (await isFile(fallbackIndex)) {
      await servePlayFile(req, res, fallbackIndex);
      return;
    }
    sendText(res, 404, '入口文件不存在');
    return;
  }

  const candidate = resolveWithin(webRoot, rest.join('/'));
  if (!candidate) {
    sendText(res, 404, '资源不存在');
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stat = await fs.stat(candidate);
  } catch {
    stat = null;
  }

  if (stat?.isDirectory()) {
    const dirIndex = path.join(candidate, 'index.html');
    if (await isFile(dirIndex)) {
      await servePlayFile(req, res, dirIndex);
      return;
    }
  } else if (stat?.isFile()) {
    await servePlayFile(req, res, candidate);
    return;
  }

  const lastSegment = rest[rest.length - 1] ?? '';
  const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
  if (project.web?.spaFallback && !hasFileExtension(lastSegment) && acceptsHtml) {
    const entryPath = entryRelative ? resolveWithin(webRoot, entryRelative) : path.join(webRoot, 'index.html');
    if (entryPath && (await isFile(entryPath))) {
      await servePlayFile(req, res, entryPath);
      return;
    }
  }

  sendText(res, 404, '资源不存在');
}

async function isFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** 入口文件优先取当前发布记录的 entry；老版本回退到 release.json 里的记录。 */
async function resolveEntry(project: StoredProject, releaseId: string, webRoot: string): Promise<string | null> {
  if (project.web && project.web.releaseId === releaseId) return project.web.entry;
  try {
    const text = await fs.readFile(path.join(webRoot, '..', 'release.json'), 'utf8');
    const parsed = JSON.parse(text) as { web?: { entry?: unknown } };
    const entry = parsed.web?.entry;
    if (typeof entry === 'string' && entry.length > 0 && !entry.includes('..') && !path.isAbsolute(entry)) return entry;
  } catch {
    // 老版本没有 release.json 时按 index.html 处理
  }
  return 'index.html';
}

async function servePlayFile(req: Request, res: Response, absPath: string): Promise<void> {
  await streamFile(req, res, absPath, {
    contentType: contentTypeFor(absPath),
    cacheControl: IMMUTABLE,
    allowRange: false,
  });
}
