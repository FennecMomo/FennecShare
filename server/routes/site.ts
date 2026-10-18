import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { resolveWithin, sendText, splitUrlPath, streamFile } from '../http.js';
import { contentTypeFor } from '../mime.js';
import type { Logger } from '../logger.js';

/**
 * 展示站自己的前端产物（dist/web）。
 *
 * 这是整套服务里唯一允许下发 CSP 的静态区域：站点页面不加载任何外部脚本，
 * 也不需要 inline script。试玩内容走 /play/**，与这里的安全头完全分开。
 */
const SITE_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface SiteDeps {
  config: AppConfig;
  logger: Logger;
}

export function createSiteMiddleware(deps: SiteDeps) {
  return async function siteMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    try {
      await handle(req, res, deps);
    } catch (error) {
      deps.logger.error('站点静态资源失败', { path: req.path, error: String(error) });
      if (!res.headersSent) sendText(res, 500, '页面加载失败');
      else res.destroy();
    }
  };
}

async function handle(req: Request, res: Response, deps: SiteDeps): Promise<void> {
  const webRoot = deps.config.webDistDir;
  const isRoot = req.path === '/' || req.path === '/index.html';

  if (!isRoot) {
    const segments = splitUrlPath(req.path);
    if (!segments || segments.length === 0) {
      sendText(res, 404, '页面不存在');
      return;
    }
    const absPath = resolveWithin(webRoot, segments.join('/'));
    if (!absPath) {
      sendText(res, 404, '页面不存在');
      return;
    }
    const immutable = segments[0] === 'assets';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    await streamFile(req, res, absPath, {
      contentType: contentTypeFor(absPath),
      cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      allowRange: false,
    });
    return;
  }

  const indexPath = path.join(webRoot, 'index.html');
  res.setHeader('Content-Security-Policy', SITE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await streamFile(req, res, indexPath, {
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-cache',
    allowRange: false,
    onNotFound: () => {
      deps.logger.error('前端构建产物缺失，请先执行 npm run build', { webDistDir: webRoot });
    },
  });
}
