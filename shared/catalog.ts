/**
 * catalog 的纯函数工具：排序、公开投影、结构校验。
 * 服务端和发布 CLI 共用同一份实现，避免两边规则漂移。
 */
import {
  CATALOG_SCHEMA_VERSION,
  CATEGORIES,
  PLATFORMS,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  type CatalogFile,
  type Category,
  type Platform,
  type PublicProject,
  type StoredProject,
} from './types.js';

export function createEmptyCatalog(now = new Date()): CatalogFile {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    revision: 0,
    generatedAt: now.toISOString(),
    tags: [],
    projects: [],
  };
}

/**
 * 排序规则（全部在服务端完成，前端只按返回顺序渲染）：
 * 1. sortOrder 大的在前（显式权重优先）；
 * 2. 最近发布时间倒序，没有发布时间用 updatedAt；
 * 3. slug 升序，保证同分时顺序稳定。
 */
export function sortProjects<T extends Pick<StoredProject, 'slug' | 'sortOrder' | 'publishedAt' | 'updatedAt'>>(
  projects: readonly T[],
): T[] {
  return [...projects].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return b.sortOrder - a.sortOrder;
    const at = Date.parse(a.publishedAt ?? a.updatedAt);
    const bt = Date.parse(b.publishedAt ?? b.updatedAt);
    const aTime = Number.isFinite(at) ? at : 0;
    const bTime = Number.isFinite(bt) ? bt : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

export function toPublicProject(project: StoredProject): PublicProject {
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    summary: project.summary,
    description: project.description,
    categories: project.categories,
    tags: project.tags ?? [],
    cover: project.cover,
    screenshots: project.screenshots,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    publishedAt: project.publishedAt,
    displayVersion: project.displayVersion,
    sortOrder: project.sortOrder,
    published: project.published,
    demo: project.demo,
    web: project.web,
    downloads: project.downloads.map((download) => ({
      id: download.id,
      fileName: download.fileName,
      platform: download.platform,
      version: download.version,
      size: download.size,
      sha256: download.sha256,
      contentType: download.contentType,
      publicUrl: download.publicUrl,
      releaseId: download.releaseId,
      isDefault: download.isDefault,
    })),
  };
}

export function findProject(catalog: CatalogFile, slug: string): StoredProject | undefined {
  return catalog.projects.find((project) => project.slug === slug);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/**
 * 兼容旧数据：tags 是后加的字段，旧 catalog 里没有。
 * 校验通过后统一补齐，读的人和写的人都不用再判空。
 */
export function normalizeCatalog(catalog: CatalogFile): CatalogFile {
  return {
    ...catalog,
    tags: Array.isArray(catalog.tags) ? catalog.tags : [],
    projects: catalog.projects.map((project) => ({
      ...project,
      tags: Array.isArray(project.tags) ? project.tags : [],
    })),
  };
}

/** 标签规范：去首尾空格、内部空白折叠成一个空格。 */
export function normalizeTagLabel(label: string): string {
  return label.trim().replace(/\\s+/g, ' ');
}

/** 已存在的公开下载 URL 前缀，服务端只接受这个形状的 URL。 */
const DOWNLOAD_URL_PATTERN = /^\/download\/[a-z0-9-]+\/[^/\\?#]+$/;
const PLAY_URL_PATTERN = /^\/play\/[a-z0-9-]+\/$/;
const MEDIA_URL_PATTERN = /^\/media\/[a-z0-9-]+\/r\/[A-Za-z0-9._-]+\/[^/\\?#]+$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * 结构校验：写入 catalog 前必须通过。
 * 这里只做“结构性、不变量”检查，业务字段长度等由发布工具在 manifest 里限制。
 */
export function validateCatalog(value: unknown): { ok: true; catalog: CatalogFile } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '', message: 'catalog 必须是 JSON 对象' }] };
  }
  const raw = value as Record<string, unknown>;

  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    push('schemaVersion', `期望 ${CATALOG_SCHEMA_VERSION}，实际 ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
    push('revision', '必须是 >= 0 的整数');
  }
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) {
    push('generatedAt', '必须是 ISO 时间字符串');
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      push('tags', '必须是数组');
    } else {
      const seenTags = new Set<string>();
      raw.tags.forEach((item, index) => {
        const entry = item as Record<string, unknown> | null;
        if (typeof entry !== 'object' || entry === null) {
          push(`tags[${index}]`, '必须是对象');
          return;
        }
        if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
          push(`tags[${index}].label`, '不能为空');
          return;
        }
        const key = entry.label.trim().toLowerCase();
        if (seenTags.has(key)) push(`tags[${index}].label`, `标签重复：${entry.label}`);
        else seenTags.add(key);
        if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) {
          push(`tags[${index}].createdAt`, '必须是 ISO 时间字符串');
        }
      });
    }
  }

  if (!Array.isArray(raw.projects)) {
    push('projects', '必须是数组');
    return { ok: false, issues };
  }

  const seenSlugs = new Set<string>();
  raw.projects.forEach((item, index) => {
    const project = item as Record<string, unknown> | null;
    const at = `projects[${index}]`;
    if (typeof project !== 'object' || project === null || Array.isArray(project)) {
      push(at, '必须是对象');
      return;
    }
    const slug = project.slug;
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
      push(`${at}.slug`, 'slug 必须是小写字母/数字/连字符组成，最长 64');
    } else if (seenSlugs.has(slug)) {
      push(`${at}.slug`, `slug 重复：${slug}`);
    } else {
      seenSlugs.add(slug);
    }
    if (typeof project.id !== 'string' || project.id.length === 0) push(`${at}.id`, '不能为空');
    if (typeof project.title !== 'string' || project.title.trim().length === 0) push(`${at}.title`, '不能为空');
    if (typeof project.summary !== 'string') push(`${at}.summary`, '必须是字符串');
    if (typeof project.description !== 'string') push(`${at}.description`, '必须是字符串');
    if (!Array.isArray(project.categories) || project.categories.length === 0) {
      push(`${at}.categories`, '至少要有一个分类');
    } else {
      project.categories.forEach((category, categoryIndex) => {
        if (!isCategory(category)) push(`${at}.categories[${categoryIndex}]`, `未知分类：${String(category)}`);
      });
    }
    if (project.tags !== undefined) {
      if (!Array.isArray(project.tags)) {
        push(`${at}.tags`, '必须是数组');
      } else {
        const seenProjectTags = new Set<string>();
        project.tags.forEach((tag, tagIndex) => {
          if (typeof tag !== 'string' || tag.trim().length === 0) {
            push(`${at}.tags[${tagIndex}]`, '必须是非空字符串');
            return;
          }
          const key = tag.trim().toLowerCase();
          if (seenProjectTags.has(key)) push(`${at}.tags[${tagIndex}]`, `标签重复：${tag}`);
          else seenProjectTags.add(key);
        });
      }
    }

    for (const field of ['createdAt', 'updatedAt'] as const) {
      if (typeof project[field] !== 'string' || Number.isNaN(Date.parse(String(project[field])))) {
        push(`${at}.${field}`, '必须是 ISO 时间字符串');
      }
    }
    if (project.publishedAt !== null && (typeof project.publishedAt !== 'string' || Number.isNaN(Date.parse(project.publishedAt)))) {
      push(`${at}.publishedAt`, '必须是 ISO 时间字符串或 null');
    }
    if (typeof project.sortOrder !== 'number' || !Number.isFinite(project.sortOrder)) {
      push(`${at}.sortOrder`, '必须是数字');
    }
    if (typeof project.published !== 'boolean') push(`${at}.published`, '必须是布尔值');
    if (typeof project.demo !== 'boolean') push(`${at}.demo`, '必须是布尔值');

    if (project.cover !== null) {
      const cover = project.cover as Record<string, unknown> | null;
      if (typeof cover !== 'object' || cover === null) {
        push(`${at}.cover`, '必须是对象或 null');
      } else {
        if (typeof cover.url !== 'string' || !MEDIA_URL_PATTERN.test(cover.url)) {
          push(`${at}.cover.url`, '必须是 /media/<slug>/r/<releaseId>/<file> 形式');
        }
        if (cover.sha256 !== undefined && typeof cover.sha256 !== 'string') {
          push(`${at}.cover.sha256`, '必须是字符串');
        }
      }
    }
    if (!Array.isArray(project.screenshots)) {
      push(`${at}.screenshots`, '必须是数组');
    } else {
      project.screenshots.forEach((shot, shotIndex) => {
        const url = (shot as Record<string, unknown> | null)?.url;
        if (typeof url !== 'string' || !MEDIA_URL_PATTERN.test(url)) {
          push(`${at}.screenshots[${shotIndex}].url`, '必须是 /media/<slug>/r/<releaseId>/<file> 形式');
        }
      });
    }

    if (project.web !== null) {
      const web = project.web as Record<string, unknown> | null;
      if (typeof web !== 'object' || web === null) {
        push(`${at}.web`, '必须是对象或 null');
      } else {
        if (typeof web.releaseId !== 'string' || web.releaseId.length === 0) push(`${at}.web.releaseId`, '不能为空');
        if (typeof web.entry !== 'string' || web.entry.length === 0) push(`${at}.web.entry`, '不能为空');
        if (typeof web.publicUrl !== 'string' || !PLAY_URL_PATTERN.test(web.publicUrl) || web.publicUrl !== `/play/${String(slug)}/`) {
          push(`${at}.web.publicUrl`, '必须是 /play/<slug>/');
        }
        if (typeof web.spaFallback !== 'boolean') push(`${at}.web.spaFallback`, '必须是布尔值');
        if (web.contentHash !== undefined && typeof web.contentHash !== 'string') {
          push(`${at}.web.contentHash`, '必须是字符串');
        }
      }
    }

    if (!Array.isArray(project.downloads)) {
      push(`${at}.downloads`, '必须是数组');
    } else {
      const seenFiles = new Set<string>();
      const seenIds = new Set<string>();
      project.downloads.forEach((item2, downloadIndex) => {
        const download = item2 as Record<string, unknown> | null;
        const dat = `${at}.downloads[${downloadIndex}]`;
        if (typeof download !== 'object' || download === null) {
          push(dat, '必须是对象');
          return;
        }
        const fileName = download.fileName;
        if (typeof fileName !== 'string' || fileName.length === 0) {
          push(`${dat}.fileName`, '不能为空');
        } else if (seenFiles.has(fileName.toLowerCase())) {
          push(`${dat}.fileName`, `同一项目下文件名重复：${fileName}`);
        } else {
          seenFiles.add(fileName.toLowerCase());
        }
        const id = download.id;
        if (typeof id !== 'string' || id.length === 0) {
          push(`${dat}.id`, '不能为空');
        } else if (seenIds.has(id)) {
          push(`${dat}.id`, `下载 id 重复：${id}`);
        } else {
          seenIds.add(id);
        }
        if (!isPlatform(download.platform)) push(`${dat}.platform`, `未知平台：${String(download.platform)}`);
        if (typeof download.size !== 'number' || !Number.isInteger(download.size) || download.size < 0) {
          push(`${dat}.size`, '必须是非负整数');
        }
        if (typeof download.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(download.sha256)) {
          push(`${dat}.sha256`, '必须是 64 位小写十六进制');
        }
        if (typeof download.contentType !== 'string' || !download.contentType.includes('/')) {
          push(`${dat}.contentType`, '必须是 MIME 类型');
        }
        if (typeof download.publicUrl !== 'string' || !DOWNLOAD_URL_PATTERN.test(download.publicUrl)) {
          push(`${dat}.publicUrl`, '必须是 /download/<slug>/<fileName> 形式');
        }
        if (typeof download.storage !== 'string' || download.storage.length === 0) {
          push(`${dat}.storage`, '不能为空');
        } else if (download.storage.includes('\\') || download.storage.startsWith('/') || download.storage.includes('..')) {
          push(`${dat}.storage`, '必须是相对 DATA_DIR 的安全路径');
        }
        if (typeof download.isDefault !== 'boolean') push(`${dat}.isDefault`, '必须是布尔值');
        if (download.version !== null && typeof download.version !== 'string') push(`${dat}.version`, '必须是字符串或 null');
      });
      const defaults = project.downloads.filter((download) => (download as Record<string, unknown>).isDefault === true);
      if (defaults.length > 1) push(`${at}.downloads`, '最多只能有一个默认下载项');
    }

    if (!Array.isArray(project.releaseHistory)) push(`${at}.releaseHistory`, '必须是数组');
    if (project.lastFingerprint !== null && typeof project.lastFingerprint !== 'string') {
      push(`${at}.lastFingerprint`, '必须是字符串或 null');
    }
    if (project.unpublishReason !== null && typeof project.unpublishReason !== 'string') {
      push(`${at}.unpublishReason`, '必须是字符串或 null');
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, catalog: normalizeCatalog(value as CatalogFile) };
}
