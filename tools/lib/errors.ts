/** 发布工具里可预期的失败：带稳定错误码，CLI 用它决定退出码。 */
export class PublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PublishError';
  }

  /** 2 表示输入/manifest 不合法，1 表示执行过程失败。 */
  get exitCode(): number {
    return this.code.startsWith('invalid') || this.code.startsWith('manifest') ? 2 : 1;
  }
}

export function isPublishError(error: unknown): error is PublishError {
  return error instanceof PublishError;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
