import { normalizeTagLabel, validateCatalog } from '../../shared/catalog.js';
import { TAG_MAX_COUNT, TAG_MAX_LENGTH, type CatalogFile, type TagRecord } from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile, writeCatalogAtomic } from './catalog-io.js';
import { PublishError } from './errors.js';

/** 只改标签（不涉及项目状态），单独提交，revision +1。 */
async function commitTags(dataDir: string, catalog: CatalogFile): Promise<CatalogFile> {
  const next: CatalogFile = { ...catalog, revision: catalog.revision + 1, generatedAt: new Date().toISOString() };
  const validated = validateCatalog(next);
  if (!validated.ok) {
    throw new PublishError(
      'invalid_catalog',
      `生成的 catalog 未通过校验：${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')}`,
    );
  }
  await writeCatalogAtomic(dataDir, validated.catalog);
  return validated.catalog;
}

export interface TagListResult {
  ok: true;
  revision: number;
  tags: Array<TagRecord & { projectCount: number }>;
}

export async function listTags(config: PublisherConfig): Promise<{ tags: string[]; revision: number }> {
  const catalog = await readCatalogFile(config.dataDir);
  return { tags: catalog.tags.map((tag) => tag.label), revision: catalog.revision };
}

export async function addTag(config: PublisherConfig, rawLabel: string): Promise<{ revision: number; tag: TagRecord }> {
  const label = normalizeTagLabel(rawLabel);
  if (label.length === 0) throw new PublishError('invalid_request', '标签不能为空');
  if (label.length > TAG_MAX_LENGTH) throw new PublishError('invalid_request', `标签最多 ${TAG_MAX_LENGTH} 个字符`);

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `tag-add ${label}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const existing = catalog.tags.find((tag) => tag.label.toLowerCase() === label.toLowerCase());
    if (existing) return { revision: catalog.revision, tag: existing };
    if (catalog.tags.length >= TAG_MAX_COUNT) {
      throw new PublishError('invalid_request', `标签最多 ${TAG_MAX_COUNT} 个，请先删掉不用的`);
    }
    const tag: TagRecord = { label, createdAt: new Date().toISOString() };
    const updated = await commitTags(config.dataDir, { ...catalog, tags: [...catalog.tags, tag] });
    return { revision: updated.revision, tag };
  } finally {
    await lock.release();
  }
}

export interface RemoveTagResult {
  revision: number;
  removed: string;
  /** 被顺带清掉该标签的项目 slug。 */
  affectedProjects: string[];
}

export async function removeTag(config: PublisherConfig, rawLabel: string): Promise<RemoveTagResult> {
  const label = normalizeTagLabel(rawLabel);
  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `tag-remove ${label}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const target = catalog.tags.find((tag) => tag.label.toLowerCase() === label.toLowerCase());
    if (!target) throw new PublishError('invalid_request', `标签不存在：${label}`);

    const nowIso = new Date().toISOString();
    const affected: string[] = [];
    const projects = catalog.projects.map((project) => {
      const kept = project.tags.filter((tag) => tag.toLowerCase() !== target.label.toLowerCase());
      if (kept.length === project.tags.length) return project;
      affected.push(project.slug);
      return { ...project, tags: kept, updatedAt: nowIso };
    });

    const updated = await commitTags(config.dataDir, {
      ...catalog,
      tags: catalog.tags.filter((tag) => tag.label !== target.label),
      projects,
    });
    return { revision: updated.revision, removed: target.label, affectedProjects: affected };
  } finally {
    await lock.release();
  }
}

/** 把项目标签对齐到登记表里的写法（大小写/空格差异统一），未登记的标签报错。 */
export function alignProjectTags(catalog: CatalogFile, rawTags: string[]): string[] {
  const byLower = new Map(catalog.tags.map((tag) => [tag.label.toLowerCase(), tag.label]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const label = normalizeTagLabel(raw);
    if (label.length === 0) continue;
    const canonical = byLower.get(label.toLowerCase());
    if (!canonical) throw new PublishError('invalid_request', `标签还没登记：${label}`);
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    result.push(canonical);
  }
  if (result.length > TAG_MAX_COUNT) throw new PublishError('invalid_request', `最多 ${TAG_MAX_COUNT} 个标签`);
  return result;
}

/** 管理页面用：给标签算上项目数。 */
export async function tagOverview(config: PublisherConfig): Promise<TagListResult> {
  const catalog = await readCatalogFile(config.dataDir);
  const counts = new Map<string, number>();
  for (const project of catalog.projects) {
    for (const tag of project.tags) counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) ?? 0) + 1);
  }
  return {
    ok: true,
    revision: catalog.revision,
    tags: catalog.tags.map((tag) => ({ ...tag, projectCount: counts.get(tag.label.toLowerCase()) ?? 0 })),
  };
}

/** 顺手给管理页面用：列出某个标签绑了哪些项目。 */
export async function projectsWithTag(config: PublisherConfig, rawLabel: string): Promise<string[]> {
  const catalog = await readCatalogFile(config.dataDir);
  const label = normalizeTagLabel(rawLabel).toLowerCase();
  return catalog.projects.filter((project) => project.tags.some((tag) => tag.toLowerCase() === label)).map((p) => p.slug);
}
