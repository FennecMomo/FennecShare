import express, { Router } from 'express';
import { findProject, sortProjects, toPublicProject } from '../../shared/catalog.js';
import type { PublicCatalogResponse, PublicProjectView } from '../../shared/types.js';
import type { CatalogStore } from '../catalog.js';
import type { Logger } from '../logger.js';
import type { StatsStore } from '../stats.js';
import { sendApiError } from '../http.js';

interface ApiDeps {
  store: CatalogStore;
  stats: StatsStore;
  logger: Logger;
}

const BEACON_TYPES = new Set(['play_click', 'share_click']);

function clientIp(req: import('express').Request): string {
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === 'string' && value.trim().length > 0) return value.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store, stats, logger } = deps;
  const router = Router();

  router.get('/projects', async (_req, res, next) => {
    try {
      await stats.ready();
      const catalog = await store.read();
      const published = sortProjects(catalog.projects.filter((project) => project.published));
      const body: PublicCatalogResponse = {
        schemaVersion: catalog.schemaVersion,
        revision: catalog.revision,
        generatedAt: catalog.generatedAt,
        serverTime: new Date().toISOString(),
        tags: catalog.tags.map((tag) => tag.label),
        projects: published.map((project): PublicProjectView => ({
          ...toPublicProject(project),
          stats: stats.projectStats(project.slug),
        })),
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:slug', async (req, res, next) => {
    try {
      await stats.ready();
      const catalog = await store.read();
      const project = findProject(catalog, req.params.slug ?? '');
      if (!project || !project.published) {
        sendApiError(res, 404, 'project_not_found', '项目不存在或已下架');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...toPublicProject(project), stats: stats.projectStats(project.slug) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 埋点：只收「试玩点击」「分享点击」两种，其余类型一律丢弃。
   * 不落 IP、不写 cookie，只记事件、slug 和时间；同一 IP 每分钟限 120 次。
   */
  router.post('/stats/event', express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      const ip = clientIp(req);
      if (!stats.allow(ip)) {
        sendApiError(res, 429, 'too_many_events', '上报过于频繁');
        return;
      }
      const body = req.body as { type?: unknown; slug?: unknown; source?: unknown } | undefined;
      const type = typeof body?.type === 'string' ? body.type : '';
      const slug = typeof body?.slug === 'string' ? body.slug.slice(0, 64) : '';
      if (!BEACON_TYPES.has(type) || slug.length === 0) {
        sendApiError(res, 400, 'invalid_event', '不支持的事件类型');
        return;
      }
      await stats.ready();
      const catalog = await store.read();
      const project = findProject(catalog, slug);
      if (!project || !project.published) {
        // 项目不存在就不记，避免脏数据
        res.statusCode = 204;
        res.end();
        return;
      }
      stats.record({
        at: new Date().toISOString(),
        type: type as 'play_click' | 'share_click',
        slug,
        source: typeof body?.source === 'string' ? body.source.slice(0, 24) : undefined,
      });
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } catch (error) {
      logger.warn('埋点上报失败', { error: String(error) });
      next(error);
    }
  });

  return router;
}
