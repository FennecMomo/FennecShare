import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findProject, validateCatalog } from '../../shared/catalog.js';
import type {
  CatalogFile,
  MediaAsset,
  Platform,
  StoredDownload,
  StoredProject,
  TagRecord,
  WebRelease,
} from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { downloadContentType } from '../../server/mime.js';
import { hashDirectory, sha256Buffer, sha256File } from './hash.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile, writeCatalogAtomic } from './catalog-io.js';
import { appendHistory } from './history.js';
import {
  copyDirectorySafely,
  detectWebRoot,
  extractZipSafely,
  makeTempName,
  scanRootAbsoluteRefs,
} from './package.js';
import { loadLimits, loadManifest, type ManifestMedia, type PublishLimits, type ResolvedManifest } from './manifest.js';
import { PublishError } from './errors.js';

export type ReleasePart = 'web' | 'media' | 'downloads' | 'meta';

export interface PublishOptions {
  manifestPath: string;
  /** 只做校验和内容准备，不写 catalog、不创建 release 目录。 */
  dryRun?: boolean;
}

export interface PublishResult {
  ok: true;
  status: 'created' | 'updated' | 'unchanged' | 'validated';
  changed: boolean;
  dryRun: boolean;
  slug: string;
  title: string;
  releaseId: string | null;
  catalogRevision: number;
  parts: ReleasePart[];
  web: {
    entry: string;
    publicUrl: string;
    absoluteUrl: string | null;
    spaFallback: boolean;
    contentHash: string;
  } | null;
  downloads: Array<{
    fileName: string;
    platform: Platform;
    version: string | null;
    size: number;
    sha256: string;
    publicUrl: string;
    absoluteUrl: string | null;
    isDefault: boolean;
  }>;
  publicUrls: { home: string; projectApi: string };
  warnings: string[];
  message: string;
}

interface StagedMedia {
  role: 'cover' | 'shot';
  stagedName: string;
  sha256: string;
  size: number;
  alt: string;
  raw: ManifestMedia;
}

interface StagedDownload {
  stagedName: string;
  fileName: string;
  platform: Platform;
  version: string | null;
  size: number;
  sha256: string;
  isDefault: boolean;
  contentType: string;
}

interface Staged {
  dir: string;
  hasContent: boolean;
  web: { entry: string; spaFallback: boolean; contentHash: string; fileCount: number; totalBytes: number } | null;
  cover: StagedMedia | null;
  screenshots: StagedMedia[];
  downloads: StagedDownload[];
  warnings: string[];
}

const DOWNLOAD_EXT_PATTERN = /^\.[a-z0-9]{1,12}$/;

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return DOWNLOAD_EXT_PATTERN.test(extension) ? extension : '.bin';
}

function imageExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.img';
}

function makeReleaseId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  return `r-${stamp}-${randomBytes(3).toString('hex')}`;
}

function releaseDirOf(dataDir: string, slug: string, releaseId: string): string {
  return path.join(dataDir, 'projects', slug, 'releases', releaseId);
}

function uniqueReleaseId(dataDir: string, slug: string, now: Date): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = makeReleaseId(now);
    if (!fs.existsSync(releaseDirOf(dataDir, slug, candidate))) return candidate;
  }
  return `${makeReleaseId(now)}-${randomBytes(4).toString('hex')}`;
}

function stableDownloadId(slug: string, fileName: string): string {
  return `dl-${sha256Buffer(Buffer.from(`${slug}/${fileName.toLowerCase()}`, 'utf8')).slice(0, 12)}`;
}

async function stageMedia(
  stagingDir: string,
  media: ManifestMedia,
  role: 'cover' | 'shot',
  index: number,
): Promise<StagedMedia> {
  const mediaDir = path.join(stagingDir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const tempName = `_tmp-${role}-${index}-${randomBytes(4).toString('hex')}`;
  const tempPath = path.join(mediaDir, tempName);
  await fs.promises.copyFile(media.sourcePath, tempPath);
  const sha256 = await sha256File(tempPath);
  const stagedName = `${role === 'cover' ? 'cover' : `shot-${String(index + 1).padStart(2, '0')}`}-${sha256.slice(0, 10)}${imageExtension(media.sourcePath)}`;
  const finalPath = path.join(mediaDir, stagedName);
  await fs.promises.rm(finalPath, { force: true });
  await fs.promises.rename(tempPath, finalPath);
  const stat = await fs.promises.stat(finalPath);
  return { role, stagedName, sha256, size: stat.size, alt: media.alt, raw: media };
}

async function stageDownloads(stagingDir: string, manifest: ResolvedManifest): Promise<StagedDownload[]> {
  const downloadsDir = path.join(stagingDir, 'downloads');
  const result: StagedDownload[] = [];
  for (let index = 0; index < manifest.downloads.length; index += 1) {
    const download = manifest.downloads[index];
    if (!download) continue;
    await fs.promises.mkdir(downloadsDir, { recursive: true });
    const tempPath = path.join(downloadsDir, `_tmp-${index}-${randomBytes(4).toString('hex')}`);
    await fs.promises.copyFile(download.sourcePath, tempPath);
    const sha256 = await sha256File(tempPath);
    const stagedName = `${String(index + 1).padStart(2, '0')}-${sha256.slice(0, 8)}${safeExtension(download.fileName)}`;
    const finalPath = path.join(downloadsDir, stagedName);
    await fs.promises.rm(finalPath, { force: true });
    await fs.promises.rename(tempPath, finalPath);
    const stat = await fs.promises.stat(finalPath);
    result.push({
      stagedName,
      fileName: download.fileName,
      platform: download.platform,
      version: download.version,
      size: stat.size,
      sha256,
      isDefault: download.isDefault,
      contentType: download.contentType ?? downloadContentType(download.fileName),
    });
  }
  return result;
}

async function stageAll(stagingDir: string, manifest: ResolvedManifest, limits: PublishLimits): Promise<Staged> {
  await fs.promises.mkdir(stagingDir, { recursive: true });
  const warnings = [...manifest.warnings];
  let web: Staged['web'] = null;

  if (manifest.web) {
    const packageDir = path.join(stagingDir, '_pkg');
    if (manifest.web.kind === 'zip') {
      const extracted = await extractZipSafely(manifest.web.sourcePath, packageDir, limits);
      warnings.push(...extracted.warnings);
      warnings.push(`ZIP 解压出 ${extracted.fileCount} 个文件，共 ${extracted.totalBytes} 字节`);
    } else {
      const copied = await copyDirectorySafely(manifest.web.sourcePath, packageDir, limits);
      warnings.push(...copied.warnings);
    }

    const info = await detectWebRoot(packageDir, manifest.web.entry, limits);
    warnings.push(...info.warnings);

    const webTarget = path.join(stagingDir, 'web');
    if (path.resolve(info.webRoot) === path.resolve(packageDir)) {
      await fs.promises.rename(packageDir, webTarget);
    } else {
      await fs.promises.rename(info.webRoot, webTarget);
      await fs.promises.rm(packageDir, { recursive: true, force: true });
    }

    warnings.push(...(await scanRootAbsoluteRefs(webTarget)));
    const hashed = await hashDirectory(webTarget);
    web = {
      entry: info.entry,
      spaFallback: manifest.web.spaFallback,
      contentHash: sha256Buffer(Buffer.from(JSON.stringify(hashed.files), 'utf8')),
      fileCount: hashed.files.length,
      totalBytes: hashed.totalBytes,
    };
  }

  let cover: StagedMedia | null = null;
  if (manifest.cover) cover = await stageMedia(stagingDir, manifest.cover, 'cover', 0);

  const screenshots: StagedMedia[] = [];
  if (manifest.screenshots) {
    for (let index = 0; index < manifest.screenshots.length; index += 1) {
      const media = manifest.screenshots[index];
      if (!media) continue;
      screenshots.push(await stageMedia(stagingDir, media, 'shot', index));
    }
  }

  const downloads = await stageDownloads(stagingDir, manifest);
  const hasContent = web !== null || cover !== null || screenshots.length > 0 || downloads.length > 0;

  return { dir: stagingDir, hasContent, web, cover, screenshots, downloads, warnings };
}

function toAbsolute(publicBaseUrl: string | null, url: string): string | null {
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl}${url}`;
}

/** 内容指纹：只看“发布了什么”，不看发布时间、releaseId 等易变字段。 */
function fingerprintOf(input: {
  manifest: ResolvedManifest;
  cover: MediaAsset | null;
  screenshots: MediaAsset[];
  web: WebRelease | null;
  downloads: StoredDownload[];
}): string {
  const payload = {
    v: 1,
    slug: input.manifest.slug,
    title: input.manifest.title,
    summary: input.manifest.summary,
    description: input.manifest.description,
    categories: input.manifest.categories,
    displayVersion: input.manifest.displayVersion,
    sortOrder: input.manifest.sortOrder,
    published: input.manifest.published,
    demo: input.manifest.demo,
    cover: input.cover ? { sha256: input.cover.sha256, alt: input.cover.alt } : null,
    screenshots: input.screenshots.map((shot) => ({ sha256: shot.sha256, alt: shot.alt })),
    web: input.web
      ? { entry: input.web.entry, spaFallback: input.web.spaFallback, contentHash: input.web.contentHash }
      : null,
    downloads: [...input.downloads]
      .map((download) => ({
        fileName: download.fileName,
        platform: download.platform,
        version: download.version,
        size: download.size,
        sha256: download.sha256,
        isDefault: download.isDefault,
        contentType: download.contentType,
      }))
      .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0)),
  };
  return sha256Buffer(Buffer.from(JSON.stringify(payload), 'utf8'));
}

function buildProject(args: {
  existing: StoredProject | undefined;
  manifest: ResolvedManifest;
  staged: Staged;
  releaseId: string;
  nowIso: string;
}): { project: StoredProject; parts: ReleasePart[]; warnings: string[] } {
  const { existing, manifest, staged, releaseId, nowIso } = args;
  const slug = manifest.slug;
  const warnings: string[] = [];

  let cover: MediaAsset | null;
  if (manifest.cover === undefined) {
    cover = existing?.cover ?? null;
  } else if (manifest.cover === null) {
    cover = null;
  } else {
    const stagedCover = staged.cover;
    cover = stagedCover
      ? {
          url: `/media/${slug}/r/${releaseId}/${stagedCover.stagedName}`,
          alt: manifest.cover.alt,
          releaseId,
          fileName: stagedCover.stagedName,
          sha256: stagedCover.sha256,
          width: null,
          height: null,
        }
      : null;
  }

  let screenshots: MediaAsset[];
  if (manifest.screenshots === undefined) {
    screenshots = existing?.screenshots ?? [];
  } else {
    screenshots = staged.screenshots.map((shot) => ({
      url: `/media/${slug}/r/${releaseId}/${shot.stagedName}`,
      alt: shot.alt,
      releaseId,
      fileName: shot.stagedName,
      sha256: shot.sha256,
      width: null,
      height: null,
    }));
  }

  let web: WebRelease | null;
  if (manifest.web === undefined) {
    web = existing?.web ?? null;
  } else if (!staged.web) {
    web = null;
  } else {
    web = {
      releaseId,
      entry: staged.web.entry,
      publicUrl: `/play/${slug}/`,
      spaFallback: staged.web.spaFallback,
      contentHash: staged.web.contentHash,
      publishedAt: nowIso,
    };
  }

  const removedNames = new Set(manifest.removeDownloads.map((name) => name.toLowerCase()));
  const replacedNames = new Set(staged.downloads.map((download) => download.fileName.toLowerCase()));
  const existingDownloadNames = new Set((existing?.downloads ?? []).map((download) => download.fileName.toLowerCase()));

  for (const name of manifest.removeDownloads) {
    if (!existingDownloadNames.has(name.toLowerCase())) {
      warnings.push(`removeDownloads 里的 ${name} 在当前项目中不存在，已忽略`);
    }
  }

  const keptDownloads: StoredDownload[] = (existing?.downloads ?? []).filter((download) => {
    const lower = download.fileName.toLowerCase();
    if (removedNames.has(lower)) return false;
    if (replacedNames.has(lower)) return false;
    return true;
  });

  const newDownloads: StoredDownload[] = staged.downloads.map((download) => ({
    id: stableDownloadId(slug, download.fileName),
    fileName: download.fileName,
    platform: download.platform,
    version: download.version,
    size: download.size,
    sha256: download.sha256,
    contentType: download.contentType,
    publicUrl: `/download/${slug}/${encodeURIComponent(download.fileName)}`,
    releaseId,
    isDefault: download.isDefault,
    storage: `projects/${slug}/releases/${releaseId}/downloads/${download.stagedName}`,
  }));

  const newDefaults = newDownloads.filter((download) => download.isDefault);
  if (newDefaults.length > 1) {
    throw new PublishError('invalid_manifest', '一次发布里最多只能有一个 default: true');
  }

  let downloads: StoredDownload[] = [...keptDownloads, ...newDownloads];
  if (newDefaults.length === 1) {
    const winnerId = newDefaults[0]?.id;
    downloads = downloads.map((download) => ({ ...download, isDefault: download.id === winnerId }));
  } else if (downloads.filter((download) => download.isDefault).length === 0 && downloads.length === 1) {
    downloads = downloads.map((download) => ({ ...download, isDefault: true }));
  }
  downloads.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));

  const parts: ReleasePart[] = [];
  const sameWeb = (existing?.web?.contentHash ?? null) === (web?.contentHash ?? null) &&
    (existing?.web?.entry ?? null) === (web?.entry ?? null) &&
    (existing?.web?.spaFallback ?? null) === (web?.spaFallback ?? null);
  if (!sameWeb) parts.push('web');

  const sameMedia =
    (existing?.cover?.sha256 ?? null) === (cover?.sha256 ?? null) &&
    (existing?.cover?.alt ?? null) === (cover?.alt ?? null) &&
    existing?.screenshots.length === screenshots.length &&
    screenshots.every((shot, index) => {
      const previous = existing?.screenshots[index];
      return previous !== undefined && previous.sha256 === shot.sha256 && previous.alt === shot.alt;
    });
  if (!sameMedia) parts.push('media');

  const signature = (list: StoredDownload[]): string =>
    list
      .map((download) =>
        [download.fileName, download.platform, download.version ?? '', download.size, download.sha256, download.isDefault ? '1' : '0', download.contentType].join('|'),
      )
      .join('\n');
  if (signature(existing?.downloads ?? []) !== signature(downloads)) parts.push('downloads');

  const metaChanged =
    existing === undefined ||
    existing.title !== manifest.title ||
    existing.summary !== manifest.summary ||
    existing.description !== manifest.description ||
    existing.categories.join(',') !== manifest.categories.join(',') ||
    existing.displayVersion !== manifest.displayVersion ||
    existing.sortOrder !== manifest.sortOrder ||
    existing.demo !== manifest.demo ||
    existing.published !== manifest.published;
  if (metaChanged) parts.push('meta');

  const project: StoredProject = {
    id: existing?.id ?? slug,
    slug,
    title: manifest.title,
    summary: manifest.summary,
    description: manifest.description,
    categories: manifest.categories,
    tags: manifest.tags ?? existing?.tags ?? [],
    cover,
    screenshots,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    publishedAt: manifest.published ? (existing?.publishedAt ?? nowIso) : (existing?.publishedAt ?? null),
    displayVersion: manifest.displayVersion,
    sortOrder: manifest.sortOrder,
    published: manifest.published,
    demo: manifest.demo,
    web,
    downloads,
    releaseHistory: existing?.releaseHistory ?? [],
    lastFingerprint: null,
    unpublishReason: manifest.published ? null : (existing?.unpublishReason ?? null),
  };

  return { project, parts, warnings };
}

/** 把项目里的标签并进 catalog 的标签登记表（新标签追加到末尾）。 */
export function mergeTagRegistry(existing: TagRecord[] | undefined, tags: string[], nowIso: string): TagRecord[] {
  const registry = [...(existing ?? [])];
  const known = new Set(registry.map((item) => item.label.toLowerCase()));
  for (const label of tags) {
    if (known.has(label.toLowerCase())) continue;
    registry.push({ label, createdAt: nowIso });
    known.add(label.toLowerCase());
  }
  return registry;
}

function replaceProject(catalog: CatalogFile, project: StoredProject): CatalogFile {
  const projects = catalog.projects.filter((item) => item.slug !== project.slug);
  projects.push(project);
  projects.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { ...catalog, projects };
}

export async function publishProject(config: PublisherConfig, options: PublishOptions): Promise<PublishResult> {
  const limits = loadLimits();
  const manifest = loadManifest(options.manifestPath, limits);
  const dryRun = options.dryRun === true;

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `publish ${manifest.slug}`);

  try {
    const catalog = await readCatalogFile(config.dataDir);
    const existing = findProject(catalog, manifest.slug);
    const now = new Date();
    const nowIso = now.toISOString();
    const stagingDir = path.join(config.dataDir, 'staging', makeTempName(manifest.slug));
    let renamed = false;

    try {
      const staged = await stageAll(stagingDir, manifest, limits);
      const releaseId = uniqueReleaseId(config.dataDir, manifest.slug, now);
      const built = buildProject({ existing, manifest, staged, releaseId, nowIso });
      const fingerprint = fingerprintOf({
        manifest,
        cover: built.project.cover,
        screenshots: built.project.screenshots,
        web: built.project.web,
        downloads: built.project.downloads,
      });
      const project: StoredProject = { ...built.project, lastFingerprint: fingerprint };
      const warnings = [...staged.warnings, ...built.warnings];

      const unchanged =
        existing !== undefined &&
        existing.lastFingerprint === fingerprint &&
        existing.published === manifest.published;

      const absolutePlay = project.web ? toAbsolute(config.publicBaseUrl, project.web.publicUrl) : null;
      const downloadSummary = project.downloads.map((download) => ({
        fileName: download.fileName,
        platform: download.platform,
        version: download.version,
        size: download.size,
        sha256: download.sha256,
        publicUrl: download.publicUrl,
        absoluteUrl: toAbsolute(config.publicBaseUrl, download.publicUrl),
        isDefault: download.isDefault,
      }));

      if (unchanged) {
        return {
          ok: true,
          status: 'unchanged',
          changed: false,
          dryRun,
          slug: manifest.slug,
          title: project.title,
          releaseId: existing?.web?.releaseId ?? null,
          catalogRevision: catalog.revision,
          parts: [],
          web: project.web
            ? {
                entry: project.web.entry,
                publicUrl: project.web.publicUrl,
                absoluteUrl: absolutePlay,
                spaFallback: project.web.spaFallback,
                contentHash: project.web.contentHash,
              }
            : null,
          downloads: downloadSummary,
          publicUrls: publicUrlsOf(config, manifest.slug),
          warnings,
          message: `项目 ${manifest.slug} 与现有内容完全一致，无需更新（未创建新版本）。`,
        };
      }

      if (dryRun) {
        return {
          ok: true,
          status: 'validated',
          changed: true,
          dryRun: true,
          slug: manifest.slug,
          title: project.title,
          releaseId: null,
          catalogRevision: catalog.revision,
          parts: built.parts,
          web: project.web
            ? {
                entry: project.web.entry,
                publicUrl: project.web.publicUrl,
                absoluteUrl: absolutePlay,
                spaFallback: project.web.spaFallback,
                contentHash: project.web.contentHash,
              }
            : null,
          downloads: downloadSummary,
          publicUrls: publicUrlsOf(config, manifest.slug),
          warnings,
          message: `试运行通过：${existing ? '将更新' : '将新增'}项目 ${manifest.slug}（未写入任何文件）。`,
        };
      }

      // ---- 落盘：先把 release 目录移动到位，再切换 catalog ----
      if (staged.hasContent) {
        const releaseDir = releaseDirOf(config.dataDir, manifest.slug, releaseId);
        await fs.promises.mkdir(path.dirname(releaseDir), { recursive: true });
        await fs.promises.rename(stagingDir, releaseDir);
        renamed = true;

        const releaseDoc = {
          schemaVersion: 1,
          releaseId,
          slug: manifest.slug,
          createdAt: nowIso,
          manifestPath: manifest.manifestPath,
          web: staged.web,
          media: [staged.cover, ...staged.screenshots]
            .filter((item): item is StagedMedia => item !== null)
            .map((item) => ({ role: item.role, fileName: item.stagedName, size: item.size, sha256: item.sha256, alt: item.alt })),
          downloads: staged.downloads.map((download) => ({
            fileName: download.fileName,
            storedAs: download.stagedName,
            platform: download.platform,
            version: download.version,
            size: download.size,
            sha256: download.sha256,
            contentType: download.contentType,
            isDefault: download.isDefault,
          })),
          warnings,
        };
        await fs.promises.writeFile(
          path.join(releaseDir, 'release.json'),
          `${JSON.stringify(releaseDoc, null, 2)}\n`,
          'utf8',
        );
      }

      const historyEntry = {
        releaseId: staged.hasContent ? releaseId : null,
        createdAt: nowIso,
        parts: built.parts,
        fingerprint,
      };
      const releaseHistory = [...(existing?.releaseHistory ?? []), historyEntry].slice(-50);
      const finalProject: StoredProject = { ...project, releaseHistory };

      const nextCatalog: CatalogFile = replaceProject(catalog, finalProject);
      nextCatalog.tags = mergeTagRegistry(catalog.tags, finalProject.tags, nowIso);
      nextCatalog.revision = catalog.revision + 1;
      nextCatalog.generatedAt = nowIso;

      const validated = validateCatalog(nextCatalog);
      if (!validated.ok) {
        throw new PublishError(
          'invalid_catalog',
          `生成的 catalog 未通过校验：${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')}`,
        );
      }

      await appendHistory(config.dataDir, manifest.slug, 'publish', finalProject, historyEntry.releaseId, nowIso);
      await writeCatalogAtomic(config.dataDir, validated.catalog);

      const status = existing ? 'updated' : 'created';
      return {
        ok: true,
        status,
        changed: true,
        dryRun: false,
        slug: manifest.slug,
        title: finalProject.title,
        releaseId: historyEntry.releaseId,
        catalogRevision: nextCatalog.revision,
        parts: built.parts,
        web: finalProject.web
          ? {
              entry: finalProject.web.entry,
              publicUrl: finalProject.web.publicUrl,
              absoluteUrl: absolutePlay,
              spaFallback: finalProject.web.spaFallback,
              contentHash: finalProject.web.contentHash,
            }
          : null,
        downloads: downloadSummary,
        publicUrls: publicUrlsOf(config, manifest.slug),
        warnings,
        message: `${status === 'created' ? '新增' : '更新'}项目 ${manifest.slug} 成功（catalog revision ${nextCatalog.revision}）。`,
      };
    } finally {
      if (!renamed) {
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } finally {
    await lock.release();
  }
}

export function publicUrlsOf(config: PublisherConfig, slug: string): PublishResult['publicUrls'] {
  return {
    home: toAbsolute(config.publicBaseUrl, '/') ?? '/',
    projectApi: toAbsolute(config.publicBaseUrl, `/api/projects/${slug}`) ?? `/api/projects/${slug}`,
  };
}
