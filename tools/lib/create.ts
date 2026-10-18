import { isValidSlug } from '../../shared/catalog.js';
import { CATEGORIES, type Category, type StoredProject } from '../../shared/types.js';
import { DEFAULT_DESCRIPTION, DEFAULT_SUMMARY } from './manifest.js';
import type { PublisherConfig } from '../../server/config.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile } from './catalog-io.js';
import { appendHistory } from './history.js';
import { commit } from './manage.js';
import { alignProjectTags } from './tags.js';
import { PublishError } from './errors.js';

export interface CreateProjectInput {
  slug: string;
  title: string;
  summary?: string;
  description?: string;
  categories: string[];
  tags?: string[];
  sortOrder?: number;
  displayVersion?: string | null;
  demo?: boolean;
  published?: boolean;
}

export interface CreateProjectResult {
  ok: true;
  slug: string;
  revision: number;
  project: StoredProject;
  message: string;
}

/**
 * 在管理页面里新建一个项目记录。
 *
 * 只建立元信息，不产生版本目录：试玩包、下载包、封面截图各自通过对应接口上传，
 * 每上传一次都会生成新的不可变版本目录。这样「先建档、再补料」和「一次传完」都成立。
 */
export async function createProject(config: PublisherConfig, input: CreateProjectInput): Promise<CreateProjectResult> {
  const slug = (input.slug ?? '').trim().toLowerCase();
  if (!isValidSlug(slug)) {
    throw new PublishError('invalid_request', 'slug 只能是小写字母、数字和连字符，最长 64 位（例如 my-tool）');
  }
  const title = (input.title ?? '').trim();
  if (title.length === 0) throw new PublishError('invalid_request', '标题不能为空');
  if (title.length > 120) throw new PublishError('invalid_request', '标题最多 120 个字符');

  const categories = [...new Set((input.categories ?? []).map((item) => item.trim()).filter(Boolean))];
  if (categories.length === 0) throw new PublishError('invalid_request', '至少选择一个类型');
  for (const category of categories) {
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      throw new PublishError('invalid_request', `未知类型：${category}`);
    }
  }

  const summary = (input.summary ?? '').trim();
  if (summary.length > 400) throw new PublishError('invalid_request', '简介最多 400 个字符');
  const description = (input.description ?? '').trim();
  if (description.length > 20000) throw new PublishError('invalid_request', '详细介绍最多 20000 个字符');

  const displayVersion = input.displayVersion === null || input.displayVersion === undefined
    ? null
    : String(input.displayVersion).trim() || null;
  if (displayVersion && displayVersion.length > 40) {
    throw new PublishError('invalid_request', '版本号最多 40 个字符');
  }

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `create ${slug}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const duplicated = catalog.projects.find((project) => project.slug.toLowerCase() === slug);
    if (duplicated) throw new PublishError('invalid_request', `项目已存在：${duplicated.slug}`);

    const tags = alignProjectTags(catalog, input.tags ?? []);
    const nowIso = new Date().toISOString();
    const project: StoredProject = {
      id: slug,
      slug,
      title,
      summary: summary.length > 0 ? summary : DEFAULT_SUMMARY,
      description: description.length > 0 ? description : DEFAULT_DESCRIPTION,
      categories: categories as Category[],
      tags,
      cover: null,
      screenshots: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      publishedAt: input.published === true ? nowIso : null,
      displayVersion,
      sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
      published: input.published === true,
      demo: input.demo === true,
      web: null,
      downloads: [],
      releaseHistory: [],
      lastFingerprint: null,
      unpublishReason: input.published === true ? null : '新建时未上架',
    };

    await appendHistory(config.dataDir, slug, 'create', project, null, nowIso);
    await commit(config.dataDir, catalog, project);

    return {
      ok: true,
      slug,
      revision: catalog.revision + 1,
      project,
      message: `已创建项目 ${slug}（catalog revision ${catalog.revision + 1}）。接下来可以上传试玩包、下载包和图片。`,
    };
  } finally {
    await lock.release();
  }
}
