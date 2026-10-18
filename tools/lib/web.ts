import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findProject } from '../../shared/catalog.js';
import type { StoredProject } from '../../shared/types.js';
import type { PublisherConfig } from '../../server/config.js';
import { acquireDataLock, ensureDataLayout } from './lock.js';
import { readCatalogFile } from './catalog-io.js';
import { appendHistory } from './history.js';
import { commit } from './manage.js';
import { PublishError } from './errors.js';
import type { ReleasePart } from './publish.js';
import { hashDirectory, sha256Buffer } from './hash.js';
import { loadLimits } from './manifest.js';
import { copyDirectorySafely, detectWebRoot, extractZipSafely } from './package.js';

export interface WebUploadInput {
  /** 上传时的原始文件名，用于单文件 HTML 的入口命名。 */
  fileName: string;
  buffer: Buffer;
}

export interface WebUpdateResult {
  ok: true;
  slug: string;
  releaseId: string;
  entry: string;
  revision: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
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

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt8(0) === 0x50 && buffer.readUInt8(1) === 0x4b;
}

function looksLikeHtml(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').toLowerCase();
  if (head.includes('\0')) return false;
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('<head') || head.includes('<body');
}

/** 单文件 HTML 的入口名：保留原文件名，只做必要的清洗。 */
export function safeEntryName(fileName: string): string {
  const base = path.basename(fileName ?? '').trim();
  const cleaned = base.replace(/[\\/:*?"<>|\0\r\n\t]+/g, '_').slice(0, 80);
  if (!/\.html?$/i.test(cleaned)) {
    const stem = cleaned.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]+/g, '_') || 'index';
    return `${stem}.html`;
  }
  return cleaned;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 上传试玩包：支持单个 .html 文件，也支持 ZIP（自动找入口）。
 *
 * 规则和发布 CLI 一致：新版本目录 = 复制当前版本（保留 downloads 与旧 web 文件的历史），
 * 然后整体替换 web/，最后原子替换 catalog。旧版本目录不删除，回滚随时可用。
 */
export async function updateProjectWeb(
  config: PublisherConfig,
  slug: string,
  input: WebUploadInput,
): Promise<WebUpdateResult> {
  const limits = loadLimits();
  const buffer = input.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PublishError('invalid_upload', '上传内容为空');
  }

  const zip = isZip(buffer);
  if (!zip) {
    if (!looksLikeHtml(buffer)) {
      throw new PublishError('invalid_upload', '只接受 .html 文件或 ZIP 包（单文件 HTML 需要包含 <html>/<body> 等标签）');
    }
    if (buffer.length > limits.maxEntryBytes) {
      throw new PublishError('invalid_upload', `HTML 文件过大：${buffer.length} 字节`);
    }
  } else if (buffer.length > limits.maxZipBytes) {
    throw new PublishError('invalid_upload', `ZIP 包过大：${buffer.length} 字节`);
  }

  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `web ${slug}`);
  let workDir: string | null = null;
  let stagingDir: string | null = null;
  let renamed = false;

  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);

    const now = new Date();
    const nowIso = now.toISOString();
    const releaseId = nextReleaseId(config.dataDir, slug, now);
    const warnings: string[] = [];

    let entry: string;
    let sourceWebRoot: string | null = null;

    if (zip) {
      workDir = path.join(config.dataDir, 'staging', `web-${slug}-${randomBytes(4).toString('hex')}`);
      await fs.promises.mkdir(workDir, { recursive: true });
      const zipPath = path.join(workDir, 'upload.zip');
      await fs.promises.writeFile(zipPath, buffer);
      const extractDir = path.join(workDir, 'extract');
      const extracted = await extractZipSafely(zipPath, extractDir, limits);
      warnings.push(...extracted.warnings);
      const info = await detectWebRoot(extractDir, null, limits);
      warnings.push(...info.warnings);
      sourceWebRoot = info.webRoot;
      entry = info.entry;
    } else {
      entry = safeEntryName(input.fileName);
    }

    stagingDir = path.join(config.dataDir, 'staging', `rel-${slug}-${randomBytes(4).toString('hex')}`);
    const sourceReleaseId =
      project.web?.releaseId ??
      project.downloads[0]?.releaseId ??
      project.cover?.releaseId ??
      project.screenshots[0]?.releaseId ??
      null;
    const sourceDir = sourceReleaseId ? releaseDirOf(config.dataDir, slug, sourceReleaseId) : null;
    if (sourceDir && (await exists(sourceDir))) {
      await fs.promises.cp(sourceDir, stagingDir, { recursive: true });
    } else {
      await fs.promises.mkdir(stagingDir, { recursive: true });
    }

    const webDir = path.join(stagingDir, 'web');
    await fs.promises.rm(webDir, { recursive: true, force: true });
    await fs.promises.mkdir(webDir, { recursive: true });
    if (sourceWebRoot) {
      const copied = await copyDirectorySafely(sourceWebRoot, webDir, limits);
      warnings.push(...copied.warnings);
    } else {
      await fs.promises.writeFile(path.join(webDir, entry), buffer);
    }

    const hashed = await hashDirectory(webDir);
    const contentHash = sha256Buffer(Buffer.from(JSON.stringify(hashed.files), 'utf8'));

    // 更新 release.json（保留 downloads / media 等既有记录）
    let releaseDoc: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(path.join(stagingDir, 'release.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) releaseDoc = parsed as Record<string, unknown>;
    } catch {
      // 没有就按最小结构重写
    }
    const nextReleaseDoc = {
      ...releaseDoc,
      schemaVersion: 1,
      releaseId,
      slug,
      createdAt: nowIso,
      web: { entry, spaFallback: false, contentHash, fileCount: hashed.files.length, totalBytes: hashed.totalBytes },
    };
    await fs.promises.writeFile(path.join(stagingDir, 'release.json'), `${JSON.stringify(nextReleaseDoc, null, 2)}\n`, 'utf8');

    const targetDir = releaseDirOf(config.dataDir, slug, releaseId);
    await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.promises.rename(stagingDir, targetDir);
    renamed = true;

    const web = {
      releaseId,
      entry,
      publicUrl: `/play/${slug}/`,
      spaFallback: false,
      contentHash,
      publishedAt: nowIso,
    };
    const updated: StoredProject = {
      ...project,
      web,
      updatedAt: nowIso,
      lastFingerprint: null,
      releaseHistory: [
        ...project.releaseHistory,
        { releaseId, createdAt: nowIso, parts: ['web'] as ReleasePart[], fingerprint: contentHash },
      ].slice(-50),
    };

    await appendHistory(config.dataDir, slug, 'web', updated, releaseId, nowIso);
    await commit(config.dataDir, catalog, updated);

    return {
      ok: true,
      slug,
      releaseId,
      entry,
      revision: catalog.revision + 1,
      fileCount: hashed.files.length,
      totalBytes: hashed.totalBytes,
      warnings,
      message: `试玩包已发布（新版本 ${releaseId}，入口 ${entry}，${hashed.files.length} 个文件）。`,
    };
  } finally {
    if (stagingDir && !renamed) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await lock.release();
  }
}

/** 管理页面用：清掉试玩包（保留其他内容）。 */
export async function clearProjectWeb(config: PublisherConfig, slug: string): Promise<{ revision: number }> {
  await ensureDataLayout(config.dataDir);
  const lock = await acquireDataLock(config.dataDir, `web-clear ${slug}`);
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const project = findProject(catalog, slug);
    if (!project) throw new PublishError('project_not_found', `项目不存在：${slug}`);
    if (!project.web) return { revision: catalog.revision };
    const nowIso = new Date().toISOString();
    const updated: StoredProject = {
      ...project,
      web: null,
      updatedAt: nowIso,
      releaseHistory: [...project.releaseHistory, { releaseId: null, createdAt: nowIso, parts: ['web'] as ReleasePart[], fingerprint: 'cleared' }].slice(-50),
    };
    await appendHistory(config.dataDir, slug, 'web', updated, null, nowIso);
    await commit(config.dataDir, catalog, updated);
    return { revision: catalog.revision + 1 };
  } finally {
    await lock.release();
  }
}
