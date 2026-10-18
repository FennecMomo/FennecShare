import { Router } from 'express';
import { findProject, sortProjects, toPublicProject } from '../../shared/catalog.js';
import type { PublicCatalogResponse } from '../../shared/types.js';
import type { CatalogStore } from '../catalog.js';
import { sendApiError } from '../http.js';

export function createApiRouter(store: CatalogStore): Router {
  const router = Router();

  router.get('/projects', async (_req, res, next) => {
    try {
      const catalog = await store.read();
      const published = catalog.projects.filter((project) => project.published);
      const body: PublicCatalogResponse = {
        schemaVersion: catalog.schemaVersion,
        revision: catalog.revision,
        generatedAt: catalog.generatedAt,
        serverTime: new Date().toISOString(),
        projects: sortProjects(published).map(toPublicProject),
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:slug', async (req, res, next) => {
    try {
      const catalog = await store.read();
      const project = findProject(catalog, req.params.slug);
      if (!project || !project.published) {
        sendApiError(res, 404, 'project_not_found', '项目不存在或已下架');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(toPublicProject(project));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
