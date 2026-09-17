// Error classification + retry policy.

export type ErrorCategory = 'auth' | 'network' | 'transient' | 'fatal';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  status?: number;
  retryable: boolean;
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

export function classifyError(err: unknown): ClassifiedError {
  if (!err) {
    return { category: 'fatal', message: 'unknown error', retryable: false };
  }

  const e: any = err;

  // AbortError — never retried automatically; caller decides.
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
    return { category: 'network', message: 'cancelled', retryable: false };
  }

  // Anthropic SDK structured error.
  const status: number | undefined = e?.status ?? e?.statusCode;
  if (status === 401 || status === 403) {
    return { category: 'auth', message: e?.message ?? 'authentication failed', status, retryable: false };
  }
  if (status && TRANSIENT_STATUSES.has(status)) {
    return { category: 'transient', message: e?.message ?? 'transient', status, retryable: true };
  }

  // Network / DNS errors.
  const code = e?.code as string | undefined;
  if (code && NETWORK_CODES.has(code)) {
    return { category: 'network', message: e?.message ?? code, retryable: true };
  }

  // Anything else.
  return { category: 'fatal', message: e?.message ?? String(err), retryable: false };
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  isRetryable: (err: ClassifiedError) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: ClassifiedError) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runWithRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const isRetryable = opts.isRetryable ?? ((e) => e.category === 'transient' || e.category === 'network');

  let lastErr: ClassifiedError | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (raw) {
      const classified = classifyError(raw);
      lastErr = classified;

      if (!classified.retryable || !isRetryable(classified)) {
        throw raw;
      }
      if (i === attempts - 1) {
        throw raw;
      }
      const delayMs = baseDelayMs * Math.pow(2, i);
      if (opts.onRetry) opts.onRetry(i + 1, delayMs, classified);
      await sleep(delayMs);
    }
  }
  throw lastErr ?? new Error('retry exhausted');
}
