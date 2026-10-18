import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

export const ADMIN_COOKIE = 'fh_admin';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

/** 进程内会话表：重启后需要重新登录，简单且足够。 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  create(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.sessions.set(token, { createdAt: now, expiresAt });
    this.prune();
    return { token, expiresAt };
  }

  /** 校验并续期：有效则返回剩余毫秒，无效返回 null。 */
  verify(token: string | null): number | null {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }
    return entry.expiresAt - now;
  }

  destroy(token: string | null): void {
    if (token) this.sessions.delete(token);
  }

  /** 改密码后把其他会话全部踢掉。 */
  destroyAllExcept(keepToken: string | null): number {
    let removed = 0;
    for (const token of [...this.sessions.keys()]) {
      if (token !== keepToken) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function isSecureRequest(req: Request): boolean {
  if (req.protocol === 'https') return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return typeof value === 'string' && value.split(',')[0]?.trim() === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number): void {
  const parts = [
    `${ADMIN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [`${ADMIN_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
