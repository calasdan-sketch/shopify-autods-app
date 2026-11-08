import type { AppConfig } from '../src/config/index.js';

/**
 * Build a fully-populated AppConfig for tests, with overrides.
 */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    databasePath: ':memory:',
    shopify: {
      shop: 'test.myshopify.com',
      accessToken: 'token',
      webhookSecret: 'shhh-secret',
      apiVersion: '2024-10',
    },
    autods: {
      mode: 'live',
      apiBase: 'https://api.autods.com',
      apiToken: 'autods-token',
      storeId: 'store-1',
    },
    claude: {
      apiKey: 'anthropic-key',
      model: 'claude-x',
      maxTokens: 100,
      provider: 'anthropic',
      openrouterApiKey: '',
      openrouterModel: 'anthropic/claude-3.5-sonnet',
    },
    pricing: {
      targetMarginPct: 30,
      minMarginPct: 15,
      paymentFeePct: 0,
      paymentFixedFee: 0,
      charmPricing: false,
    },
    // Gate is OFF in the shared fixture so legacy tests with minimal order
    // payloads keep working; risk-specific tests turn it on explicitly.
    risk: {
      enabled: false,
      requirePaid: true,
      maxQuantityPerLine: 5,
      maxOrderValue: 500,
      allowedCountries: [],
      maxOrdersPerEmailPerDay: 3,
      maxOrderAgeDays: 7,
      maxLineItems: 25,
      holdBelowCost: true,
      requireKnownSku: false,
    },
    privacy: { retentionDays: 0 },
    admin: { token: 'admin-secret' },
    compliance: { blockedTerms: ['replica'] },
    automation: {
      autoPublish: false,
      autoFulfill: false,
      syncCron: '* * * * *',
    },
    ...overrides,
  };
}
