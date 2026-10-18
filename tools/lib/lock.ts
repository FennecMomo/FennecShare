import fs from 'node:fs';
import path from 'node:path';
import { PublishError } from './errors.js';

export interface DataLock {
  lockPath: string;
  release: () => Promise<void>;
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 * 发布写锁：用 O_CREAT|O_EXCL 原子创建锁文件。
 * 同一时刻只允许一个 publish/unpublish/rollback/backup/restore 操作修改数据目录；
 * 并发调用会排队等待（默认最多 30 秒）而不是直接失败，避免误报“正在发布”。
 * 锁文件超过 15 分钟（或进程已不存在）视为残留，可被安全回收。
 */
export async function acquireDataLock(
  dataDir: string,
  purpose: string,
  options: { staleMs?: number; waitMs?: number } = {},
): Promise<DataLock> {
  const lockPath = path.join(dataDir, '.publish.lock');
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  await fs.promises.mkdir(dataDir, { recursive: true });

  for (;;) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, purpose, startedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      await handle.close();
      let released = false;
      return {
        lockPath,
        release: async () => {
          if (released) return;
          released = true;
          await fs.promises.rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const stat = await fs.promises.stat(lockPath).catch(() => null);
      let holderPid: number | null = null;
      try {
        const text = await fs.promises.readFile(lockPath, 'utf8');
        const parsed = JSON.parse(text) as { pid?: unknown };
        if (typeof parsed.pid === 'number') holderPid = parsed.pid;
      } catch {
        // 锁文件内容损坏时按超时判断
      }

      const age = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
      const alive = holderPid !== null ? isProcessAlive(holderPid) : true;
      const stale = age > staleMs || (holderPid !== null && !alive);

      if (stale) {
        await fs.promises.rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new PublishError(
          'lock_busy',
          `另一个发布操作正在进行（${lockPath}，pid=${holderPid ?? '未知'}，已持续 ${Math.round(age / 1000)} 秒）。请等待它结束，或确认无进程在跑后删除该锁文件。`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function ensureDataLayout(dataDir: string): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.mkdir(path.join(dataDir, 'projects'), { recursive: true });
  await fs.promises.mkdir(path.join(dataDir, 'staging'), { recursive: true });
  await fs.promises.mkdir(path.join(dataDir, 'backups'), { recursive: true });
}
