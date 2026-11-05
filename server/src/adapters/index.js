import { createMemoryDb } from './db-memory.js';
import { createPostgresDb } from './db-postgres.js';
import { createLocalStorage, createMemoryStorage } from './storage-local.js';
import { createSupabaseStorage } from './storage-supabase.js';

export function createDb(config) {
  if (config.db === 'postgres') return createPostgresDb(config);
  if (config.db === 'memory') return createMemoryDb();
  throw new Error(`Unknown URD_DB "${config.db}" (use postgres or memory)`);
}

export function createStorage(config) {
  if (config.storage === 'supabase') return createSupabaseStorage(config);
  if (config.storage === 'local') return createLocalStorage(config);
  if (config.storage === 'memory') return createMemoryStorage();
  throw new Error(`Unknown URD_STORAGE "${config.storage}" (use local, supabase or memory)`);
}
