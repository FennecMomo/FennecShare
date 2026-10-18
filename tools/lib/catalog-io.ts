import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createEmptyCatalog, validateCatalog } from '../../shared/catalog.js';
import type { CatalogFile } from '../../shared/types.js';
import { PublishError } from './errors.js';

export function catalogPathOf(dataDir: string): string {
  return path.join(dataDir, 'catalog.json');
}

/** 读取 catalog：文件不存在时返回空 catalog；存在但不合法时直接报错，绝不静默清空。 */
export async function readCatalogFile(dataDir: string): Promise<CatalogFile> {
  const catalogPath = catalogPathOf(dataDir);
  let text: string;
  try {
    text = await fs.promises.readFile(catalogPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyCatalog();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new PublishError('invalid_catalog', `catalog.json 不是合法 JSON：${String(error)}`);
  }

  const validated = validateCatalog(parsed);
  if (!validated.ok) {
    const details = validated.issues
      .slice(0, 10)
      .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
      .join('；');
    throw new PublishError('invalid_catalog', `catalog.json 结构校验失败：${details}`, validated.issues);
  }
  return validated.catalog;
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.promises.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 某些文件系统不支持目录 fsync，忽略即可
  }
}

export interface WriteCatalogOptions {
  backup?: boolean;
  keepBackups?: number;
}

/**
 * 原子替换 catalog.json：
 * 先写同目录临时文件并 fsync，再 rename 覆盖，最后 fsync 目录。
 * 任一步骤失败都不会破坏现有 catalog。
 */
export async function writeCatalogAtomic(
  dataDir: string,
  catalog: CatalogFile,
  options: WriteCatalogOptions = {},
): Promise<void> {
  const catalogPath = catalogPathOf(dataDir);
  const backup = options.backup ?? true;
  const keepBackups = options.keepBackups ?? 30;

  if (backup) {
    const existing = await fs.promises.readFile(catalogPath, 'utf8').catch(() => null);
    if (existing !== null) {
      const parsed = JSON.parse(existing) as { revision?: unknown };
      const revision = typeof parsed.revision === 'number' ? parsed.revision : 0;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(dataDir, 'backups', `catalog-rev${revision}-${stamp}.json`);
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.writeFile(backupPath, existing, 'utf8');
      await pruneBackups(dataDir, keepBackups);
    }
  }

  const tempPath = path.join(dataDir, `.catalog-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  await fs.promises.writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await fsyncFile(tempPath);

  try {
    await fs.promises.rename(tempPath, catalogPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
  await fsyncDir(dataDir);
}

async function pruneBackups(dataDir: string, keep: number): Promise<void> {
  const dir = path.join(dataDir, 'backups');
  const files = (await fs.promises.readdir(dir).catch(() => []))
    .filter((name) => name.startsWith('catalog-') && name.endsWith('.json'))
    .sort();
  const excess = files.length - keep;
  if (excess <= 0) return;
  for (const name of files.slice(0, excess)) {
    await fs.promises.rm(path.join(dir, name), { force: true });
  }
}

export async function listCatalogBackups(dataDir: string): Promise<string[]> {
  const dir = path.join(dataDir, 'backups');
  const names = await fs.promises.readdir(dir).catch(() => []);
  return names.filter((name) => name.startsWith('catalog-') && name.endsWith('.json')).sort();
}
