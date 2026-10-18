import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset, StoredDownload, StoredProject, WebRelease } from '../../shared/types.js';

export type HistoryAction = 'publish' | 'unpublish' | 'rollback' | 'media' | 'meta';

/** 一次状态快照：足够把项目完整恢复到当时的样子。 */
export interface ProjectStateSnapshot {
  title: string;
  summary: string;
  description: string;
  categories: StoredProject['categories'];
  cover: MediaAsset | null;
  screenshots: MediaAsset[];
  displayVersion: string | null;
  sortOrder: number;
  published: boolean;
  publishedAt: string | null;
  demo: boolean;
  web: WebRelease | null;
  downloads: StoredDownload[];
  unpublishReason: string | null;
  lastFingerprint: string | null;
}

export interface HistoryEntry {
  seq: number;
  action: HistoryAction;
  at: string;
  releaseId: string | null;
  state: ProjectStateSnapshot;
  file: string;
}

export function projectState(project: StoredProject): ProjectStateSnapshot {
  return {
    title: project.title,
    summary: project.summary,
    description: project.description,
    categories: project.categories,
    cover: project.cover,
    screenshots: project.screenshots,
    displayVersion: project.displayVersion,
    sortOrder: project.sortOrder,
    published: project.published,
    publishedAt: project.publishedAt,
    demo: project.demo,
    web: project.web,
    downloads: project.downloads,
    unpublishReason: project.unpublishReason,
    lastFingerprint: project.lastFingerprint,
  };
}

export function applySnapshot(project: StoredProject, snapshot: ProjectStateSnapshot, at: string): StoredProject {
  return {
    ...project,
    title: snapshot.title,
    summary: snapshot.summary,
    description: snapshot.description,
    categories: snapshot.categories,
    cover: snapshot.cover,
    screenshots: snapshot.screenshots,
    displayVersion: snapshot.displayVersion,
    sortOrder: snapshot.sortOrder,
    published: snapshot.published,
    publishedAt: snapshot.publishedAt,
    demo: snapshot.demo,
    web: snapshot.web,
    downloads: snapshot.downloads,
    unpublishReason: snapshot.unpublishReason,
    lastFingerprint: snapshot.lastFingerprint,
    updatedAt: at,
  };
}

function historyDir(dataDir: string, slug: string): string {
  return path.join(dataDir, 'projects', slug, 'history');
}

export async function listHistory(dataDir: string, slug: string): Promise<HistoryEntry[]> {
  const dir = historyDir(dataDir, slug);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const entries: HistoryEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await fs.promises.readFile(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(text) as Omit<HistoryEntry, 'file'>;
      if (typeof parsed.seq === 'number' && parsed.state) {
        entries.push({ ...parsed, file: name });
      }
    } catch {
      // 损坏的快照跳过，不影响其它版本
    }
  }
  return entries;
}

export async function appendHistory(
  dataDir: string,
  slug: string,
  action: HistoryAction,
  project: StoredProject,
  releaseId: string | null,
  at: string,
): Promise<HistoryEntry> {
  const dir = historyDir(dataDir, slug);
  await fs.promises.mkdir(dir, { recursive: true });
  const existing = await listHistory(dataDir, slug);
  const seq = (existing[existing.length - 1]?.seq ?? 0) + 1;
  const fileName = `${String(seq).padStart(6, '0')}-${action}.json`;
  const entry: HistoryEntry = {
    seq,
    action,
    at,
    releaseId,
    state: projectState(project),
    file: fileName,
  };
  const tempPath = path.join(dir, `.${fileName}.tmp`);
  await fs.promises.writeFile(tempPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempPath, path.join(dir, fileName));
  return entry;
}
