import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 管理密码的落盘格式：只存 salt + scrypt 派生值，永远不存明文。 */
export interface AuthRecord {
  version: 1;
  algorithm: 'scrypt';
  salt: string;
  hash: string;
  keylen: number;
  N: number;
  r: number;
  p: number;
  updatedAt: string;
}

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function authPathOf(dataDir: string): string {
  return path.join(dataDir, 'admin', 'auth.json');
}

function derive(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function checkPasswordPolicy(password: string): string | null {
  if (typeof password !== 'string') return '密码格式不正确';
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (password.length > MAX_PASSWORD_LENGTH) return `密码最多 ${MAX_PASSWORD_LENGTH} 位`;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '密码需要同时包含字母和数字';
  return null;
}

export async function readAuth(dataDir: string): Promise<AuthRecord | null> {
  try {
    const raw = await fs.promises.readFile(authPathOf(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as AuthRecord;
    if (record.version !== 1 || record.algorithm !== 'scrypt') return null;
    if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

export async function writeAuth(dataDir: string, password: string): Promise<AuthRecord> {
  const problem = checkPasswordPolicy(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS.keylen, PARAMS.N, PARAMS.r, PARAMS.p);
  const record: AuthRecord = {
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    keylen: PARAMS.keylen,
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    updatedAt: new Date().toISOString(),
  };
  const target = authPathOf(dataDir);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temp, target);
  return record;
}

export async function verifyPassword(record: AuthRecord, password: string): Promise<boolean> {
  try {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = await derive(
      password,
      Buffer.from(record.salt, 'hex'),
      record.keylen,
      record.N,
      record.r,
      record.p,
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
