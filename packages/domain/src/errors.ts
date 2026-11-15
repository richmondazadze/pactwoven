export type ErrorStatus = 400 | 401 | 403 | 404 | 408 | 409 | 413 | 415 | 422 | 429 | 503;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: ErrorStatus,
    message: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
