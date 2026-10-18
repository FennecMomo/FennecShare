import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function shortHash(value: string, length = 8): string {
  return sha256Buffer(Buffer.from(value, 'utf8')).slice(0, length);
}

export function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

/** 递归统计目录下的文件（相对路径 + 大小 + sha256），用于计算发布内容指纹。 */
export async function hashDirectory(root: string): Promise<{ files: Array<{ path: string; size: number; sha256: string }>; totalBytes: number }> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let totalBytes = 0;

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(absolute);
        files.push({ path: relative, size: stat.size, sha256: await sha256File(absolute) });
        totalBytes += stat.size;
      } else {
        throw new Error(`目录里存在不支持的文件类型（符号链接或设备文件）：${relative}`);
      }
    }
  }

  await walk(root, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes };
}
