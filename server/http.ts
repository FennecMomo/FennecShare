import fs from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { resolveWithin } from '../shared/paths.js';
import type { ApiError } from '../shared/types.js';

export { resolveWithin };

export function sendJson(res: Response, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

export function sendApiError(res: Response, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  sendJson(res, status, body);
}

export function sendText(res: Response, status: number, text: string, extraHeaders?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

/**
 * 生成 RFC 6266 / RFC 5987 兼容的 Content-Disposition。
 * 中文名、空格、引号都能正确处理：ASCII 回退名 + filename*=UTF-8'' 编码名。
 */
export function contentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '_');
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*!~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'ignore' }
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * 解析单段 Range。
 * - 没有 Range：none
 * - 语法无效或不是 bytes 单位或多段：ignore（按 RFC 7233 忽略，返回完整内容）
 * - 语法合法但越界：unsatisfiable（416）
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!match) return { kind: 'ignore' };
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return { kind: 'ignore' };

  if (startRaw === '') {
    // 后缀范围：bytes=-N 表示最后 N 字节
    const suffixLength = Number(endRaw);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffixLength);
    return { kind: 'satisfiable', start, end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: 'ignore' };
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isSafeInteger(end) || end < 0) return { kind: 'ignore' };
  if (start >= size) return { kind: 'unsatisfiable' };
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'satisfiable', start, end: Math.min(end, size - 1) };
}

/** 解析 URL 路径为已解码的段；非法百分号编码返回 null。 */
export function splitUrlPath(rawPath: string): string[] | null {
  const segments: string[] = [];
  for (const rawSegment of rawPath.split('/')) {
    if (rawSegment === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
    if (decoded === '.' || decoded === '..') return null;
    segments.push(decoded);
  }
  return segments;
}

export interface StreamFileOptions {
  contentType: string;
  cacheControl: string;
  allowRange: boolean;
  extraHeaders?: Record<string, string>;
  onNotFound?: () => void;
}

/**
 * 流式返回一个文件，支持 HEAD / Range / ETag 304。
 * 不暴露绝对路径：错误响应里只有对外文件名或固定文案。
 */
export async function streamFile(req: Request, res: Response, absPath: string, options: StreamFileOptions): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    options.onNotFound?.();
    sendText(res, 404, '文件不存在');
    return;
  }
  if (!stat.isFile()) {
    sendText(res, 404, '文件不存在');
    return;
  }

  const size = stat.size;
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', options.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', options.cacheControl);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
  if (options.allowRange) res.setHeader('Accept-Ranges', 'bytes');
  if (options.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) res.setHeader(key, value);
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.statusCode = 304;
    res.removeHeader('Content-Length');
    res.end();
    return;
  }

  let start = 0;
  let end = size - 1;
  let statusCode = 200;

  if (options.allowRange) {
    const range = parseRange(req.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.removeHeader('Cache-Control');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    if (range.kind === 'satisfiable') {
      start = range.start;
      end = range.end;
      statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
  }

  const length = size === 0 ? 0 : end - start + 1;
  res.statusCode = statusCode;
  res.setHeader('Content-Length', String(length));

  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(absPath, { start, end });
    stream.on('error', (error) => {
      res.destroy(error instanceof Error ? error : undefined);
      resolve();
    });
    stream.on('end', () => resolve());
    stream.pipe(res);
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
  });
}

/** 未匹配到任何路由时的兜底。 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  if (req.path.startsWith('/api/')) {
    sendApiError(res, 404, 'not_found', '接口不存在');
    return;
  }
  sendText(res, 404, '页面不存在');
}
