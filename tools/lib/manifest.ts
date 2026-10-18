import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  SLUG_MAX_LENGTH,
  TAG_MAX_COUNT,
  TAG_MAX_LENGTH,
  type Category,
  type Platform,
} from '../../shared/types.js';
import { isCategory, isPlatform, isValidSlug, normalizeTagLabel } from '../../shared/catalog.js';
import { isSafeFileName } from '../../shared/paths.js';
import { PublishError } from './errors.js';

/** 缺省文案：明确告知“没有提供”，不描述任何不存在的功能。 */
export const DEFAULT_SUMMARY = '该项目暂未提供简介。';
export const DEFAULT_DESCRIPTION = '';

export interface ManifestMedia {
  sourcePath: string;
  alt: string;
  extension: string;
}

export interface ManifestWeb {
  kind: 'zip' | 'directory';
  sourcePath: string;
  /** 显式指定入口文件（相对包根目录）；不填则由工具探测唯一入口。 */
  entry: string | null;
  spaFallback: boolean;
}

export interface ManifestDownload {
  fileName: string;
  sourcePath: string;
  platform: Platform;
  version: string | null;
  isDefault: boolean;
  contentType: string | null;
  size: number;
}

export interface ResolvedManifest {
  manifestPath: string;
  manifestDir: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  categories: Category[];
  displayVersion: string | null;
  /** 标签（null 表示 manifest 没写，沿用项目现有标签）；会自动登记到 catalog.tags。 */
  tags: string[] | null;
  sortOrder: number;
  published: boolean;
  demo: boolean;
  /** undefined 表示保留原值；null 表示显式清除；对象表示替换。 */
  cover: ManifestMedia | null | undefined;
  screenshots: ManifestMedia[] | undefined;
  web: ManifestWeb | undefined;
  downloads: ManifestDownload[];
  removeDownloads: string[];
  warnings: string[];
  /** 是否由工具推导了 categories（用于提示 Hermes）。 */
  derivedCategories: boolean;
}

export interface PublishLimits {
  maxDownloadBytes: number;
  maxImageBytes: number;
  maxZipBytes: number;
  maxFiles: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  allowedDownloadExtensions: Set<string>;
}

const MIB = 1024 * 1024;

const DEFAULT_DOWNLOAD_EXTENSIONS = [
  '.exe',
  '.msi',
  '.msix',
  '.appx',
  '.apk',
  '.ipa',
  '.zip',
  '.7z',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.appimage',
  '.tar',
  '.gz',
  '.tgz',
  '.xz',
  '.zst',
  '.jar',
];

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg']);

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'slug',
  'title',
  'summary',
  'description',
  'categories',
  'displayVersion',
  'sortOrder',
  'published',
  'demo',
  'cover',
  'screenshots',
  'web',
  'downloads',
  'removeDownloads',
  'notes',
]);

function readNumberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PublishError('invalid_limits', `${key} 必须是正数，当前值：${raw}`);
  }
  return Math.floor(value);
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env): PublishLimits {
  const extra = (env.FH_PUBLISH_EXTRA_EXTENSIONS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));

  return {
    maxDownloadBytes: readNumberEnv(env, 'FH_PUBLISH_MAX_DOWNLOAD_BYTES', 4 * 1024 * MIB),
    maxImageBytes: readNumberEnv(env, 'FH_PUBLISH_MAX_IMAGE_BYTES', 12 * MIB),
    maxZipBytes: readNumberEnv(env, 'FH_PUBLISH_MAX_ZIP_BYTES', 2048 * MIB),
    maxFiles: readNumberEnv(env, 'FH_PUBLISH_MAX_FILES', 20000),
    maxUncompressedBytes: readNumberEnv(env, 'FH_PUBLISH_MAX_UNCOMPRESSED_BYTES', 4096 * MIB),
    maxEntryBytes: readNumberEnv(env, 'FH_PUBLISH_MAX_ENTRY_BYTES', 512 * MIB),
    allowedDownloadExtensions: new Set([...DEFAULT_DOWNLOAD_EXTENSIONS, ...extra]),
  };
}

function fail(issues: string[]): never {
  const text = issues.map((issue) => ` - ${issue}`).join('\n');
  throw new PublishError('manifest_invalid', `manifest 校验失败：\n${text}`, { issues });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function resolveSourceFile(manifestDir: string, rawPath: unknown, field: string, issues: string[]): string | null {
  const text = asString(rawPath);
  if (!text) {
    issues.push(`${field} 必须是非空字符串路径`);
    return null;
  }
  const absolute = path.isAbsolute(text) ? path.normalize(text) : path.resolve(manifestDir, text);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    issues.push(`${field} 指向的文件不存在：${text}`);
    return null;
  }
  if (!stat.isFile()) {
    issues.push(`${field} 必须指向文件：${text}`);
    return null;
  }
  return absolute;
}

function parseMedia(
  manifestDir: string,
  rawValue: unknown,
  field: string,
  defaultAlt: string,
  limits: PublishLimits,
  issues: string[],
): ManifestMedia | null {
  let rawPath: unknown = rawValue;
  let alt = defaultAlt;
  if (typeof rawValue === 'object' && rawValue !== null) {
    const obj = rawValue as Record<string, unknown>;
    rawPath = obj.path;
    if (typeof obj.alt === 'string' && obj.alt.trim().length > 0) alt = obj.alt.trim();
  }
  const absolute = resolveSourceFile(manifestDir, rawPath, `${field}.path`, issues);
  if (!absolute) return null;
  const extension = path.extname(absolute).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    issues.push(`${field} 只支持 ${[...IMAGE_EXTENSIONS].join('/')}，当前为 ${extension || '(无扩展名)'}`);
    return null;
  }
  const stat = fs.statSync(absolute);
  if (stat.size > limits.maxImageBytes) {
    issues.push(
      `${field} 图片过大：${stat.size} 字节，超过上限 ${limits.maxImageBytes} 字节（可用 FH_PUBLISH_MAX_IMAGE_BYTES 调整）`,
    );
    return null;
  }
  return { sourcePath: absolute, alt, extension };
}

/** 读取并校验 manifest；所有错误一次性汇总返回，便于 Hermes 一次修完。 */
export function loadManifest(manifestPathRaw: string, limits: PublishLimits = loadLimits()): ResolvedManifest {
  const manifestPath = path.resolve(manifestPathRaw);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    throw new PublishError('manifest_missing', `无法读取 manifest：${manifestPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new PublishError('manifest_invalid', `manifest 不是合法 JSON：${String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(['manifest 顶层必须是 JSON 对象']);
  }

  const manifestDir = path.dirname(manifestPath);
  const warnings: string[] = [];
  const issues: string[] = [];
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) warnings.push(`manifest 存在未知字段 ${key}，已忽略`);
  }

  const slug = asString(input.slug);
  if (!slug) {
    issues.push('slug 必填');
  } else if (!isValidSlug(slug)) {
    issues.push(`slug 只能是小写英文字母、数字和连字符（不能连续连字符、不能以连字符开头结尾），最长 ${SLUG_MAX_LENGTH}：${slug}`);
  }

  const title = asString(input.title);
  if (!title) {
    issues.push('title 必填');
  } else if (title.length > 120) {
    issues.push(`title 过长（${title.length} 字符，上限 120）`);
  }

  let summary = asString(input.summary) ?? '';
  if (summary.length > 400) {
    issues.push(`summary 过长（${summary.length} 字符，上限 400）`);
  }
  if (summary === '') {
    summary = DEFAULT_SUMMARY;
    warnings.push(`未提供 summary，已使用默认文案「${DEFAULT_SUMMARY}」`);
  }

  const description = asString(input.description) ?? DEFAULT_DESCRIPTION;
  if (description.length > 20000) {
    issues.push(`description 过长（${description.length} 字符，上限 20000）`);
  }

  let displayVersion: string | null = null;
  if (input.displayVersion !== undefined && input.displayVersion !== null) {
    if (typeof input.displayVersion === 'number') displayVersion = String(input.displayVersion);
    else if (typeof input.displayVersion === 'string') displayVersion = input.displayVersion.trim() || null;
    else issues.push('displayVersion 必须是字符串或数字');
    if (displayVersion && displayVersion.length > 40) issues.push('displayVersion 过长（上限 40 字符）');
  }

  let tags: string[] | null = null;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      issues.push('tags 必须是字符串数组');
    } else {
      const collected: string[] = [];
      const seenTags = new Set<string>();
      for (const item of input.tags) {
        if (typeof item !== 'string') {
          issues.push('tags 里只能放字符串');
          continue;
        }
        const label = normalizeTagLabel(item);
        if (label.length === 0) continue;
        if (label.length > TAG_MAX_LENGTH) {
          issues.push(`标签过长（上限 ${TAG_MAX_LENGTH} 字符）：${label}`);
          continue;
        }
        if (seenTags.has(label.toLowerCase())) continue;
        seenTags.add(label.toLowerCase());
        collected.push(label);
      }
      if (collected.length > TAG_MAX_COUNT) issues.push(`标签过多（上限 ${TAG_MAX_COUNT} 个）`);
      tags = collected;
    }
  }

  let sortOrder = 0;
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== 'number' || !Number.isFinite(input.sortOrder)) {
      issues.push('sortOrder 必须是数字');
    } else {
      sortOrder = input.sortOrder;
    }
  }

  let published = true;
  if (input.published !== undefined) {
    if (typeof input.published !== 'boolean') issues.push('published 必须是布尔值');
    else published = input.published;
  }

  let demo = false;
  if (input.demo !== undefined) {
    if (typeof input.demo !== 'boolean') issues.push('demo 必须是布尔值');
    else demo = input.demo;
  }

  // ---- web 包 ----
  let web: ManifestWeb | undefined;
  if (input.web !== undefined && input.web !== null) {
    if (typeof input.web !== 'object' || Array.isArray(input.web)) {
      issues.push('web 必须是对象或 null');
    } else {
      const webObj = input.web as Record<string, unknown>;
      const packageRaw = webObj.package;
      const directoryRaw = webObj.directory;
      if (packageRaw !== undefined && directoryRaw !== undefined) {
        issues.push('web.package 与 web.directory 不能同时提供');
      } else if (packageRaw === undefined && directoryRaw === undefined) {
        issues.push('web 需要提供 package（ZIP 文件）或 directory（静态目录）之一');
      }

      let kind: 'zip' | 'directory' = 'zip';
      let sourcePath: string | null = null;
      if (packageRaw !== undefined) {
        kind = 'zip';
        sourcePath = resolveSourceFile(manifestDir, packageRaw, 'web.package', issues);
        if (sourcePath) {
          const stat = fs.statSync(sourcePath);
          if (stat.size > limits.maxZipBytes) {
            issues.push(
              `web.package 过大：${stat.size} 字节，超过上限 ${limits.maxZipBytes} 字节（可用 FH_PUBLISH_MAX_ZIP_BYTES 调整）`,
            );
          }
          if (path.extname(sourcePath).toLowerCase() !== '.zip') {
            issues.push(`web.package 必须是 .zip 文件，当前为 ${path.extname(sourcePath) || '(无扩展名)'}`);
          }
        }
      } else if (directoryRaw !== undefined) {
        kind = 'directory';
        const text = asString(directoryRaw);
        if (!text) {
          issues.push('web.directory 必须是非空字符串路径');
        } else {
          const absolute = path.isAbsolute(text) ? path.normalize(text) : path.resolve(manifestDir, text);
          let stat: fs.Stats | null = null;
          try {
            stat = fs.statSync(absolute);
          } catch {
            issues.push(`web.directory 目录不存在：${text}`);
          }
          if (stat && !stat.isDirectory()) issues.push(`web.directory 必须是目录：${text}`);
          if (stat?.isDirectory()) sourcePath = absolute;
        }
      }

      let entry: string | null = null;
      if (webObj.entry !== undefined) {
        const text = asString(webObj.entry);
        if (!text) {
          issues.push('web.entry 必须是非空字符串');
        } else {
          const normalized = text.replace(/\\/g, '/').replace(/^\/+/, '');
          if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
            issues.push('web.entry 不能包含 .. 或空路径段');
          } else {
            entry = normalized;
          }
        }
      }

      let spaFallback = false;
      if (webObj.spaFallback !== undefined) {
        if (typeof webObj.spaFallback !== 'boolean') issues.push('web.spaFallback 必须是布尔值');
        else spaFallback = webObj.spaFallback;
      }

      if (sourcePath) web = { kind, sourcePath, entry, spaFallback };
    }
  }

  // ---- 媒体 ----
  let cover: ManifestMedia | null | undefined;
  if (input.cover === null) {
    cover = null;
  } else if (input.cover !== undefined) {
    cover = parseMedia(manifestDir, input.cover, 'cover', `${title ?? '项目'}封面`, limits, issues) ?? undefined;
  }

  let screenshots: ManifestMedia[] | undefined;
  if (input.screenshots !== undefined) {
    if (!Array.isArray(input.screenshots)) {
      issues.push('screenshots 必须是数组');
    } else if (input.screenshots.length > 20) {
      issues.push('screenshots 最多 20 张');
    } else {
      const parsed: ManifestMedia[] = [];
      input.screenshots.forEach((item, index) => {
        const media = parseMedia(
          manifestDir,
          item,
          `screenshots[${index}]`,
          `${title ?? '项目'}预览图 ${index + 1}`,
          limits,
          issues,
        );
        if (media) parsed.push(media);
      });
      screenshots = parsed;
    }
  }

  // ---- 下载 ----
  const downloads: ManifestDownload[] = [];
  if (input.downloads !== undefined) {
    if (!Array.isArray(input.downloads)) {
      issues.push('downloads 必须是数组');
    } else {
      const seenNames = new Set<string>();
      input.downloads.forEach((item, index) => {
        const field = `downloads[${index}]`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          issues.push(`${field} 必须是对象`);
          return;
        }
        const obj = item as Record<string, unknown>;
        const fileName = asString(obj.fileName);
        if (!fileName) {
          issues.push(`${field}.fileName 必填`);
        } else if (!isSafeFileName(fileName)) {
          issues.push(`${field}.fileName 不合法（不能包含路径分隔符、控制字符、首尾空格）：${fileName}`);
        } else if (seenNames.has(fileName.toLowerCase())) {
          issues.push(`${field}.fileName 与同项目其它下载重复：${fileName}`);
        } else {
          seenNames.add(fileName.toLowerCase());
        }

        const sourcePath = resolveSourceFile(manifestDir, obj.path, `${field}.path`, issues);
        let size = 0;
        if (sourcePath) {
          const stat = fs.statSync(sourcePath);
          size = stat.size;
          if (size > limits.maxDownloadBytes) {
            issues.push(
              `${field} 文件过大：${size} 字节，超过上限 ${limits.maxDownloadBytes} 字节（可用 FH_PUBLISH_MAX_DOWNLOAD_BYTES 调整）`,
            );
          }
          const extension = path.extname(fileName ?? sourcePath).toLowerCase();
          if (!limits.allowedDownloadExtensions.has(extension)) {
            issues.push(
              `${field}.fileName 扩展名不在允许列表中：${extension || '(无扩展名)'}（允许：${[...limits.allowedDownloadExtensions].join(' ')}；可用 FH_PUBLISH_EXTRA_EXTENSIONS 追加）`,
            );
          }
        }

        let platform: Platform | null = null;
        if (!isPlatform(obj.platform)) {
          issues.push(`${field}.platform 必须是 windows/android/html/linux/macos/other 之一`);
        } else {
          platform = obj.platform;
        }

        let version: string | null = null;
        if (obj.version !== undefined && obj.version !== null) {
          if (typeof obj.version === 'number') version = String(obj.version);
          else if (typeof obj.version === 'string') version = obj.version.trim() || null;
          else issues.push(`${field}.version 必须是字符串或数字`);
        }

        let isDefault = false;
        if (obj.default !== undefined) {
          if (typeof obj.default !== 'boolean') issues.push(`${field}.default 必须是布尔值`);
          else isDefault = obj.default;
        }

        let contentType: string | null = null;
        if (obj.contentType !== undefined && obj.contentType !== null) {
          const text = asString(obj.contentType);
          if (!text || !text.includes('/')) issues.push(`${field}.contentType 必须是 MIME 类型`);
          else contentType = text;
        }

        if (fileName && sourcePath && platform) {
          downloads.push({
            fileName,
            sourcePath,
            platform,
            version,
            isDefault,
            contentType,
            size,
          });
        }
      });

      const defaults = downloads.filter((download) => download.isDefault);
      if (defaults.length > 1) issues.push('downloads 里最多只能有一个 default: true');
    }
  }

  const removeDownloads: string[] = [];
  if (input.removeDownloads !== undefined) {
    if (!Array.isArray(input.removeDownloads)) {
      issues.push('removeDownloads 必须是字符串数组');
    } else {
      for (const item of input.removeDownloads) {
        const name = asString(item);
        if (!name) issues.push('removeDownloads 里存在空文件名');
        else removeDownloads.push(name);
      }
    }
  }

  // ---- 分类：缺省时按实际提供的文件推导，不凭空捏造 ----
  let categories: Category[] = [];
  let derivedCategories = false;
  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories) || input.categories.length === 0) {
      issues.push('categories 必须是非空数组');
    } else {
      for (const item of input.categories) {
        if (!isCategory(item)) issues.push(`categories 里存在未知分类：${String(item)}（允许：${CATEGORIES.join('/')}）`);
      }
      categories = CATEGORIES.filter((category) => (input.categories as unknown[]).includes(category));
      if (categories.length === 0 && input.categories.length > 0) {
        // 全是未知分类时错误已记录
      }
    }
  } else {
    derivedCategories = true;
    const derived = new Set<Category>();
    if (web) derived.add('web');
    for (const download of downloads) {
      if (download.platform === 'windows' || download.platform === 'linux' || download.platform === 'macos') {
        derived.add('desktop');
      } else if (download.platform === 'android') {
        derived.add('mobile');
      } else if (download.platform === 'html') {
        derived.add('web');
      }
    }
    categories = CATEGORIES.filter((category) => derived.has(category));
    if (categories.length === 0) {
      issues.push('没有提供 categories，且无法从 web/downloads 推导出分类，请显式指定 categories');
    } else {
      warnings.push(`未提供 categories，已按实际文件推导为 ${categories.join('/')}`);
    }
  }

  if (issues.length > 0) fail(issues);

  return {
    manifestPath,
    manifestDir,
    slug: slug as string,
    title: title as string,
    summary,
    description,
    categories,
    tags,
    displayVersion,
    sortOrder,
    published,
    demo,
    cover,
    screenshots,
    web,
    downloads,
    removeDownloads,
    warnings,
    derivedCategories,
  };
}
