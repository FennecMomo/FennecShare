/**
 * 展示站与发布工具共享的数据模型。
 *
 * 约定：
 * - 这里只有“可公开”字段和“数据目录内相对路径”字段，任何绝对路径都不进入 catalog。
 * - slug 是稳定标识，一旦发布就不再变化；标题可以改，链接不变。
 */

export const CATALOG_SCHEMA_VERSION = 1;

export const CATEGORIES = ['web', 'desktop', 'mobile'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  web: '网页',
  desktop: '桌面应用',
  mobile: '手机APP',
};

export const PLATFORMS = ['windows', 'android', 'html', 'linux', 'macos', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  windows: 'Windows',
  android: 'Android',
  html: '网页包',
  linux: 'Linux',
  macos: 'macOS',
  other: '其他',
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 64;

/** 一张图片（封面或截图）。url 为同源相对路径，带 releaseId，可长期缓存。 */
export interface MediaAsset {
  url: string;
  alt: string;
  /** 引入该图片的发布版本，用于拼出不可变 URL。 */
  releaseId: string;
  fileName: string;
  /** 图片内容的 SHA-256，用于识别重复发布。 */
  sha256: string;
  width: number | null;
  height: number | null;
}

/** 在线体验信息。 */
export interface WebRelease {
  releaseId: string;
  /** 相对发布 web 根目录的入口文件，例如 index.html。 */
  entry: string;
  /** 对外稳定入口，始终是 /play/<slug>/。 */
  publicUrl: string;
  /** 是否为项目启用了 SPA history fallback（默认关闭）。 */
  spaFallback: boolean;
  /** 发布内容整体指纹（文件路径 + 大小 + 哈希），用于识别重复发布。 */
  contentHash: string;
  publishedAt: string;
}

/** 一条下载记录（公开字段）。 */
export interface PublicDownload {
  id: string;
  fileName: string;
  platform: Platform;
  version: string | null;
  size: number;
  sha256: string;
  contentType: string;
  publicUrl: string;
  releaseId: string;
  isDefault: boolean;
}

/** 仅存在于数据目录 catalog 中的下载记录，storage 是相对 DATA_DIR 的路径。 */
export interface StoredDownload extends PublicDownload {
  storage: string;
}

export interface ReleaseHistoryEntry {
  /** 只改元信息时不会创建版本目录，此时为 null。 */
  releaseId: string | null;
  createdAt: string;
  /** 本次发布实际更新的内容类型。 */
  parts: Array<'web' | 'media' | 'downloads' | 'meta'>;
  fingerprint: string;
}

/** catalog 中保存的完整项目记录（包含仅供发布工具使用的内部字段）。 */
export interface StoredProject {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  categories: Category[];
  cover: MediaAsset | null;
  screenshots: MediaAsset[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  displayVersion: string | null;
  sortOrder: number;
  published: boolean;
  demo: boolean;
  web: WebRelease | null;
  downloads: StoredDownload[];
  releaseHistory: ReleaseHistoryEntry[];
  /** 最近一次发布内容的指纹，用于识别重复提交。 */
  lastFingerprint: string | null;
  unpublishReason: string | null;
}

/** 公开 API 返回的项目（不含 storage 等内部字段）。 */
export interface PublicProject {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  categories: Category[];
  cover: MediaAsset | null;
  screenshots: MediaAsset[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  displayVersion: string | null;
  sortOrder: number;
  published: boolean;
  demo: boolean;
  web: WebRelease | null;
  downloads: PublicDownload[];
}

export interface CatalogFile {
  schemaVersion: number;
  revision: number;
  generatedAt: string;
  projects: StoredProject[];
}

export interface PublicCatalogResponse {
  schemaVersion: number;
  revision: number;
  generatedAt: string;
  serverTime: string;
  projects: PublicProject[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
