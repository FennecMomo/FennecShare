import path from 'node:path';

/**
 * 显式 MIME 表。
 *
 * 不用第三方 mime 库是有意为之：试玩内容必须拿到稳定、可测的类型，
 * 尤其是 Wasm（application/wasm）和字体；未收录的扩展名统一回落为
 * application/octet-stream，并配合 X-Content-Type-Options: nosniff。
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.data': 'application/octet-stream',
  '.wasm.gz': 'application/octet-stream',
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg']);

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 下载文件的 Content-Type；安装包使用公认类型，其余按扩展名推断。 */
export function downloadContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.exe':
      return 'application/vnd.microsoft.portable-executable';
    case '.msi':
      return 'application/x-msi';
    case '.apk':
      return 'application/vnd.android.package-archive';
    case '.dmg':
      return 'application/x-apple-diskimage';
    case '.deb':
      return 'application/vnd.debian.binary-package';
    case '.appimage':
      return 'application/x-executable';
    case '.zip':
      return 'application/zip';
    case '.7z':
      return 'application/x-7z-compressed';
    case '.gz':
      return 'application/gzip';
    case '.tar':
      return 'application/x-tar';
    default:
      return MIME_TYPES[ext] ?? 'application/octet-stream';
  }
}
