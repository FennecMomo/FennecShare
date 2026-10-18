/** 极简日志：输出到 stdout/stderr，交给 journald / systemd 收集。 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function normalizeLevel(raw: string | undefined): LogLevel {
  if (raw && raw in LEVELS) return raw as LogLevel;
  return 'info';
}

function format(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${text}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function createLogger(levelRaw: string | undefined): Logger {
  const threshold = LEVELS[normalizeLevel(levelRaw)];
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${format(fields)}`;
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
