import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyCatalog, validateCatalog } from '../shared/catalog.js';
import type { CatalogFile } from '../shared/types.js';
import type { Logger } from './logger.js';

/**
 * catalog 读取器。
 *
 * 需求要求“发布后不重启服务就能看到新内容”，所以不能只在启动时读一次。
 * 这里按 (mtimeMs, size) 判断是否变化：每次 API 请求都 stat 一次（很便宜），
 * 变了才重新读文件并校验；并发请求共享同一个读取 Promise，避免竞态。
 * 解析或校验失败时保留上一份可用数据，绝不把空列表冒充正常状态。
 */
export class CatalogStore {
  private readonly catalogPath: string;
  private cache: { mtimeMs: number; size: number; catalog: CatalogFile } | null = null;
  private inflight: Promise<CatalogFile> | null = null;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.catalogPath = path.join(dataDir, 'catalog.json');
  }

  get path(): string {
    return this.catalogPath;
  }

  async read(): Promise<CatalogFile> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async load(): Promise<CatalogFile> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = createEmptyCatalog();
        this.cache = { mtimeMs: 0, size: 0, catalog: empty };
        return empty;
      }
      throw error;
    }

    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.catalog;
    }

    const text = await fs.readFile(this.catalogPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      this.logger.error('catalog.json 解析失败', { error: String(error), usingLastGood: this.cache !== null });
      if (this.cache) return this.cache.catalog;
      throw new Error('catalog.json 不是合法 JSON');
    }

    const validated = validateCatalog(parsed);
    if (!validated.ok) {
      this.logger.error('catalog.json 结构校验失败', {
        issueCount: validated.issues.length,
        firstIssue: validated.issues[0]?.message ?? '',
        usingLastGood: this.cache !== null,
      });
      if (this.cache) return this.cache.catalog;
      throw new Error('catalog.json 结构校验失败');
    }

    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, catalog: validated.catalog };
    return validated.catalog;
  }
}
