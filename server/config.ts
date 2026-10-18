import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  /** 发布数据的根目录（绝对路径）。项目资源只通过明确路由暴露。 */
  dataDir: string;
  /** 前端构建产物目录（dist/web）。 */
  webDistDir: string;
  /** 可选：对外站点根地址，仅用于发布工具输出绝对 URL，不参与请求路由。 */
  publicBaseUrl: string | null;
  logLevel: string;
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 找到前端构建产物目录。
 * 编译后本文件位于 dist/server/，构建产物在 dist/web/；
 * 开发期用 tsx 直接跑源码时，回退到 <repo>/dist/web。
 */
function findWebDistDir(): string {
  const candidates = [
    process.env.WEB_DIST_DIR,
    path.resolve(thisDir, '..', 'web'),
    path.resolve(thisDir, '..', '..', 'dist', 'web'),
    path.resolve(process.cwd(), 'dist', 'web'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'index.html')).isFile()) return candidate;
    } catch {
      // 继续尝试下一个候选目录
    }
  }
  return candidates[0] ?? path.resolve(process.cwd(), 'dist', 'web');
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数，当前值：${raw}`);
  }
  return value;
}

function readString(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDirRaw = readString(env.DATA_DIR, path.resolve(process.cwd(), 'data'));
  const publicBaseUrlRaw = env.PUBLIC_BASE_URL?.trim();
  return {
    host: readString(env.HOST, '127.0.0.1'),
    port: readPort(env.PORT, 8787),
    dataDir: path.resolve(dataDirRaw),
    webDistDir: findWebDistDir(),
    publicBaseUrl: publicBaseUrlRaw ? publicBaseUrlRaw.replace(/\/+$/, '') : null,
    logLevel: readString(env.LOG_LEVEL, 'info').toLowerCase(),
  };
}

/** 发布工具使用的配置：与服务器共享 DATA_DIR / PUBLIC_BASE_URL。 */
export interface PublisherConfig {
  dataDir: string;
  publicBaseUrl: string | null;
  logLevel: string;
}

export function loadPublisherConfig(env: NodeJS.ProcessEnv = process.env): PublisherConfig {
  const dataDirRaw = readString(env.DATA_DIR, path.resolve(process.cwd(), 'data'));
  const publicBaseUrlRaw = env.PUBLIC_BASE_URL?.trim();
  return {
    dataDir: path.resolve(dataDirRaw),
    publicBaseUrl: publicBaseUrlRaw ? publicBaseUrlRaw.replace(/\/+$/, '') : null,
    logLevel: readString(env.LOG_LEVEL, 'info').toLowerCase(),
  };
}
