import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import path from 'node:path';
import type { AppConfig, PublisherConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { sendJson, sendText, streamFile } from '../http.js';
import { checkPasswordPolicy, readAuth, verifyPassword, writeAuth } from '../admin/auth.js';
import {
  ADMIN_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  clearSessionCookie,
  readCookie,
  setSessionCookie,
} from '../admin/sessions.js';
import { readCatalogFile } from '../../tools/lib/catalog-io.js';
import { isPublishError } from '../../tools/lib/errors.js';
import { updateProjectMeta, type ProjectMetaPatch } from '../../tools/lib/manage.js';
import { MAX_MEDIA_BYTES, updateProjectMedia } from '../../tools/lib/media.js';
import { createProject } from '../../tools/lib/create.js';
import { addTag, removeTag, tagOverview } from '../../tools/lib/tags.js';
import { clearProjectWeb, updateProjectWeb } from '../../tools/lib/web.js';
import { removeProjectDownload, upsertProjectDownload } from '../../tools/lib/downloads.js';
import { loadLimits } from '../../tools/lib/manifest.js';
import { PLATFORMS, type Platform } from '../../shared/types.js';
import type { StatsStore } from '../stats.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const ADMIN_CSRF_HEADER = 'x-fennec-admin';
const MAX_ALT_LENGTH = 200;

interface AdminDeps {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  stats: StatsStore;
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

function clientIp(req: Request): string {
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === 'string' && value.trim().length > 0) return value.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** 只允许同源请求：浏览器跨站发起的写操作会被挡掉（配合 SameSite=Strict 双重保险）。 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function requireJson(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function createAdminApiRouter(deps: AdminDeps): Router {
  const router = express.Router();
  const attempts = new Map<string, LoginAttempt>();

  router.use(requireJson);
  router.use(express.json({ limit: '256kb' }));

  router.use((req, res, next) => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: { code: 'bad_origin', message: '请求来源不合法' } });
      return;
    }
    if (req.method !== 'GET' && req.get(ADMIN_CSRF_HEADER) !== '1') {
      sendJson(res, 403, { error: { code: 'missing_header', message: '缺少管理请求标记' } });
      return;
    }
    next();
  });

  const currentToken = (req: Request): string | null => {
    const token = readCookie(req, ADMIN_COOKIE);
    return token && deps.sessions.verify(token) !== null ? token : null;
  };

  const requireSession = (req: Request, res: Response): string | null => {
    const token = currentToken(req);
    if (!token) {
      sendJson(res, 401, { error: { code: 'unauthorized', message: '登录已过期，请重新登录' } });
      return null;
    }
    return token;
  };

  router.get('/session', async (req, res, next) => {
    try {
      const auth = await readAuth(deps.config.dataDir);
      sendJson(res, 200, {
        authenticated: currentToken(req) !== null,
        passwordConfigured: auth !== null,
        passwordUpdatedAt: auth?.updatedAt ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const ip = clientIp(req);
      const now = Date.now();
      const record = attempts.get(ip);
      if (record && record.resetAt > now && record.failures >= LOGIN_MAX_FAILURES) {
        const retryAfter = Math.ceil((record.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        sendJson(res, 429, {
          error: { code: 'too_many_attempts', message: `尝试次数过多，请 ${retryAfter} 秒后再试` },
        });
        return;
      }

      const auth = await readAuth(deps.config.dataDir);
      if (!auth) {
        sendJson(res, 503, {
          error: { code: 'password_not_configured', message: '管理密码尚未设置，请先运行 admin 密码命令' },
        });
        return;
      }

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const ok = password.length > 0 && (await verifyPassword(auth, password));
      if (!ok) {
        const entry = record && record.resetAt > now ? record : { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
        entry.failures += 1;
        attempts.set(ip, entry);
        deps.logger.warn('管理页面登录失败', { ip, failures: entry.failures });
        sendJson(res, 401, { error: { code: 'invalid_password', message: '密码不正确' } });
        return;
      }

      attempts.delete(ip);
      const session = deps.sessions.create();
      setSessionCookie(req, res, session.token, SESSION_TTL_MS);
      deps.logger.info('管理页面登录成功', { ip });
      sendJson(res, 200, { ok: true, expiresAt: new Date(session.expiresAt).toISOString() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', (req, res) => {
    deps.sessions.destroy(readCookie(req, ADMIN_COOKIE));
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
  });

  router.post('/password', async (req, res, next) => {
    try {
      const token = requireSession(req, res);
      if (!token) return;
      const auth = await readAuth(deps.config.dataDir);
      if (!auth) {
        sendJson(res, 503, { error: { code: 'password_not_configured', message: '管理密码尚未设置' } });
        return;
      }
      const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const nextPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (!(await verifyPassword(auth, current))) {
        sendJson(res, 401, { error: { code: 'invalid_password', message: '当前密码不正确' } });
        return;
      }
      const problem = checkPasswordPolicy(nextPassword);
      if (problem) {
        sendJson(res, 400, { error: { code: 'weak_password', message: problem } });
        return;
      }
      if (nextPassword === current) {
        sendJson(res, 400, { error: { code: 'same_password', message: '新密码不能和当前密码相同' } });
        return;
      }
      const updated = await writeAuth(deps.config.dataDir, nextPassword);
      const kicked = deps.sessions.destroyAllExcept(token);
      deps.logger.warn('管理密码已修改', { kickedSessions: kicked });
      sendJson(res, 200, { ok: true, updatedAt: updated.updatedAt, kickedSessions: kicked });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const catalog = await readCatalogFile(deps.config.dataDir);
      const projects = catalog.projects
        .slice()
        .sort((a, b) => b.sortOrder - a.sortOrder || a.slug.localeCompare(b.slug))
        .map((project) => ({
          slug: project.slug,
          title: project.title,
          summary: project.summary,
          description: project.description,
          categories: project.categories,
          tags: project.tags,
          demo: project.demo,
          sortOrder: project.sortOrder,
          displayVersion: project.displayVersion,
          published: project.published,
          unpublishReason: project.unpublishReason,
          publishedAt: project.publishedAt,
          updatedAt: project.updatedAt,
          cover: project.cover,
          screenshots: project.screenshots,
          web: project.web,
          downloads: project.downloads.map((download) => ({
            fileName: download.fileName,
            platform: download.platform,
            version: download.version,
            size: download.size,
            publicUrl: download.publicUrl,
          })),
          releaseCount: project.releaseHistory.length,
        }));
      sendJson(res, 200, { revision: catalog.revision, generatedAt: catalog.generatedAt, projects });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/projects/:slug', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const body = req.body ?? {};
      const patch: ProjectMetaPatch = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.summary === 'string') patch.summary = body.summary;
      if (typeof body.description === 'string') patch.description = body.description;
      if (Array.isArray(body.categories)) {
        patch.categories = body.categories.filter((item: unknown): item is string => typeof item === 'string');
      }
      if (Array.isArray(body.tags)) {
        patch.tags = body.tags.filter((item: unknown): item is string => typeof item === 'string');
      }
      if (body.displayVersion === null || typeof body.displayVersion === 'string') {
        patch.displayVersion = body.displayVersion;
      }
      if (typeof body.sortOrder === 'number') patch.sortOrder = body.sortOrder;
      if (typeof body.demo === 'boolean') patch.demo = body.demo;
      if (typeof body.published === 'boolean') patch.published = body.published;

      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { error: { code: 'empty_patch', message: '没有需要保存的字段' } });
        return;
      }

      const result = await updateProjectMeta(
        { dataDir: deps.config.dataDir, publicBaseUrl: deps.config.publicBaseUrl, logLevel: deps.config.logLevel },
        req.params.slug ?? '',
        patch,
      );
      deps.logger.info('管理页面更新项目信息', { slug: result.slug, revision: result.catalogRevision });
      sendJson(res, 200, {
        ok: true,
        message: result.message,
        revision: result.catalogRevision,
        project: {
          slug: result.project.slug,
          title: result.project.title,
          published: result.project.published,
          updatedAt: result.project.updatedAt,
        },
      });
    } catch (error) {
      if (isPublishError(error)) {
        sendJson(res, error.code === 'project_not_found' ? 404 : 400, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      next(error);
    }
  });

  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg', 'image/webp'],
    limit: MAX_MEDIA_BYTES,
  });

  const takeUpload = (req: Request, res: Response): { buffer: Buffer; alt: string | null } | null => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      sendJson(res, 400, {
        error: { code: 'invalid_upload', message: '请以 image/png、image/jpeg 或 image/webp 上传图片内容' },
      });
      return null;
    }
    const altQuery = typeof req.query.alt === 'string' ? req.query.alt.trim() : '';
    if (altQuery.length > MAX_ALT_LENGTH) {
      sendJson(res, 400, { error: { code: 'invalid_upload', message: `图片描述最多 ${MAX_ALT_LENGTH} 个字符` } });
      return null;
    }
    return { buffer: req.body, alt: altQuery.length > 0 ? altQuery : null };
  };

  const runMediaUpdate = async (
    res: Response,
    slug: string,
    change: Parameters<typeof updateProjectMedia>[2],
  ): Promise<void> => {
    const result = await updateProjectMedia(
      { dataDir: deps.config.dataDir, publicBaseUrl: deps.config.publicBaseUrl, logLevel: deps.config.logLevel },
      slug,
      change,
    );
    deps.logger.info('管理页面更新项目图片', { slug, releaseId: result.releaseId });
    sendJson(res, 200, {
      ok: true,
      message: result.message,
      releaseId: result.releaseId,
      revision: result.catalogRevision,
      cover: result.cover,
      screenshots: result.screenshots,
    });
  };

  router.put('/projects/:slug/cover', rawImage, async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const upload = takeUpload(req, res);
      if (!upload) return;
      await runMediaUpdate(res, req.params.slug ?? '', { cover: upload });
    } catch (error) {
      if (handleMediaError(error, res)) return;
      next(error);
    }
  });

  router.delete('/projects/:slug/cover', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      await runMediaUpdate(res, req.params.slug ?? '', { cover: null });
    } catch (error) {
      if (handleMediaError(error, res)) return;
      next(error);
    }
  });

  router.post('/projects/:slug/screenshots', rawImage, async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const upload = takeUpload(req, res);
      if (!upload) return;
      await runMediaUpdate(res, req.params.slug ?? '', { addScreenshots: [upload] });
    } catch (error) {
      if (handleMediaError(error, res)) return;
      next(error);
    }
  });

  router.delete('/projects/:slug/screenshots/:index', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        sendJson(res, 400, { error: { code: 'invalid_request', message: '截图序号不合法' } });
        return;
      }
      await runMediaUpdate(res, req.params.slug ?? '', { removeScreenshots: [index] });
    } catch (error) {
      if (handleMediaError(error, res)) return;
      next(error);
    }
  });

  // ---------- 标签 ----------
  router.get('/tags', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const overview = await tagOverview(engineConfig(deps));
      sendJson(res, 200, overview);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tags', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const label = typeof req.body?.label === 'string' ? req.body.label : '';
      const result = await addTag(engineConfig(deps), label);
      deps.logger.info('管理页面新增标签', { label: result.tag.label, revision: result.revision });
      sendJson(res, 200, { ok: true, revision: result.revision, tag: result.tag });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  router.delete('/tags/:label', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const label = decodeURIComponent(req.params.label ?? '');
      const result = await removeTag(engineConfig(deps), label);
      deps.logger.info('管理页面删除标签', { label: result.removed, affected: result.affectedProjects.length });
      sendJson(res, 200, { ok: true, revision: result.revision, removed: result.removed, affectedProjects: result.affectedProjects });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  // ---------- 新建项目 ----------
  router.post('/projects', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const body = req.body ?? {};
      const result = await createProject(engineConfig(deps), {
        slug: typeof body.slug === 'string' ? body.slug : '',
        title: typeof body.title === 'string' ? body.title : '',
        summary: typeof body.summary === 'string' ? body.summary : '',
        description: typeof body.description === 'string' ? body.description : '',
        categories: Array.isArray(body.categories) ? body.categories.filter((item: unknown): item is string => typeof item === 'string') : [],
        tags: Array.isArray(body.tags) ? body.tags.filter((item: unknown): item is string => typeof item === 'string') : [],
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        displayVersion: typeof body.displayVersion === 'string' ? body.displayVersion : null,
        demo: body.demo === true,
        published: body.published !== false,
      });
      deps.logger.info('管理页面新建项目', { slug: result.slug, revision: result.revision });
      sendJson(res, 201, { ok: true, message: result.message, revision: result.revision, slug: result.slug });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  // ---------- 发布新版本：试玩包 ----------
  const rawWeb = express.raw({
    type: ['application/zip', 'application/x-zip-compressed', 'text/html', 'application/octet-stream'],
    limit: loadLimits().maxZipBytes,
  });

  router.put('/projects/:slug/web', rawWeb, async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        sendJson(res, 400, {
          error: { code: 'invalid_upload', message: '请上传 .html 文件或 ZIP 包（Content-Type: application/zip / text/html）' },
        });
        return;
      }
      const fileName = decodeHeaderName(req.get('x-file-name')) ?? 'index.html';
      const result = await updateProjectWeb(engineConfig(deps), req.params.slug ?? '', {
        fileName,
        buffer: req.body,
      });
      deps.logger.info('管理页面发布试玩包', { slug: result.slug, releaseId: result.releaseId, entry: result.entry });
      sendJson(res, 200, {
        ok: true,
        message: result.message,
        releaseId: result.releaseId,
        entry: result.entry,
        revision: result.revision,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        warnings: result.warnings,
      });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  router.delete('/projects/:slug/web', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const result = await clearProjectWeb(engineConfig(deps), req.params.slug ?? '');
      sendJson(res, 200, { ok: true, revision: result.revision, message: '试玩包已移除' });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  // ---------- 发布新版本：下载包 ----------
  const rawDownload = express.raw({ type: () => true, limit: loadLimits().maxDownloadBytes });

  router.post('/projects/:slug/downloads', rawDownload, async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_upload', message: '上传内容为空' } });
        return;
      }
      const fileName = decodeHeaderName(req.get('x-file-name'));
      if (!fileName) {
        sendJson(res, 400, { error: { code: 'invalid_upload', message: '缺少 x-file-name 头（文件名）' } });
        return;
      }
      const platformRaw = (req.get('x-platform') ?? 'other').trim();
      const platform = (PLATFORMS as readonly string[]).includes(platformRaw) ? (platformRaw as Platform) : 'other';
      const result = await upsertProjectDownload(engineConfig(deps), req.params.slug ?? '', {
        fileName,
        buffer: req.body,
        platform,
        version: decodeHeaderName(req.get('x-version')),
        isDefault: req.get('x-default') === '1',
      });
      deps.logger.info('管理页面上传下载包', { slug: result.slug, fileName, releaseId: result.releaseId });
      sendJson(res, 200, {
        ok: true,
        message: result.message,
        replaced: result.replaced,
        releaseId: result.releaseId,
        revision: result.revision,
        download: result.download,
      });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  router.delete('/projects/:slug/downloads/:fileName', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const fileName = decodeURIComponent(req.params.fileName ?? '');
      const result = await removeProjectDownload(engineConfig(deps), req.params.slug ?? '', fileName);
      sendJson(res, 200, { ok: true, revision: result.revision, removed: result.removed });
    } catch (error) {
      if (handleAdminError(error, res)) return;
      next(error);
    }
  });

  // ---------- 数据分析 ----------
  router.get('/stats', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      await deps.stats.ready();
      const days = Number(req.query.days);
      const summary = deps.stats.summary(Number.isFinite(days) ? days : 14);
      const catalog = await readCatalogFile(deps.config.dataDir);
      const titles = Object.fromEntries(catalog.projects.map((project) => [project.slug, project.title]));
      sendJson(res, 200, { ...summary, titles });
    } catch (error) {
      next(error);
    }
  });

  // JSON 解析失败等由 Express 抛出的错误，统一回成 JSON
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null;
    if (status === 413) {
      sendJson(res, 413, { error: { code: 'too_large', message: '上传内容超过大小上限' } });
      return;
    }
    if (status === 400) {
      sendJson(res, 400, { error: { code: 'bad_request', message: '请求内容格式不正确' } });
      return;
    }
    next(error);
  });

  return router;
}

function engineConfig(deps: AdminDeps): PublisherConfig {
  return { dataDir: deps.config.dataDir, publicBaseUrl: deps.config.publicBaseUrl, logLevel: deps.config.logLevel };
}

/** 头部里的文件名/版本号用百分号编码传，避免中文与空格在 HTTP 头里出问题。 */
function decodeHeaderName(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw).trim();
    return value.length > 0 ? value : null;
  } catch {
    return raw.trim() || null;
  }
}

function handleAdminError(error: unknown, res: Response): boolean {
  if (!isPublishError(error)) return false;
  const status = error.code === 'project_not_found' ? 404 : error.code === 'invalid_upload' ? 415 : 400;
  sendJson(res, status, { error: { code: error.code, message: error.message } });
  return true;
}

function handleMediaError(error: unknown, res: Response): boolean {
  if (!isPublishError(error)) return false;
  const status = error.code === 'project_not_found' ? 404 : error.code === 'invalid_upload' ? 415 : 400;
  sendJson(res, status, { error: { code: error.code, message: error.message } });
  return true;
}

/** /admin 及其子路径下发 admin.html；其它请求交给后面的中间件。 */
export function createAdminPageMiddleware(deps: { config: AppConfig }): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const isAdminPath = req.path === '/admin' || req.path === '/admin/' || req.path === '/admin.html' ||
      req.path.startsWith('/admin/');
    if (!isAdminPath) {
      next();
      return;
    }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    const target = path.join(deps.config.webDistDir, 'admin.html');
    await streamFile(req, res, target, {
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      allowRange: false,
      onNotFound: () => {
        sendText(res, 500, '管理页面尚未构建，请先执行 npm run build');
      },
    });
  };
}
