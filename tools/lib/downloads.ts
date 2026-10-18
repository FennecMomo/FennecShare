import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findProject } from '../../shared/catalog.js';
import { isSafeFileName } from '../../shared/paths.js';
import type { Platform, PublicDownload, StoredDownload, StoredProject } from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { contentTypeFor } from '../../server/mime.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile } from './catalog-io.js';
import { appendHistory } from './history.js';
import { commit } from './manage.js';
import { PublishError } from './errors.js';
import type { ReleasePart } from './publish.js';
import { sha256Buffer } from './hash.js';
import { loadLimits } from './manifest.js';

export interface DownloadUploadInput {
  fileName: string;
  buffer: Buffer;
  platform: Platform;
  version?: string | null;
  isDefault?: boolean;
}

export interface DownloadUpdateResult {
  ok: true;
  slug: string;
  releaseId: string;
  revision: number;
  download: PublicDownload;
  replaced: boolean;
  message: string;
}

function releaseDirOf(dataDir: string, slug: string, releaseId: string): string {
  return path.join(dataDir, 'projects', slug, 'releases', releaseId);
}

function nextReleaseId(dataDir: string, slug: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `r-${stamp}-${randomBytes(3).toString('hex')}`;
    if (!fs.existsSync(releaseDirOf(dataDir, slug, candidate))) return candidate;
  }
  return `r-${stamp}-${randomBytes(4).toString('hex')}`;
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
}

/** 与发布 CLI 保持一致的下载 id：同一个项目里同名文件永远是同一个 id。 */
function stableDownloadId(slug: string, fileName: string): string {
  return `dl-${sha256Buffer(Buffer.from(`${slug}/${fileName.toLowerCase()}`, 'utf8')).slice(0, 12)}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function stageRelease(
  config: PublisherConfig,
  project: StoredProject,
): Promise<{ releaseId: string; stagingDir: string; sourceReleaseId: string | null }> {
  const now = new Date();
  const releaseId = nextReleaseId(config.dataDir, project.slug, now);
  const stagingDir = path.join(config.dataDir, 'staging', `dl-${project.slug}-${randomBytes(4).toString('hex')}`);
  const sourceReleaseId =
    project.web?.releaseId ??
    project.downloads[0]?.releaseId ??
    project.cover?.releaseId ??
    project.screenshots[0]?.releaseId ??
    null;
  const sourceDir = sourceReleaseId ? releaseDirOf(config.dataDir, project.slug, sourceReleaseId) : null;
  if (sourceDir && (await exists(sourceDir))) {
    await fs.promises.cp(sourceDir, stagingDir, { recursive: true });
  } else {
    await fs.promises.mkdir(stagingDir, { recursive: true });
  }
  return { releaseId, stagingDir, sourceReleaseId };
}

async function writeReleaseDoc(stagingDir: string, releaseId: string, slug: string, downloads: StoredDownload[]): Promise<void> {
  let releaseDoc: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(path.join(stagingDir, 'release.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) releaseDoc = parsed as Record<string, unknown>;
  } catch {
    // 没有就按最小结构重写
  }
  const next = {
    ...releaseDoc,
    schemaVersion: 1,
    releaseId,
    slug,
    createdAt: new Date().toISOString(),
    downloads: downloads.map((download) => ({
      fileName: download.fileName,
      storedAs: path.basename(download.storage),
      platform: download.platform,
      version: download.version,
      size: download.size,
      sha256: download.sha256,
      contentType: download.contentType,
      isDefault: download.isDefault,
    })),
  };
  await fs.promises.writeFile(path.join(stagingDir, 'release.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * 上传/替换一个下载包。
 *
 * 同名文件按「替换」处理（同一个项目里下载 URL 是 /download/<slug>/<fileName>，重名没有意义）。
 * 每次上传都会生成新的版本目录，旧文件留在旧版本里，不破坏已发出去的链接。
 */
export async function upsertProjectDownload(
  config: PublisherConfig,
  slug: string,
  input: DownloadUploadInput,
): Promise<DownloadUpdateResult> {
  const limits = loadLimits();
  const fileName = (input.fileName ?? '').trim();
  if (!isSafeFileName(fileName)) {
    throw new PublishError('invalid_request', '文件名不合法：不能包含路径分隔符、控制字符或首尾空格');
  }
  if (path.extname(fileName).length === 0) {
    throw new PublishError('invalid_request', '文件名需要带扩展名（例如 .exe / .apk / .zip）');
  }
  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    throw new PublishError('invalid_upload', '上传内容为空');
  }
  if (input.buffer.length > limits.maxDownloadBytes) {
    throw new PublishError('invalid_upload', `文件过大：${input.buffer.length} 字节，上限 ${limits.maxDownloadBytes}`);
  }

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `download ${slug}/${fileName}`);
  let stagingDir: string | null = null;
  let renamed = false;

  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);

    const nowIso = new Date().toISOString();
    const staged = await stageRelease(config, project);
    stagingDir = staged.stagingDir;
    const finalReleaseId = staged.releaseId;

    const downloadsDir = path.join(stagingDir, 'downloads');
    await fs.promises.mkdir(downloadsDir, { recursive: true });

    const sha256 = sha256Buffer(input.buffer);
    const existingIndex = project.downloads.findIndex(
      (item) => item.fileName.toLowerCase() === fileName.toLowerCase(),
    );
    const replaced = existingIndex >= 0;
    const nextIndex = replaced ? existingIndex : project.downloads.length;
    const storedName = `${String(nextIndex + 1).padStart(2, '0')}-${sha256.slice(0, 8)}${safeExtension(fileName)}`;
    await fs.promises.writeFile(path.join(downloadsDir, storedName), input.buffer);

    const existing = existingIndex >= 0 ? project.downloads[existingIndex] : undefined;
    // 替换时沿用原来的默认标记，否则「本来默认的那个包」会在替换后失去默认
    const wantsDefault =
      input.isDefault === true || project.downloads.length === 0 || existing?.isDefault === true;
    const kept = project.downloads
      .filter((item) => item.fileName.toLowerCase() !== fileName.toLowerCase())
      .map((item) => (wantsDefault ? { ...item, isDefault: false } : item));

    const download: StoredDownload = {
      id: stableDownloadId(slug, fileName),
      fileName,
      platform: input.platform,
      version: input.version === undefined || input.version === null ? null : String(input.version).trim() || null,
      size: input.buffer.length,
      sha256,
      contentType: contentTypeFor(fileName),
      publicUrl: `/download/${slug}/${encodeURIComponent(fileName)}`,
      releaseId: finalReleaseId,
      isDefault: wantsDefault,
      storage: `projects/${slug}/releases/${finalReleaseId}/downloads/${storedName}`,
    };

    const nextDownloads = [...kept, download];
    await writeReleaseDoc(stagingDir, finalReleaseId, slug, nextDownloads);

    const targetDir = releaseDirOf(config.dataDir, slug, finalReleaseId);
    await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.promises.rename(stagingDir, targetDir);
    renamed = true;

    const updated: StoredProject = {
      ...project,
      downloads: nextDownloads,
      updatedAt: nowIso,
      lastFingerprint: null,
      releaseHistory: [
        ...project.releaseHistory,
        { releaseId: finalReleaseId, createdAt: nowIso, parts: ['downloads'] as ReleasePart[], fingerprint: sha256 },
      ].slice(-50),
    };

    await appendHistory(config.dataDir, slug, 'downloads', updated, finalReleaseId, nowIso);
    await commit(config.dataDir, catalog, updated);

    return {
      ok: true,
      slug,
      releaseId: finalReleaseId,
      revision: catalog.revision + 1,
      download: {
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
      },
      replaced,
      message: `${replaced ? '已替换' : '已上传'}下载包 ${fileName}（新版本 ${finalReleaseId}）。`,
    };
  } finally {
    if (stagingDir && !renamed) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await lock.release();
  }
}

export async function removeProjectDownload(config: PublisherConfig, slug: string, fileName: string): Promise<{ revision: number; removed: string }> {
  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `download-remove ${slug}/${fileName}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);
    const target = project.downloads.find((item) => item.fileName.toLowerCase() === fileName.toLowerCase());
    if (!target) throw new PublishError('invalid_request', `下载记录不存在：${fileName}`);

    const rest = project.downloads.filter((item) => item !== target);
    if (rest.length > 0 && !rest.some((item) => item.isDefault)) rest[0] = { ...rest[0]!, isDefault: true };

    const nowIso = new Date().toISOString();
    const updated: StoredProject = {
      ...project,
      downloads: rest,
      updatedAt: nowIso,
      releaseHistory: [
        ...project.releaseHistory,
        { releaseId: project.web?.releaseId ?? null, createdAt: nowIso, parts: ['downloads'] as ReleasePart[], fingerprint: 'removed' },
      ].slice(-50),
    };
    await appendHistory(config.dataDir, slug, 'downloads', updated, updated.web?.releaseId ?? null, nowIso);
    await commit(config.dataDir, catalog, updated);
    return { revision: catalog.revision + 1, removed: target.fileName };
  } finally {
    await lock.release();
  }
}
