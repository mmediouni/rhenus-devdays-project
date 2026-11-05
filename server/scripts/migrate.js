import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/adapters/index.js';

// Applies db/schema.sql (idempotent). Works on any PostgreSQL.
const config = loadConfig();
if (config.db !== 'postgres') {
  console.error('Set DATABASE_URL (URD_DB=postgres) to run the migration.');
  process.exit(1);
}
const sql = await readFile(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const db = createDb(config);
await db.runSql(sql);
console.log('Schema applied.');
await db.close();
