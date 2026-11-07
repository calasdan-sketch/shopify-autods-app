import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralised, validated application configuration.
 *
 * All secrets and environment-specific values are read from environment
 * variables (see `.env.example`). Nothing here should ever be committed with a
 * real value.
 */
const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const numFromEnv = (def: number) => z.coerce.number().finite().default(def);
const listFromEnv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
  );

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  databasePath: z.string().default('./data/app.sqlite'),

  shopify: z.object({
    shop: z.string().default(''),
    accessToken: z.string().default(''),
    webhookSecret: z.string().default(''),
    apiVersion: z.string().default('2024-10'),
  }),

  autods: z.object({
    /** `live` calls the real API; `mock` uses an in-memory fake (no creds). */
    mode: z.enum(['live', 'mock']).default('live'),
    apiBase: z.string().default('https://api.autods.com'),
    apiToken: z.string().default(''),
    storeId: z.string().default(''),
  }),

  claude: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('claude-3-5-sonnet-20241022'),
    maxTokens: z.coerce.number().int().positive().default(1024),
    provider: z.enum(['anthropic', 'openrouter']).default('anthropic'),
    openrouterApiKey: z.string().default(''),
    openrouterModel: z.string().default('anthropic/claude-3.5-sonnet'),
  }),

  /** Rates are YOURS to set: they vary by Shopify plan and country. */
  pricing: z.object({
    targetMarginPct: numFromEnv(30),
    minMarginPct: numFromEnv(15),
    paymentFeePct: numFromEnv(0),
    paymentFixedFee: numFromEnv(0),
    charmPricing: z.boolean(),
  }),

  risk: z.object({
    enabled: z.boolean(),
    requirePaid: z.boolean(),
    maxQuantityPerLine: numFromEnv(5),
    maxOrderValue: numFromEnv(500),
    allowedCountries: z.array(z.string()),
    maxOrdersPerEmailPerDay: numFromEnv(3),
    maxOrderAgeDays: numFromEnv(7),
    maxLineItems: numFromEnv(25),
    holdBelowCost: z.boolean(),
    requireKnownSku: z.boolean(),
  }),

  admin: z.object({
    /** Bearer token required for /admin. Unset = /admin refuses all calls. */
    token: z.string().default(''),
  }),

  /** Product titles/descriptions containing these words are held for review. */
  compliance: z.object({
    blockedTerms: z.array(z.string()),
  }),

  automation: z.object({
    autoPublish: z.boolean(),
    autoFulfill: z.boolean(),
    syncCron: z.string().default('*/30 * * * *'),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | null = null;

/**
 * Load and validate configuration from the environment.
 *
 * The result is cached so repeated calls are cheap and consistent.
 */
export function loadConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = configSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    logLevel: process.env.LOG_LEVEL,
    databasePath: process.env.DATABASE_PATH,
    shopify: {
      shop: process.env.SHOPIFY_SHOP,
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
      webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
      apiVersion: process.env.SHOPIFY_API_VERSION,
    },
    autods: {
      mode: process.env.AUTODS_MODE,
      apiBase: process.env.AUTODS_API_BASE,
      apiToken: process.env.AUTODS_API_TOKEN,
      storeId: process.env.AUTODS_STORE_ID,
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL,
      maxTokens: process.env.CLAUDE_MAX_TOKENS,
      provider: process.env.CLAUDE_PROVIDER,
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      openrouterModel: process.env.OPENROUTER_MODEL,
    },
    pricing: {
      targetMarginPct: process.env.PRICING_TARGET_MARGIN_PCT,
      minMarginPct: process.env.PRICING_MIN_MARGIN_PCT,
      paymentFeePct: process.env.PRICING_PAYMENT_FEE_PCT,
      paymentFixedFee: process.env.PRICING_PAYMENT_FIXED_FEE,
      charmPricing: process.env.PRICING_CHARM !== 'false',
    },
    risk: {
      enabled: process.env.RISK_GATE !== 'off',
      requirePaid: process.env.RISK_REQUIRE_PAID !== 'false',
      maxQuantityPerLine: process.env.RISK_MAX_QTY_PER_LINE,
      maxOrderValue: process.env.RISK_MAX_ORDER_VALUE,
      allowedCountries: listFromEnv.parse(process.env.RISK_ALLOWED_COUNTRIES),
      maxOrdersPerEmailPerDay: process.env.RISK_MAX_ORDERS_PER_EMAIL_PER_DAY,
      maxOrderAgeDays: process.env.RISK_MAX_ORDER_AGE_DAYS,
      maxLineItems: process.env.RISK_MAX_LINE_ITEMS,
      holdBelowCost: process.env.RISK_HOLD_BELOW_COST !== 'false',
      requireKnownSku: process.env.RISK_REQUIRE_KNOWN_SKU === 'true',
    },
    admin: { token: process.env.ADMIN_TOKEN },
    compliance: {
      blockedTerms: (
        process.env.BLOCKED_TERMS ??
        'nike,adidas,disney,marvel,pokemon,apple,samsung,gucci,louis vuitton,rolex,replica,counterfeit,vape,cbd'
      )
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    },
    automation: {
      autoPublish: booleanFromEnv.parse(process.env.AUTO_PUBLISH),
      autoFulfill: booleanFromEnv.parse(process.env.AUTO_FULFILL),
      syncCron: process.env.SYNC_CRON,
    },
  });

  cachedConfig = parsed;
  return parsed;
}

/**
 * Reset the cached config. Intended for tests only.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
