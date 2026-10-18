import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yauzl from 'yauzl';
import { resolveWithin, sanitizeArchivePath } from '../../shared/paths.js';
import { PublishError, isPublishError } from './errors.js';
import type { PublishLimits } from './manifest.js';

export interface ExtractResult {
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(new PublishError('invalid_package', `无法读取 ZIP 包：${error?.message ?? '未知错误'}`));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  return fileType === 0o120000;
}

function shouldSkip(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  return normalized.startsWith('__MACOSX/') || normalized.endsWith('.DS_Store') || normalized === '.DS_Store';
}

/**
 * 安全解压：
 * - 拒绝 `..`、绝对路径、盘符、UNC、反斜杠绕过、符号链接；
 * - 限制文件数量、单文件大小和总解压体积（读完前就判断，避免撑爆磁盘）；
 * - 拒绝大小写冲突的重名文件，避免 Windows/Linux 行为不一致；
 * - 所有写入路径再次用 resolveWithin 兜底，确保落在目标目录内。
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  limits: PublishLimits,
): Promise<ExtractResult> {
  const zipStat = await fs.promises.stat(zipPath);
  if (zipStat.size > limits.maxZipBytes) {
    throw new PublishError(
      'invalid_package',
      `ZIP 文件本身过大：${zipStat.size} 字节，上限 ${limits.maxZipBytes} 字节（FH_PUBLISH_MAX_ZIP_BYTES）`,
    );
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  const zipfile = await openZip(zipPath);
  const seen = new Map<string, string>();
  const warnings: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let skippedCount = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      try {
        zipfile.close();
      } catch {
        // 忽略关闭错误
      }
      reject(
        isPublishError(error)
          ? error
          : new PublishError('invalid_package', `ZIP 读取失败：${error instanceof Error ? error.message : String(error)}`),
      );
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => resolve());
    zipfile.on('entry', (entry: yauzl.Entry) => {
      void handleEntry(entry)
        .then(() => zipfile.readEntry())
        .catch(fail);
    });

    async function handleEntry(entry: yauzl.Entry): Promise<void> {
      const rawName = entry.fileName;
      if (shouldSkip(rawName)) {
        skippedCount += 1;
        return;
      }

      const sanitized = sanitizeArchivePath(rawName);
      if (!sanitized.ok) {
        throw new PublishError('invalid_package', `ZIP 内路径不安全（${sanitized.reason}）：${rawName}`);
      }

      if (isSymlinkEntry(entry)) {
        throw new PublishError('invalid_package', `ZIP 内不允许符号链接：${rawName}`);
      }

      const key = sanitized.path.toLowerCase();
      if (seen.has(key)) {
        throw new PublishError(
          'invalid_package',
          `ZIP 内存在重名或仅大小写不同的路径，无法安全解压：${rawName} 与 ${seen.get(key) ?? ''}`,
        );
      }
      seen.set(key, sanitized.path);

      const target = resolveWithin(destDir, sanitized.path);
      if (!target) {
        throw new PublishError('invalid_package', `ZIP 内路径越界：${rawName}`);
      }

      if (rawName.endsWith('/')) {
        await fs.promises.mkdir(target, { recursive: true });
        return;
      }

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new PublishError(
          'invalid_package',
          `ZIP 内文件数量超过上限 ${limits.maxFiles}（FH_PUBLISH_MAX_FILES）`,
        );
      }

      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw new PublishError(
          'invalid_package',
          `ZIP 内单个文件过大：${sanitized.path} 解压后 ${entry.uncompressedSize} 字节，上限 ${limits.maxEntryBytes}（FH_PUBLISH_MAX_ENTRY_BYTES）`,
        );
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maxUncompressedBytes) {
        throw new PublishError(
          'invalid_package',
          `ZIP 解压后总大小超过上限 ${limits.maxUncompressedBytes} 字节（FH_PUBLISH_MAX_UNCOMPRESSED_BYTES）`,
        );
      }

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await new Promise<void>((resolveStream, rejectStream) => {
        zipfile.openReadStream(entry, (error, readStream) => {
          if (error || !readStream) {
            rejectStream(new PublishError('invalid_package', `读取 ZIP 条目失败：${rawName}（${error?.message ?? ''}）`));
            return;
          }
          const writeStream = fs.createWriteStream(target, { flags: 'wx' });
          writeStream.on('error', (writeError) => {
            readStream.destroy();
            rejectStream(
              new PublishError('invalid_package', `写入解压文件失败：${sanitized.path}（${writeError.message}）`),
            );
          });
          writeStream.on('finish', () => resolveStream());
          readStream.on('error', (readError) => {
            writeStream.destroy();
            rejectStream(new PublishError('invalid_package', `解压数据流错误：${rawName}（${readError.message}）`));
          });
          readStream.pipe(writeStream);
        });
      });
    }

    zipfile.readEntry();
  });

  if (skippedCount > 0) warnings.push(`解压时跳过了 ${skippedCount} 个系统附带文件（__MACOSX/.DS_Store）`);

  return { fileCount, totalBytes, warnings };
}

/** 复制一个静态目录（用于 web.directory），同样做符号链接和数量/体积检查。 */
export async function copyDirectorySafely(
  sourceDir: string,
  destDir: string,
  limits: PublishLimits,
): Promise<ExtractResult> {
  let fileCount = 0;
  let totalBytes = 0;
  const seen = new Map<string, string>();

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (shouldSkip(relative)) continue;

      const lower = relative.toLowerCase();
      if (seen.has(lower)) {
        throw new PublishError('invalid_package', `目录内存在重名或仅大小写不同的路径：${relative}`);
      }
      seen.set(lower, relative);

      if (entry.isSymbolicLink()) {
        throw new PublishError('invalid_package', `web.directory 内不允许符号链接：${relative}`);
      }
      if (entry.isDirectory()) {
        await fs.promises.mkdir(resolveWithin(destDir, relative) ?? destDir, { recursive: true });
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new PublishError('invalid_package', `web.directory 内存在不支持的文件类型：${relative}`);
      }

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new PublishError('invalid_package', `web.directory 文件数量超过上限 ${limits.maxFiles}`);
      }
      const stat = await fs.promises.stat(absolute);
      if (stat.size > limits.maxEntryBytes) {
        throw new PublishError('invalid_package', `web.directory 内单个文件过大：${relative}（${stat.size} 字节）`);
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxUncompressedBytes) {
        throw new PublishError('invalid_package', `web.directory 总大小超过上限 ${limits.maxUncompressedBytes} 字节`);
      }

      const target = resolveWithin(destDir, relative);
      if (!target) throw new PublishError('invalid_package', `目录内路径越界：${relative}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(absolute, target);
    }
  }

  await fs.promises.mkdir(destDir, { recursive: true });
  await walk(sourceDir, '');
  return { fileCount, totalBytes, warnings: [] };
}

export interface WebRootInfo {
  /** 真正的站点根目录绝对路径。 */
  webRoot: string;
  /** 入口文件相对 webRoot 的路径，例如 index.html。 */
  entry: string;
  warnings: string[];
}

/**
 * 确定包根目录：
 * - 显式给了 entry 就用它；
 * - 否则在 3 层深度内找 index.html，必须唯一，否则要求显式指定 entry（不猜）；
 * - 如果入口在唯一的外包装目录里，就把这个目录当作站点根。
 */
export async function detectWebRoot(
  extractRoot: string,
  entryHint: string | null,
  limits: PublishLimits,
): Promise<WebRootInfo> {
  const warnings: string[] = [];

  if (entryHint) {
    const absolute = resolveWithin(extractRoot, entryHint);
    if (!absolute) {
      throw new PublishError('invalid_package', `web.entry 越界：${entryHint}`);
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      throw new PublishError('invalid_package', `web.entry 指定的入口不存在：${entryHint}`);
    }
    if (!stat.isFile()) {
      throw new PublishError('invalid_package', `web.entry 必须是文件：${entryHint}`);
    }
    return {
      webRoot: path.dirname(absolute),
      entry: path.basename(absolute),
      warnings,
    };
  }

  const candidates: string[] = [];
  async function findIndexHtml(current: string, depth: number): Promise<void> {
    if (depth > 3 || candidates.length > 10) return;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'index.html') candidates.push(absolute);
      else if (entry.isDirectory()) await findIndexHtml(absolute, depth + 1);
    }
  }
  await findIndexHtml(extractRoot, 0);

  if (candidates.length === 0) {
    throw new PublishError('invalid_package', '包内找不到 index.html，请用 web.entry 显式指定入口文件');
  }
  if (candidates.length > 1) {
    const list = candidates
      .map((candidate) => path.relative(extractRoot, candidate).split(path.sep).join('/'))
      .sort()
      .slice(0, 8)
      .join('、');
    throw new PublishError(
      'invalid_package',
      `包内有多个可能的入口，请用 web.entry 指定其中一个：${list}${candidates.length > 8 ? ' 等' : ''}`,
    );
  }

  const entryAbsolute = candidates[0] as string;
  const webRoot = path.dirname(entryAbsolute);
  const relativeToRoot = path.relative(extractRoot, webRoot);
  if (relativeToRoot !== '') {
    warnings.push(`包内自动识别到外层目录 ${relativeToRoot.split(path.sep).join('/')}，已作为站点根目录`);
  }

  // 站点根之外还散落着文件时提示一下，这些文件不会发布
  const outside = await listOutsideRoot(extractRoot, webRoot);
  if (outside.length > 0) {
    warnings.push(`站点根目录之外还有 ${outside.length} 个文件未发布：${outside.slice(0, 5).join('、')}`);
  }

  const entrySize = (await fs.promises.stat(entryAbsolute)).size;
  if (entrySize > limits.maxEntryBytes) {
    throw new PublishError('invalid_package', `入口文件过大：${entrySize} 字节`);
  }

  return { webRoot, entry: path.basename(entryAbsolute), warnings };
}

async function listOutsideRoot(extractRoot: string, webRoot: string): Promise<string[]> {
  if (path.resolve(extractRoot) === path.resolve(webRoot)) return [];
  const result: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 2) return;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (path.resolve(absolute) === path.resolve(webRoot)) continue;
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) result.push(path.relative(extractRoot, absolute).split(path.sep).join('/'));
    }
  }
  await walk(extractRoot, 0);
  return result;
}

const ROOT_ABSOLUTE_PATTERN = /(?:src|href)\s*=\s*["']\/(?!\/)|url\(\s*["']?\/(?!\/)|import\s*\(\s*["']\/(?!\/)/i;
const SCAN_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.webmanifest']);

/**
 * 检查写死站点根路径（如 /assets/...）的引用并给出警告。
 * 只报告，不修改包内容：盲改压缩后的 JS 会引入更难排查的故障。
 */
export async function scanRootAbsoluteRefs(webRoot: string): Promise<string[]> {
  const warnings: string[] = [];
  const samples: string[] = [];
  let scanned = 0;

  async function walk(current: string, prefix: string): Promise<void> {
    if (scanned > 400 || samples.length >= 5) return;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (scanned > 400 || samples.length >= 5) return;
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.promises.stat(absolute);
      if (stat.size > 4 * 1024 * 1024) continue;
      scanned += 1;
      let text: string;
      try {
        text = await fs.promises.readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      if (ROOT_ABSOLUTE_PATTERN.test(text)) samples.push(relative);
    }
  }

  await walk(webRoot, '');
  if (samples.length > 0) {
    warnings.push(
      `包内可能存在写死站点根路径的引用（如 /assets/...），部署到 /play/<slug>/ 子路径后可能 404：${samples.join('、')}。建议按 HTML_PACKAGE_GUIDE 用相对路径（Vite 可设 base: './'）。`,
    );
  }
  return warnings;
}

export function makeTempName(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}
