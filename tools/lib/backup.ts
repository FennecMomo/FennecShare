import fs from 'node:fs';
import path from 'node:path';
import { validateCatalog } from '../../shared/catalog.js';
import { isPathInside, resolveWithin } from '../../shared/paths.js';
import type { PublisherConfig } from '../../server/config.js';
import { sha256File } from './hash.js';
import { acquireDataLock } from './lock.js';
import { readCatalogFile, writeCatalogAtomic } from './catalog-io.js';
import { PublishError } from './errors.js';

const BACKUP_MANIFEST = 'backup-manifest.json';
const SKIP_TOP_LEVEL = new Set(['staging', 'backups', '.publish.lock']);

export interface BackupResult {
  ok: true;
  path: string;
  createdAt: string;
  catalogRevision: number;
  projectCount: number;
  fileCount: number;
  totalBytes: number;
  message: string;
}

interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

interface BackupManifest {
  schemaVersion: 1;
  createdAt: string;
  catalogRevision: number;
  projectCount: number;
  files: BackupFile[];
}

/**
 * 备份 catalog 及其引用的全部文件（projects/**，含 history 快照）。
 * 备份期间持有与发布相同的写锁，避免拿到“写了一半”的目录。
 * 备份目录里额外写一份带 SHA-256 的清单，恢复时逐文件校验。
 */
export async function backupData(
  config: PublisherConfig,
  options: { out?: string } = {},
): Promise<BackupResult> {
  const lock = await acquireDataLock(config.dataDir, 'backup');
  try {
    const catalog = await readCatalogFile(config.dataDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetRoot = options.out ? path.resolve(options.out) : path.join(config.dataDir, 'backups');
    const backupDir = path.join(targetRoot, `fennec-share-backup-${stamp}`);
    await fs.promises.mkdir(backupDir, { recursive: true });

    const files: BackupFile[] = [];
    let totalBytes = 0;

    const copyOne = async (from: string, relative: string): Promise<void> => {
      const to = resolveWithin(backupDir, relative);
      if (!to) throw new PublishError('backup_failed', `备份路径越界：${relative}`);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(from, to);
      const stat = await fs.promises.stat(to);
      const sha256 = await sha256File(to);
      files.push({ path: relative.split(path.sep).join('/'), size: stat.size, sha256 });
      totalBytes += stat.size;
    };

    const catalogFile = path.join(config.dataDir, 'catalog.json');
    if (fs.existsSync(catalogFile)) {
      await copyOne(catalogFile, 'catalog.json');
    }

    const projectsRoot = path.join(config.dataDir, 'projects');
    const projectEntries = await fs.promises.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    let projectCount = 0;
    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue;
      projectCount += 1;
      const projectRoot = path.join(projectsRoot, entry.name);
      const walk = async (current: string): Promise<void> => {
        const children = await fs.promises.readdir(current, { withFileTypes: true });
        for (const child of children) {
          const absolute = path.join(current, child.name);
          if (child.isDirectory()) {
            await walk(absolute);
          } else if (child.isFile()) {
            const relative = path.relative(config.dataDir, absolute);
            if (SKIP_TOP_LEVEL.has(relative.split(path.sep)[0] ?? '')) continue;
            await copyOne(absolute, relative);
          } else {
            throw new PublishError('backup_failed', `数据目录里存在不支持的文件类型：${absolute}`);
          }
        }
      };
      await walk(projectRoot);
    }

    // 埋点文件也一起备份（不备份 admin/ 下的密码派生值：那是独立的凭据，不该跟着数据回滚）
    const statsFile = path.join(config.dataDir, 'stats', 'events.jsonl');
    if (fs.existsSync(statsFile)) {
      await copyOne(statsFile, path.join('stats', 'events.jsonl'));
    }

    const manifest: BackupManifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      catalogRevision: catalog.revision,
      projectCount,
      files,
    };
    await fs.promises.writeFile(
      path.join(backupDir, BACKUP_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    return {
      ok: true,
      path: backupDir,
      createdAt: manifest.createdAt,
      catalogRevision: catalog.revision,
      projectCount,
      fileCount: files.length,
      totalBytes,
      message: `备份完成：${files.length} 个文件，共 ${totalBytes} 字节，输出到 ${backupDir}`,
    };
  } finally {
    await lock.release();
  }
}

export interface RestoreResult {
  ok: true;
  status: 'restored' | 'verified';
  from: string;
  fileCount: number;
  totalBytes: number;
  catalogRevision: number;
  message: string;
}

/**
 * 从备份目录恢复：先逐文件校验大小与 SHA-256，全部通过后才写入。
 * 写入顺序：先普通文件，最后原子替换 catalog.json（一致性切换点）。
 * 注意：恢复是“覆盖 + 保留多余文件”，不会删除备份里没有的现有文件。
 */
export async function restoreData(
  config: PublisherConfig,
  options: { from: string; dryRun?: boolean },
): Promise<RestoreResult> {
  const backupDir = path.resolve(options.from);
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch (error) {
    throw new PublishError('invalid_backup', `无法读取备份清单 ${manifestPath}：${String(error)}`);
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new PublishError('invalid_backup', `备份清单格式不支持（schemaVersion=${String(manifest.schemaVersion)}）`);
  }

  let totalBytes = 0;
  for (const file of manifest.files) {
    const source = resolveWithin(backupDir, file.path);
    if (!source) throw new PublishError('invalid_backup', `备份清单里存在越界路径：${file.path}`);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      throw new PublishError('invalid_backup', `备份缺少文件：${file.path}`);
    }
    if (stat.size !== file.size) {
      throw new PublishError('invalid_backup', `备份文件大小不符：${file.path}（期望 ${file.size}，实际 ${stat.size}）`);
    }
    const sha256 = await sha256File(source);
    if (sha256 !== file.sha256) {
      throw new PublishError('invalid_backup', `备份文件校验失败：${file.path}（SHA-256 不匹配）`);
    }
    totalBytes += stat.size;
  }

  const catalogFile = manifest.files.find((file) => file.path === 'catalog.json');
  if (!catalogFile) {
    throw new PublishError('invalid_backup', '备份清单里没有 catalog.json');
  }
  const catalogSource = path.join(backupDir, 'catalog.json');
  const catalogParsed = JSON.parse(await fs.promises.readFile(catalogSource, 'utf8')) as unknown;
  const validated = validateCatalog(catalogParsed);
  if (!validated.ok) {
    throw new PublishError('invalid_backup', '备份中的 catalog.json 结构不合法，拒绝恢复');
  }

  if (options.dryRun) {
    return {
      ok: true,
      status: 'verified',
      from: backupDir,
      fileCount: manifest.files.length,
      totalBytes,
      catalogRevision: validated.catalog.revision,
      message: `备份校验通过（${manifest.files.length} 个文件），未写入任何内容。`,
    };
  }

  const lock = await acquireDataLock(config.dataDir, 'restore');
  try {
    await fs.promises.mkdir(config.dataDir, { recursive: true });
    for (const file of manifest.files) {
      if (file.path === 'catalog.json') continue;
      const source = resolveWithin(backupDir, file.path);
      if (!source) throw new PublishError('invalid_backup', `备份清单里存在越界路径：${file.path}`);
      const target = resolveWithin(config.dataDir, file.path);
      if (!target || !isPathInside(config.dataDir, target)) {
        throw new PublishError('invalid_backup', `目标路径越界：${file.path}`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(source, target);
    }
    // 最后一个动作：原子替换 catalog（会在 backups/ 里自动留下恢复前的 catalog）
    await writeCatalogAtomic(config.dataDir, validated.catalog);

    return {
      ok: true,
      status: 'restored',
      from: backupDir,
      fileCount: manifest.files.length,
      totalBytes,
      catalogRevision: validated.catalog.revision,
      message: `恢复完成：${manifest.files.length} 个文件，catalog revision ${validated.catalog.revision}。备份里没有的现有文件不会被删除。`,
    };
  } finally {
    await lock.release();
  }
}

export interface CleanupResult {
  ok: true;
  removed: string[];
  message: string;
}

/** 清理 staging 残留（默认只清理 1 小时前的）。不会碰 releases/ 和 backups/。 */
export async function cleanupStaging(
  config: PublisherConfig,
  options: { olderThanHours?: number } = {},
): Promise<CleanupResult> {
  const stagingRoot = path.join(config.dataDir, 'staging');
  const olderThanMs = (options.olderThanHours ?? 1) * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  const now = Date.now();
  for (const entry of entries) {
    const absolute = path.join(stagingRoot, entry.name);
    const stat = await fs.promises.stat(absolute).catch(() => null);
    if (!stat) continue;
    if (now - stat.mtimeMs < olderThanMs) continue;
    await fs.promises.rm(absolute, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return {
    ok: true,
    removed,
    message: removed.length === 0 ? '没有需要清理的 staging 残留。' : `已清理 ${removed.length} 个 staging 残留。`,
  };
}
