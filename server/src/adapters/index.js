import { createMemoryDb } from './db-memory.js';
import { createPostgresDb } from './db-postgres.js';
import { createLocalStorage, createMemoryStorage } from './storage-local.js';
import { createSupabaseStorage } from './storage-supabase.js';

// Vercel functions have no persistent disk and no shared memory between instances.
// Fail loudly instead of silently losing data.
const onVercel = () => !!process.env.VERCEL;

export function createDb(config) {
  if (onVercel() && config.db === 'memory') {
    throw new Error('Vercel needs a database: set DATABASE_URL (the in-memory database loses data).');
  }
  if (config.db === 'postgres') return createPostgresDb(config);
  if (config.db === 'memory') return createMemoryDb();
  throw new Error(`Unknown URD_DB "${config.db}" (use postgres or memory)`);
}

export function createStorage(config) {
  if (onVercel() && config.storage !== 'supabase') {
    throw new Error('Vercel has no persistent disk: set URD_STORAGE=supabase with SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_BUCKET.');
  }
  if (config.storage === 'supabase') return createSupabaseStorage(config);
  if (config.storage === 'local') return createLocalStorage(config);
  if (config.storage === 'memory') return createMemoryStorage();
  throw new Error(`Unknown URD_STORAGE "${config.storage}" (use local, supabase or memory)`);
}
