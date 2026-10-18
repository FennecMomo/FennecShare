import type { NextFunction, Request, Response } from 'express';
import { findProject } from '../../shared/catalog.js';
import type { PublicDownload, StoredProject } from '../../shared/types.js';
import type { CatalogStore } from '../catalog.js';
import {
  contentDispositionAttachment,
  resolveWithin,
  sendText,
  splitUrlPath,
  streamFile,
} from '../http.js';
import type { Logger } from '../logger.js';
import type { StatsStore } from '../stats.js';

interface DownloadDeps {
  stats: StatsStore;
  dataDir: string;
  store: CatalogStore;
  logger: Logger;
}

/**
 * 下载路由。
 *
 *   /download/<slug>/<fileName>  只允许下载 catalog 里登记过的文件
 *   /download/<slug>             有默认项时 302 到默认项；多个又没默认项时返回 409 + 选项
 *
 * 请求路径永远不会直接拼成磁盘路径：先查 catalog，再用 catalog 里的相对 storage 定位文件。
 */
export function createDownloadMiddleware(deps: DownloadDeps) {
  return async function downloadMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.path !== '/download' && !req.path.startsWith('/download/')) {
      next();
      return;
    }
    try {
      await handle(req, res, deps);
    } catch (error) {
      deps.logger.error('下载路由失败', { path: req.path, error: String(error) });
      if (!res.headersSent) sendText(res, 500, '下载失败');
      else res.destroy();
    }
  };
}

async function handle(req: Request, res: Response, deps: DownloadDeps): Promise<void> {
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
    serveShortcut(res, project);
    return;
  }

  if (segments.length !== 3) {
    sendText(res, 404, '下载地址格式不正确');
    return;
  }

  const requested = segments[2] ?? '';
  const download = project.downloads.find(
    (item) => item.fileName === requested || item.fileName.normalize('NFC') === requested.normalize('NFC'),
  );
  if (!download) {
    sendText(res, 404, '文件不存在或未登记');
    return;
  }

  const absPath = resolveWithin(deps.dataDir, download.storage);
  if (!absPath) {
    deps.logger.error('下载记录中的 storage 越界', { slug, fileName: download.fileName });
    sendText(res, 500, '下载配置异常');
    return;
  }

  // 埋点：只统计「真的开始下载」的请求（GET，且不是从中间续传的 Range）
  const range = req.headers.range;
  const isFullDownload = req.method === 'GET' && (typeof range !== 'string' || range.trim().startsWith('bytes=0-'));
  if (isFullDownload) {
    void deps.stats
      .ready()
      .then(() => {
        deps.stats.record({
          at: new Date().toISOString(),
          type: 'download',
          slug,
          platform: download.platform,
        });
      })
      .catch(() => undefined);
  }

  await streamFile(req, res, absPath, {
    contentType: download.contentType,
    cacheControl: 'public, max-age=3600',
    allowRange: true,
    extraHeaders: { 'Content-Disposition': contentDispositionAttachment(download.fileName) },
    onNotFound: () => {
      deps.logger.error('catalog 登记的文件在磁盘上不存在', { slug, fileName: download.fileName });
    },
  });
}

function serveShortcut(res: Response, project: StoredProject): void {
  const downloads = project.downloads;
  if (downloads.length === 0) {
    sendText(res, 404, '该项目没有可下载文件');
    return;
  }

  const defaultItem = downloads.find((item) => item.isDefault);
  if (defaultItem) {
    redirectTo(res, defaultItem.publicUrl);
    return;
  }

  if (downloads.length === 1) {
    const only = downloads[0];
    if (only) {
      redirectTo(res, only.publicUrl);
      return;
    }
  }

  // 多个文件又没有默认项：不随便挑一个，返回明确的 409 + 选项列表。
  const choices: Array<Pick<PublicDownload, 'fileName' | 'platform' | 'version' | 'size' | 'publicUrl'>> = downloads.map(
    (item) => ({
      fileName: item.fileName,
      platform: item.platform,
      version: item.version,
      size: item.size,
      publicUrl: item.publicUrl,
    }),
  );
  const body = {
    error: {
      code: 'multiple_download_choices',
      message: `该项目有 ${downloads.length} 个下载文件，没有默认项，请明确选择其中一个`,
    },
    downloads: choices,
  };
  const text = JSON.stringify(body);
  res.statusCode = 409;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function redirectTo(res: Response, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', '0');
  res.end();
}
