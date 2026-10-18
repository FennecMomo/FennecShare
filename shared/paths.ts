import path from 'node:path';

/**
 * 把 URL 或 manifest 里的相对路径解析到 root 内部，返回绝对路径；越界返回 null。
 * 所有涉及磁盘的路径都必须经过这里，绝不把请求/外部输入直接拼成磁盘路径。
 */
export function resolveWithin(root: string, relativePath: string): string | null {
  if (relativePath.includes('\0')) return null;
  const resolvedRoot = path.resolve(root);
  const joined = path.resolve(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, joined);
  if (rel === '') return resolvedRoot;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return joined;
}

/** true 表示 target 位于 root 之内（含 root 本身）。 */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 校验一个“归档内相对路径”是否安全：
 * - 反斜杠统一成斜杠后再判断，防止 `..\..\x` 绕过；
 * - 拒绝绝对路径、Windows 盘符、UNC、NUL；
 * - 拒绝 `.`/`..` 段、空段、冒号（Windows 备用数据流）。
 */
export function sanitizeArchivePath(rawName: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (rawName.includes('\0')) return { ok: false, reason: '路径包含 NUL 字符' };
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return { ok: false, reason: '绝对路径' };
  if (normalized.startsWith('//')) return { ok: false, reason: 'UNC 路径' };
  if (/^[A-Za-z]:/.test(normalized)) return { ok: false, reason: 'Windows 盘符路径' };
  const segments = normalized.split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, reason: '包含 .. 路径段' };
    if (segment.includes(':')) return { ok: false, reason: '路径段包含冒号' };
    cleaned.push(segment);
  }
  if (cleaned.length === 0) return { ok: false, reason: '空路径' };
  return { ok: true, path: cleaned.join('/') };
}

/** 生成安全的对外文件名：不允许路径分隔符、控制字符、首尾空白。 */
export function isSafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (/[/\\\0\r\n\t]/.test(name)) return false;
  if (/^\.+$/.test(name)) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  // 首尾空格在 Windows 上会被静默裁剪，导致下载名对不上
  if (name !== name.trim()) return false;
  return true;
}
