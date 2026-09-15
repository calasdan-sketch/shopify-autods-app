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
