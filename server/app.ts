import express, { type Express } from 'express';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { CatalogStore } from './catalog.js';
import { createApiRouter } from './routes/api.js';
import { createPlayMiddleware } from './routes/play.js';
import { createDownloadMiddleware } from './routes/download.js';
import { createMediaMiddleware } from './routes/media.js';
import { createSiteMiddleware } from './routes/site.js';
import { createAdminApiRouter, createAdminPageMiddleware } from './routes/admin.js';
import { SessionStore } from './admin/sessions.js';
import { StatsStore } from './stats.js';
import { notFoundHandler, sendJson } from './http.js';

export interface CreateAppOptions {
  config: AppConfig;
  logger: Logger;
  /** 允许测试注入自定义 store（例如独立临时数据目录）。 */
  store?: CatalogStore;
  /** 允许测试注入独立的埋点存储。 */
  stats?: StatsStore;
}

export interface CreatedApp {
  app: Express;
  store: CatalogStore;
}

export function createApp(options: CreateAppOptions): CreatedApp {
  const { config, logger } = options;
  const store = options.store ?? new CatalogStore(config.dataDir, logger);
  const sessions = new SessionStore();
  const stats = options.stats ?? new StatsStore(config.dataDir, logger);
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (logger && config.logLevel === 'debug') {
      logger.debug('request', { method: req.method, path: req.path });
    }
    next();
  });

  app.get('/healthz', async (_req, res, next) => {
    try {
      const catalog = await store.read();
      sendJson(res, 200, {
        status: 'ok',
        service: 'fennec-share',
        uptimeSeconds: Math.round(process.uptime()),
        catalogRevision: catalog.revision,
        projects: {
          total: catalog.projects.length,
          published: catalog.projects.filter((project) => project.published).length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/admin', createAdminApiRouter({ config, logger, sessions, stats }));
  app.use('/api', createApiRouter({ store, stats, logger }));

  app.use(
    createPlayMiddleware({
      dataDir: config.dataDir,
      store,
      logger,
    }),
  );

  app.use(
    createDownloadMiddleware({
      dataDir: config.dataDir,
      store,
      stats,
      logger,
    }),
  );

  app.use(
    createMediaMiddleware({
      dataDir: config.dataDir,
      store,
      logger,
    }),
  );

  app.use(createAdminPageMiddleware({ config }));

  app.use(createSiteMiddleware({ config, logger }));

  app.use(notFoundHandler);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('未处理的请求错误', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const text = JSON.stringify({ error: { code: 'internal_error', message: '服务器内部错误' } });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
  });

  return { app, store };
}
