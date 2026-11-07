import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');

let dbInstance: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  autods_product_id TEXT NOT NULL,
  autods_sku TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (autods_product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT NOT NULL,
  autods_order_id TEXT,
  fulfillment_status TEXT NOT NULL DEFAULT 'pending',
  tracking_number TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shopify_order_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  autods_product_id TEXT,
  content_type TEXT NOT NULL,
  prompt_hash TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_content_product
  ON ai_content (autods_product_id);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email)
);
`;

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Additive, idempotent migrations so existing databases keep working. */
function migrate(db: Database.Database): void {
  addColumnIfMissing(db, 'orders', 'notes', 'TEXT');
  addColumnIfMissing(db, 'orders', 'email', 'TEXT');
  addColumnIfMissing(db, 'product_mappings', 'cost', 'REAL');
  addColumnIfMissing(db, 'product_mappings', 'sell_price', 'REAL');
  addColumnIfMissing(db, 'product_mappings', 'stock', 'INTEGER');
  addColumnIfMissing(db, 'product_mappings', 'notes', 'TEXT');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orders_email ON orders (email, created_at)',
  );
}

/**
 * Create a new database connection at the given path and apply the schema.
 *
 * Exposed so tests can build isolated in-memory databases (`:memory:`).
 */
export function createDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Open (or return the already-open) SQLite database, applying the schema.
 *
 * A path of `:memory:` may be used by tests for an ephemeral database.
 */
export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const { databasePath } = loadConfig();

  if (databasePath !== ':memory:') {
    const dir = dirname(databasePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = createDatabase(databasePath);

  log.info({ databasePath }, 'Database initialised');
  dbInstance = db;
  return db;
}

/**
 * Close the database connection. Intended for graceful shutdown and tests.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
