import fs from 'node:fs';
import { findProject, sortProjects, validateCatalog } from '../../shared/catalog.js';
import type { CatalogFile, StoredProject } from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { acquireDataLock } from './lock.js';
import { readCatalogFile, writeCatalogAtomic } from './catalog-io.js';
import { appendHistory, applySnapshot, listHistory, projectState } from './history.js';
import { PublishError } from './errors.js';
import { DEFAULT_SUMMARY } from './manifest.js';
import { alignProjectTags } from './tags.js';

export interface ListEntry {
  slug: string;
  title: string;
  published: boolean;
  demo: boolean;
  categories: string[];
  displayVersion: string | null;
  hasWeb: boolean;
  webEntry: string | null;
  webReleaseId: string | null;
  downloadCount: number;
  updatedAt: string;
  publishedAt: string | null;
}

export function buildList(catalog: CatalogFile): ListEntry[] {
  return sortProjects(catalog.projects).map((project) => ({
    slug: project.slug,
    title: project.title,
    published: project.published,
    demo: project.demo,
    categories: project.categories,
    displayVersion: project.displayVersion,
    hasWeb: project.web !== null,
    webEntry: project.web?.entry ?? null,
    webReleaseId: project.web?.releaseId ?? null,
    downloadCount: project.downloads.length,
    updatedAt: project.updatedAt,
    publishedAt: project.publishedAt,
  }));
}

export interface UnpublishResult {
  ok: true;
  status: 'unpublished' | 'unchanged';
  slug: string;
  catalogRevision: number;
  reason: string | null;
  filesRetained: boolean;
  message: string;
}

export async function unpublishProject(
  config: PublisherConfig,
  options: { slug: string; reason?: string },
): Promise<UnpublishResult> {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const lock = await acquireDataLock(config.dataDir, `unpublish ${options.slug}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, options.slug);
    if (!project) {
      throw new PublishError('project_not_found', `项目不存在：${options.slug}`);
    }
    if (!project.published) {
      return {
        ok: true,
        status: 'unchanged',
        slug: project.slug,
        catalogRevision: catalog.revision,
        reason: project.unpublishReason,
        filesRetained: true,
        message: `项目 ${project.slug} 已经是下架状态，无需重复操作。`,
      };
    }

    const nowIso = new Date().toISOString();
    const reason = options.reason?.trim() ? options.reason.trim() : '由发布工具下架';
    const updated: StoredProject = {
      ...project,
      published: false,
      unpublishReason: reason,
      updatedAt: nowIso,
    };
    await appendHistory(config.dataDir, updated.slug, 'unpublish', updated, null, nowIso);
    await commit(config.dataDir, catalog, updated);

    return {
      ok: true,
      status: 'unpublished',
      slug: updated.slug,
      catalogRevision: catalog.revision + 1,
      reason,
      filesRetained: true,
      message: `项目 ${updated.slug} 已下架：首页隐藏、/play 与 /download 返回 404；发布文件仍保留在数据目录中（未删除）。`,
    };
  } finally {
    await lock.release();
  }
}

export interface HistoryListItem {
  seq: number;
  action: string;
  at: string;
  releaseId: string | null;
  title: string;
  published: boolean;
  downloadCount: number;
}

export interface RollbackResult {
  ok: true;
  status: 'rolled_back' | 'unchanged' | 'listed';
  slug: string;
  catalogRevision: number;
  restored?: { seq: number; action: string; at: string; releaseId: string | null };
  history: HistoryListItem[];
  message: string;
}

export async function rollbackProject(
  config: PublisherConfig,
  options: { slug: string; to?: string; listOnly?: boolean },
): Promise<RollbackResult> {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const lock = await acquireDataLock(config.dataDir, `rollback ${options.slug}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, options.slug);
    if (!project) {
      throw new PublishError('project_not_found', `项目不存在：${options.slug}`);
    }

    const snapshots = await listHistory(config.dataDir, options.slug);
    const historyList = snapshots.map<HistoryListItem>((entry) => ({
      seq: entry.seq,
      action: entry.action,
      at: entry.at,
      releaseId: entry.releaseId,
      title: entry.state.title,
      published: entry.state.published,
      downloadCount: entry.state.downloads.length,
    }));

    if (options.listOnly) {
      return {
        ok: true,
        status: 'listed',
        slug: options.slug,
        catalogRevision: catalog.revision,
        history: historyList,
        message: `项目 ${options.slug} 共有 ${historyList.length} 个历史状态。回滚不加 --to 时默认回到上一个状态。`,
      };
    }

    if (snapshots.length === 0) {
      throw new PublishError('no_history', `项目 ${options.slug} 没有可回滚的历史状态。`);
    }

    let target: (typeof snapshots)[number] | undefined;
    if (options.to) {
      const wanted = options.to.trim();
      target = [...snapshots]
        .reverse()
        .find((entry) => entry.releaseId === wanted || String(entry.seq) === wanted || entry.file.includes(wanted));
      if (!target) {
        throw new PublishError(
          'invalid_target',
          `找不到目标状态：${wanted}。可用 --list 查看历史（seq 或 releaseId）。`,
        );
      }
    } else {
      target = snapshots[snapshots.length - 2];
      if (!target) {
        throw new PublishError('no_previous', `项目 ${options.slug} 只有一个历史状态，无法回滚到“上一个”。`);
      }
    }

    const nowIso = new Date().toISOString();
    const currentState = JSON.stringify(projectState(project));
    if (currentState === JSON.stringify(target.state)) {
      return {
        ok: true,
        status: 'unchanged',
        slug: options.slug,
        catalogRevision: catalog.revision,
        restored: { seq: target.seq, action: target.action, at: target.at, releaseId: target.releaseId },
        history: historyList,
        message: `项目 ${options.slug} 当前状态已经与目标状态一致，无需回滚。`,
      };
    }

    const restored = applySnapshot(project, target.state, nowIso);
    const withHistory: StoredProject = { ...restored, releaseHistory: project.releaseHistory, id: project.id };
    await appendHistory(config.dataDir, withHistory.slug, 'rollback', withHistory, target.releaseId, nowIso);
    await commit(config.dataDir, catalog, withHistory);

    return {
      ok: true,
      status: 'rolled_back',
      slug: options.slug,
      catalogRevision: catalog.revision + 1,
      restored: { seq: target.seq, action: target.action, at: target.at, releaseId: target.releaseId },
      history: historyList,
      message: `项目 ${options.slug} 已回滚到状态 #${target.seq}（${target.action}，${target.at}）。文件未删除，可再次回滚。`,
    };
  } finally {
    await lock.release();
  }
}

export interface ProjectMetaPatch {
  title?: string;
  summary?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  displayVersion?: string | null;
  sortOrder?: number;
  demo?: boolean;
  published?: boolean;
}

export interface MetaUpdateResult {
  ok: true;
  slug: string;
  catalogRevision: number;
  project: StoredProject;
  message: string;
}

const ALLOWED_CATEGORIES = new Set(['web', 'desktop', 'mobile']);

/** 管理页面用：只改元信息，不产生新版本目录（图片改了才需要新版本）。 */
export async function updateProjectMeta(
  config: PublisherConfig,
  slug: string,
  patch: ProjectMetaPatch,
): Promise<MetaUpdateResult> {
  const lock = await acquireDataLock(config.dataDir, `meta ${slug}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);

    const nowIso = new Date().toISOString();
    const next: StoredProject = { ...project };

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0 || title.length > 120) throw new PublishError('invalid_request', '标题需为 1–120 个字符');
      next.title = title;
    }
    if (patch.summary !== undefined) {
      const summary = patch.summary.trim();
      if (summary.length > 400) throw new PublishError('invalid_request', '简介最多 400 个字符');
      next.summary = summary.length > 0 ? summary : DEFAULT_SUMMARY;
    }
    if (patch.description !== undefined) {
      const description = patch.description.trim();
      if (description.length > 20000) throw new PublishError('invalid_request', '详细介绍最多 20000 个字符');
      next.description = description;
    }
    if (patch.categories !== undefined) {
      const categories = [...new Set(patch.categories.map((item) => item.trim()).filter(Boolean))];
      if (categories.length === 0) throw new PublishError('invalid_request', '至少选择一个类型');
      const unknown = categories.find((item) => !ALLOWED_CATEGORIES.has(item));
      if (unknown) throw new PublishError('invalid_request', `未知类型：${unknown}`);
      next.categories = categories as StoredProject['categories'];
    }
    if (patch.tags !== undefined) {
      next.tags = alignProjectTags(catalog, patch.tags);
    }
    if (patch.displayVersion !== undefined) {
      const version = patch.displayVersion === null ? '' : patch.displayVersion.trim();
      if (version.length > 40) throw new PublishError('invalid_request', '版本号最多 40 个字符');
      next.displayVersion = version.length > 0 ? version : null;
    }
    if (patch.sortOrder !== undefined) {
      if (!Number.isInteger(patch.sortOrder) || patch.sortOrder < -100000 || patch.sortOrder > 100000) {
        throw new PublishError('invalid_request', '排序值必须是 -100000 到 100000 之间的整数');
      }
      next.sortOrder = patch.sortOrder;
    }
    if (patch.demo !== undefined) next.demo = patch.demo;
    if (patch.published !== undefined) {
      next.published = patch.published;
      next.unpublishReason = patch.published ? null : '在管理页面下架';
      if (patch.published && !project.published) next.publishedAt = nowIso;
    }

    const changed =
      next.title !== project.title ||
      next.summary !== project.summary ||
      next.description !== project.description ||
      next.categories.join(',') !== project.categories.join(',') ||
      next.tags.join(',') !== (project.tags ?? []).join(',') ||
      next.displayVersion !== project.displayVersion ||
      next.sortOrder !== project.sortOrder ||
      next.demo !== project.demo ||
      next.published !== project.published ||
      next.unpublishReason !== project.unpublishReason;

    if (!changed) {
      return {
        ok: true,
        slug,
        catalogRevision: catalog.revision,
        project,
        message: `项目 ${slug} 没有需要保存的改动。`,
      };
    }

    next.updatedAt = nowIso;
    const releaseId = project.web?.releaseId ?? project.downloads[0]?.releaseId ?? project.cover?.releaseId ?? null;
    await appendHistory(config.dataDir, slug, 'meta', next, releaseId, nowIso);
    await commit(config.dataDir, catalog, next);

    return {
      ok: true,
      slug,
      catalogRevision: catalog.revision + 1,
      project: next,
      message: `项目 ${slug} 的信息已保存（catalog revision ${catalog.revision + 1}）。`,
    };
  } finally {
    await lock.release();
  }
}

export async function commit(dataDir: string, catalog: CatalogFile, project: StoredProject): Promise<void> {
  const projects = catalog.projects.filter((item) => item.slug !== project.slug);
  projects.push(project);
  projects.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const nextCatalog: CatalogFile = {
    ...catalog,
    revision: catalog.revision + 1,
    generatedAt: new Date().toISOString(),
    projects,
  };
  const validated = validateCatalog(nextCatalog);
  if (!validated.ok) {
    throw new PublishError(
      'invalid_catalog',
      `生成的 catalog 未通过校验：${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')}`,
    );
  }
  await writeCatalogAtomic(dataDir, validated.catalog);
}
