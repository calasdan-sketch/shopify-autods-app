import { ExternalApiError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('http');

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Maximum number of attempts (including the first). Default 4. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 500. */
  baseDelayMs?: number;
  /** AbortSignal timeout in ms. Default 30000. */
  timeoutMs?: number;
  /**
   * Whether the request is safe to repeat. Default true (back-compat). Set
   * false for calls that spend money or create things (supplier orders,
   * product creation): they are then retried ONLY on 429, where the server
   * has told us it did not process the request. A timeout or 5xx may mean
   * the first attempt succeeded, and a blind retry would duplicate it.
   */
  idempotent?: boolean;
}

/** Longest Retry-After we will honour; a hostile header must not stall us. */
const MAX_RETRY_AFTER_MS = 60_000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into milliseconds.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }
  const asSeconds = Number(headerValue);
  if (!Number.isNaN(asSeconds)) {
    return asSeconds * 1000;
  }
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

/**
 * Perform a JSON HTTP request with exponential backoff + jitter.
 *
 * Retries on network errors and retryable status codes (429/5xx), honouring a
 * `Retry-After` header when present. This centralises the rate-limit handling
 * needed by both the Shopify and AutoDS clients.
 */
export async function requestJson<T>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    maxRetries = 4,
    baseDelayMs = 500,
    timeoutMs = 30000,
    idempotent = true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const errorBody = await response.text();

      const retryable = idempotent
        ? RETRYABLE_STATUS.has(response.status)
        : response.status === 429;
      if (retryable && attempt < maxRetries) {
        const parsed = parseRetryAfter(response.headers.get('retry-after'));
        const retryAfter =
          parsed === null ? null : Math.min(parsed, MAX_RETRY_AFTER_MS);
        const backoff =
          retryAfter ??
          baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
        log.warn(
          { url, status: response.status, attempt, backoff },
          'Retryable HTTP error, backing off',
        );
        await sleep(backoff);
        continue;
      }

      throw new ExternalApiError(
        `Request to ${url} failed with status ${response.status}`,
        response.status,
        errorBody,
      );
    } catch (error) {
      lastError = error;

      // Do not retry non-retryable API errors.
      if (error instanceof ExternalApiError) {
        throw error;
      }

      if (!idempotent) {
        // Outcome unknown (timeout / connection reset): do NOT repeat.
        throw new ExternalApiError(
          `Request to ${url} failed with unknown outcome: ${String(error)}`,
          0,
          undefined,
          error,
        );
      }

      if (attempt < maxRetries) {
        const backoff =
          baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
        log.warn(
          { url, attempt, backoff, err: String(error) },
          'Network error, backing off',
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ExternalApiError(
    `Request to ${url} failed after ${maxRetries} attempts`,
    0,
    undefined,
    lastError,
  );
}
