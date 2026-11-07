import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

/**
 * Create a rate-limiting middleware.
 *
 * Protects public HTTP endpoints (webhooks, admin API) from abuse. Defaults to
 * 100 requests per minute per IP; callers may override for specific routers.
 */
export function createRateLimiter(
  options: { windowMs?: number; max?: number } = {},
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    max: options.max ?? 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests' },
  });
}

/**
 * Counts only FAILED requests (401/503...) so a guessed-token attack is
 * throttled per IP without slowing the legitimate admin down.
 */
export function createAuthFailureLimiter(
  options: { windowMs?: number; max?: number } = {},
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 15 * 60_000,
    max: options.max ?? 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many failed attempts' },
  });
}
