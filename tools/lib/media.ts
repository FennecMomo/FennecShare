import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findProject } from '../../shared/catalog.js';
import type { MediaAsset, StoredProject } from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile } from './catalog-io.js';
import { appendHistory } from './history.js';
import { commit } from './manage.js';
import { PublishError } from './errors.js';
import { sha256Buffer } from './hash.js';
import type { ReleasePart } from './publish.js';

/** 单张图片上限：管理页面上传的封面/截图。 */
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
/** 每个项目最多保留多少张截图。 */
export const MAX_SCREENSHOTS = 12;

export interface MediaUpload {
  buffer: Buffer;
  alt?: string | null;
}

export interface MediaUpdateRequest {
  /** undefined = 保持不变；null = 删除封面；有值 = 替换封面 */
  cover?: MediaUpload | null;
  addScreenshots?: MediaUpload[];
  removeScreenshots?: number[];
}

export interface MediaUpdateResult {
  ok: true;
  slug: string;
  releaseId: string;
  catalogRevision: number;
  cover: MediaAsset | null;
  screenshots: MediaAsset[];
  message: string;
}

/** 只认 PNG / JPEG / WebP：按魔数判断，不信任上传时声明的 Content-Type。 */
export function sniffImage(buffer: Buffer): { ext: '.png' | '.jpg' | '.webp'; mime: string } {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer.readUInt8(0) === 0xff && buffer.readUInt8(1) === 0xd8 && buffer.readUInt8(2) === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  throw new PublishError('invalid_upload', '只支持 PNG、JPEG、WebP 格式的图片');
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

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

interface MediaEntry {
  fileName: string;
  sha256: string;
  alt: string;
  size: number;
}

/**
 * 修改项目的封面与截图。
 *
 * 图片 URL 里带发布版本号，所以这里必须生成一个新版本目录：把当前版本目录整份复制过去，
 * 替换 media/ 后整体 rename 到位，最后原子替换 catalog。旧版本目录保持不动，随时可回滚。
 * web/ 与 downloads/ 只是被复制，内容不变，所以 project.web.releaseId 不做改动。
 */
export async function updateProjectMedia(
  config: PublisherConfig,
  slug: string,
  request: MediaUpdateRequest,
): Promise<MediaUpdateResult> {
  const adds = request.addScreenshots ?? [];
  const removes = [...new Set(request.removeScreenshots ?? [])];
  const touchesCover = Object.prototype.hasOwnProperty.call(request, 'cover');
  if (!touchesCover && adds.length === 0 && removes.length === 0) {
    throw new PublishError('invalid_request', '没有需要修改的图片');
  }

  const uploads = [request.cover, ...adds].filter((item): item is MediaUpload => Boolean(item));
  for (const upload of uploads) {
    if (upload.buffer.length === 0) throw new PublishError('invalid_upload', '图片内容为空');
    if (upload.buffer.length > MAX_MEDIA_BYTES) {
      throw new PublishError('invalid_upload', `图片过大：${upload.buffer.length} 字节，上限 ${MAX_MEDIA_BYTES} 字节`);
    }
  }

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `media ${slug}`);
  let renamed = false;
  let stagingDir: string | null = null;

  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);

    const sourceReleaseId =
      project.web?.releaseId ??
      project.downloads[0]?.releaseId ??
      project.cover?.releaseId ??
      project.screenshots[0]?.releaseId ??
      null;
    const sourceDir = sourceReleaseId ? releaseDirOf(config.dataDir, slug, sourceReleaseId) : null;

    const now = new Date();
    const nowIso = now.toISOString();
    const releaseId = nextReleaseId(config.dataDir, slug, now);
    stagingDir = path.join(config.dataDir, 'staging', `media-${slug}-${randomBytes(4).toString('hex')}`);

    if (sourceDir && (await isDirectory(sourceDir))) {
      await fs.promises.cp(sourceDir, stagingDir, { recursive: true });
    } else {
      await fs.promises.mkdir(path.join(stagingDir, 'media'), { recursive: true });
    }

    const mediaDir = path.join(stagingDir, 'media');
    await fs.promises.mkdir(mediaDir, { recursive: true });

    for (const index of removes) {
      if (!project.screenshots[index]) throw new PublishError('invalid_request', `截图序号越界：${index + 1}`);
    }
    if (project.screenshots.length - removes.length + adds.length > MAX_SCREENSHOTS) {
      throw new PublishError('invalid_request', `截图最多 ${MAX_SCREENSHOTS} 张`);
    }

    const keptShots = project.screenshots.filter((_, index) => !removes.includes(index));

    // 1) 封面
    let coverEntry: MediaEntry | null = project.cover
      ? {
          fileName: project.cover.fileName,
          sha256: project.cover.sha256,
          alt: project.cover.alt,
          size: await fileSize(path.join(mediaDir, project.cover.fileName)),
        }
      : null;

    if (request.cover === null) {
      coverEntry = null;
    } else if (request.cover) {
      const upload = request.cover;
      const { ext } = sniffImage(upload.buffer);
      const sha256 = sha256Buffer(upload.buffer);
      const fileName = `cover-${sha256.slice(0, 10)}${ext}`;
      await fs.promises.writeFile(path.join(mediaDir, fileName), upload.buffer);
      coverEntry = {
        fileName,
        sha256,
        alt: (upload.alt ?? '').trim() || project.cover?.alt || project.title,
        size: upload.buffer.length,
      };
    }

    // 2) 截图：保留的、新增的
    const shotEntries: MediaEntry[] = [];
    for (const shot of keptShots) {
      shotEntries.push({
        fileName: shot.fileName,
        sha256: shot.sha256,
        alt: shot.alt,
        size: await fileSize(path.join(mediaDir, shot.fileName)),
      });
    }
    for (const upload of adds) {
      const { ext } = sniffImage(upload.buffer);
      const sha256 = sha256Buffer(upload.buffer);
      const index = shotEntries.length + 1;
      const fileName = `shot-${String(index).padStart(2, '0')}-${sha256.slice(0, 10)}${ext}`;
      await fs.promises.writeFile(path.join(mediaDir, fileName), upload.buffer);
      shotEntries.push({
        fileName,
        sha256,
        alt: (upload.alt ?? '').trim() || `${project.title} 截图 ${index}`,
        size: upload.buffer.length,
      });
    }

    // 3) 删掉已经没有任何引用的图片文件
    const used = new Set<string>();
    if (coverEntry) used.add(coverEntry.fileName);
    for (const shot of shotEntries) used.add(shot.fileName);
    for (const entry of await fs.promises.readdir(mediaDir)) {
      if (!used.has(entry)) await fs.promises.rm(path.join(mediaDir, entry), { force: true });
    }

    // 4) 重写 release.json（web / downloads 沿用复制过来的记录）
    let releaseDoc: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(path.join(stagingDir, 'release.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        releaseDoc = parsed as Record<string, unknown>;
      }
    } catch {
      // 没有 release.json 时按最小结构重写
    }
    const nextReleaseDoc = {
      ...releaseDoc,
      schemaVersion: 1,
      releaseId,
      slug,
      createdAt: nowIso,
      media: [
        ...(coverEntry ? [{ role: 'cover', ...coverEntry }] : []),
        ...shotEntries.map((entry) => ({ role: 'shot', ...entry })),
      ],
    };
    await fs.promises.writeFile(path.join(stagingDir, 'release.json'), `${JSON.stringify(nextReleaseDoc, null, 2)}\n`, 'utf8');

    const targetDir = releaseDirOf(config.dataDir, slug, releaseId);
    await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.promises.rename(stagingDir, targetDir);
    renamed = true;

    const toAsset = (entry: MediaEntry): MediaAsset => ({
      url: `/media/${slug}/r/${releaseId}/${entry.fileName}`,
      alt: entry.alt,
      releaseId,
      fileName: entry.fileName,
      sha256: entry.sha256,
      width: null,
      height: null,
    });

    const updated: StoredProject = {
      ...project,
      cover: coverEntry ? toAsset(coverEntry) : null,
      screenshots: shotEntries.map(toAsset),
      updatedAt: nowIso,
      // 媒体变了，指纹必须失效，否则后续再 publish 同一份 manifest 会被误判成「内容没变」
      lastFingerprint: null,
      releaseHistory: [
        ...project.releaseHistory,
        {
          releaseId,
          createdAt: nowIso,
          parts: ['media'] as ReleasePart[],
          fingerprint: sha256Buffer(Buffer.from(`${coverEntry?.sha256 ?? ''}|${shotEntries.map((item) => item.sha256).join(',')}`)),
        },
      ].slice(-50),
    };

    await appendHistory(config.dataDir, slug, 'media', updated, releaseId, nowIso);
    await commit(config.dataDir, catalog, updated);

    return {
      ok: true,
      slug,
      releaseId,
      catalogRevision: catalog.revision + 1,
      cover: updated.cover,
      screenshots: updated.screenshots,
      message: `项目 ${slug} 的图片已更新（新版本 ${releaseId}，catalog revision ${catalog.revision + 1}）。`,
    };
  } finally {
    if (stagingDir && !renamed) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await lock.release();
  }
}

async function fileSize(target: string): Promise<number> {
  try {
    return (await fs.promises.stat(target)).size;
  } catch {
    return 0;
  }
}
