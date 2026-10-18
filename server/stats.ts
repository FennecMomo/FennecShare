import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.js';
import type { ProjectStats } from '../shared/types.js';

export type StatsEventType = 'play_click' | 'share_click' | 'download';

export interface StatsEvent {
  /** ISO 时间。 */
  at: string;
  type: StatsEventType;
  slug: string;
  /** 仅下载事件：windows / android / html ... */
  platform?: string;
  /** 来源：card / dialog / play / download，用于粗略区分入口。 */
  source?: string;
}

export interface DayBucket {
  date: string;
  playClicks: number;
  shareClicks: number;
  downloads: number;
}

export interface StatsSummary {
  generatedAt: string;
  days: number;
  totals: {
    playClicks: number;
    shareClicks: number;
    downloads: number;
    events: number;
  };
  byProject: Record<string, ProjectStats & { lastEventAt: string | null }>;
  byPlatform: Record<string, number>;
  byDay: DayBucket[];
  lastEventAt: string | null;
  /** 数据文件大小与事件条数，方便判断是否需要清理。 */
  storage: { file: string; bytes: number };
}

const EMPTY_PROJECT_STATS: ProjectStats = { playClicks: 0, shareClicks: 0, downloads: 0 };
const MAX_EVENTS_PER_FILE = 200_000;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 埋点存储：一行一个 JSON 追加到 `DATA_DIR/stats/events.jsonl`。
 *
 * - 只记「事件 + 项目 + 平台」，不记 IP、不记 UA、不落 cookie；
 * - 进程内维护聚合，读接口是 O(1)，不回扫文件；
 * - 写入串行化，单进程内不会交错；
 * - 文件按行追加，坏了行就跳过，不会因为一行坏数据丢全部统计。
 */
export class StatsStore {
  private readonly filePath: string;
  private readonly dirPath: string;
  private totals = { playClicks: 0, shareClicks: 0, downloads: 0, events: 0 };
  private byProject = new Map<string, ProjectStats>();
  private byPlatform = new Map<string, number>();
  private byDay = new Map<string, DayBucket>();
  private lastEventAt: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;
  private fileBytes = 0;
  /** 每个会话窗口内的简单计数，用来挡刷量。 */
  private readonly recent = new Map<string, { count: number; resetAt: number }>();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.dirPath = path.join(dataDir, 'stats');
    this.filePath = path.join(this.dirPath, 'events.jsonl');
  }

  private loadPromise: Promise<void> | null = null;

  /** 首次使用时加载一次；之后直接复用同一个 Promise。 */
  ready(): Promise<void> {
    this.loadPromise ??= this.load();
    return this.loadPromise;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      const stat = await fs.promises.stat(this.filePath);
      this.fileBytes = stat.size;
      text = await fs.promises.readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as StatsEvent;
        if (!parsed || typeof parsed.at !== 'string' || typeof parsed.slug !== 'string') {
          skipped += 1;
          continue;
        }
        this.apply(parsed);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) this.logger.warn('埋点文件里有无法解析的行，已跳过', { skipped, file: this.filePath });
  }

  /** 简单限流：同一 key（IP）每分钟最多 N 次，避免被脚本刷爆文件。 */
  allow(key: string, limit = 120, windowMs = 60_000): boolean {
    const now = Date.now();
    const entry = this.recent.get(key);
    if (!entry || entry.resetAt <= now) {
      this.recent.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  record(event: StatsEvent): void {
    this.apply(event);
    this.queue = this.queue
      .then(async () => {
        await fs.promises.mkdir(this.dirPath, { recursive: true });
        const line = `${JSON.stringify(event)}\n`;
        await fs.promises.appendFile(this.filePath, line, 'utf8');
        this.fileBytes += Buffer.byteLength(line);
      })
      .catch((error: unknown) => {
        this.logger.error('埋点写入失败', { error: String(error) });
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  projectStats(slug: string): ProjectStats {
    return { ...(this.byProject.get(slug) ?? EMPTY_PROJECT_STATS) };
  }

  allProjectStats(): Map<string, ProjectStats> {
    const result = new Map<string, ProjectStats>();
    for (const [slug, stats] of this.byProject) result.set(slug, { ...stats });
    return result;
  }

  summary(days = 14): StatsSummary {
    const window = Math.max(1, Math.min(90, Math.floor(days)));
    const today = new Date();
    const buckets: DayBucket[] = [];
    for (let offset = window - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      const key = dayKey(date.toISOString());
      buckets.push(this.byDay.get(key) ?? { date: key, playClicks: 0, shareClicks: 0, downloads: 0 });
    }

    const byProject: StatsSummary['byProject'] = {};
    for (const [slug, stats] of this.byProject) {
      const last = this.lastEventByProject.get(slug) ?? null;
      byProject[slug] = { ...stats, lastEventAt: last };
    }

    return {
      generatedAt: new Date().toISOString(),
      days: window,
      totals: { ...this.totals },
      byProject,
      byPlatform: Object.fromEntries([...this.byPlatform.entries()].sort((a, b) => b[1] - a[1])),
      byDay: buckets,
      lastEventAt: this.lastEventAt,
      storage: { file: this.filePath, bytes: this.fileBytes },
    };
  }

  private readonly lastEventByProject = new Map<string, string>();

  private apply(event: StatsEvent): void {
    const stats = this.byProject.get(event.slug) ?? { ...EMPTY_PROJECT_STATS };
    if (event.type === 'play_click') {
      stats.playClicks += 1;
      this.totals.playClicks += 1;
    } else if (event.type === 'share_click') {
      stats.shareClicks += 1;
      this.totals.shareClicks += 1;
    } else if (event.type === 'download') {
      stats.downloads += 1;
      this.totals.downloads += 1;
      const platform = event.platform ?? 'other';
      this.byPlatform.set(platform, (this.byPlatform.get(platform) ?? 0) + 1);
    } else {
      return;
    }
    this.totals.events += 1;
    this.byProject.set(event.slug, stats);
    this.lastEventByProject.set(event.slug, event.at);
    if (!this.lastEventAt || event.at > this.lastEventAt) this.lastEventAt = event.at;

    const key = dayKey(event.at);
    const bucket = this.byDay.get(key) ?? { date: key, playClicks: 0, shareClicks: 0, downloads: 0 };
    if (event.type === 'play_click') bucket.playClicks += 1;
    else if (event.type === 'share_click') bucket.shareClicks += 1;
    else bucket.downloads += 1;
    this.byDay.set(key, bucket);

    if (this.totals.events > MAX_EVENTS_PER_FILE) {
      this.logger.warn('埋点事件数量已超过建议上限，考虑归档 events.jsonl', {
        events: this.totals.events,
        file: this.filePath,
      });
    }
  }
}
