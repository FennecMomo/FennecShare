import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { findProject } from '../../shared/catalog.js';
import type { CatalogStore } from '../catalog.js';
import { resolveWithin, sendText, splitUrlPath, streamFile } from '../http.js';
import { contentTypeFor, isImagePath } from '../mime.js';
import type { Logger } from '../logger.js';

interface MediaDeps {
  dataDir: string;
  store: CatalogStore;
  logger: Logger;
}

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * 媒体资源路由：/media/<slug>/r/<releaseId>/<fileName>
 *
 * 只允许取项目记录里登记过的封面/截图，路径带 releaseId 所以可以长缓存；
 * 不暴露整个数据目录，也不做目录列表。
 */
export function createMediaMiddleware(deps: MediaDeps) {
  return async function mediaMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.path !== '/media' && !req.path.startsWith('/media/')) {
      next();
      return;
    }
    try {
      await handle(req, res, deps);
    } catch (error) {
      deps.logger.error('媒体路由失败', { path: req.path, error: String(error) });
      if (!res.headersSent) sendText(res, 500, '媒体读取失败');
      else res.destroy();
    }
  };
}

async function handle(req: Request, res: Response, deps: MediaDeps): Promise<void> {
  const segments = splitUrlPath(req.path);
  if (!segments) {
    sendText(res, 400, '请求路径不合法');
    return;
  }
  if (segments.length !== 5 || segments[2] !== 'r') {
    sendText(res, 404, '媒体地址格式不正确');
    return;
  }

  const slug = segments[1] ?? '';
  const releaseId = segments[3] ?? '';
  const fileName = segments[4] ?? '';
  if (!RELEASE_ID_PATTERN.test(releaseId) || fileName.length === 0) {
    sendText(res, 404, '媒体不存在');
    return;
  }

  const catalog = await deps.store.read();
  const project = findProject(catalog, slug);
  if (!project || !project.published) {
    sendText(res, 404, '项目不存在或已下架');
    return;
  }

  const registered = [project.cover, ...project.screenshots].filter(
    (asset): asset is NonNullable<typeof asset> => asset !== null,
  );
  const asset = registered.find((item) => item.releaseId === releaseId && item.fileName === fileName);
  if (!asset) {
    sendText(res, 404, '媒体不存在');
    return;
  }

  const absPath = resolveWithin(
    deps.dataDir,
    path.posix.join('projects', slug, 'releases', releaseId, 'media', fileName),
  );
  if (!absPath || !isImagePath(absPath)) {
    sendText(res, 404, '媒体不存在');
    return;
  }

  await streamFile(req, res, absPath, {
    contentType: contentTypeFor(absPath),
    cacheControl: IMMUTABLE,
    allowRange: false,
    extraHeaders: { 'Cross-Origin-Resource-Policy': 'same-site' },
    onNotFound: () => {
      deps.logger.error('catalog 登记的媒体文件缺失', { slug, releaseId, fileName });
    },
  });
}
