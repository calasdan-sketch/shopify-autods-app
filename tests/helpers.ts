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
    automation: {
      autoPublish: false,
      autoFulfill: false,
      syncCron: '* * * * *',
    },
    ...overrides,
  };
}
