import { loadConfig } from '../src/config.js';
import { createDb } from '../src/adapters/index.js';
import { generateKey } from '../src/core/auth.js';

// Usage: node scripts/create-key.js <project-name> [key-name] [scopes comma separated]
const [project, keyName = 'default', scopesArg = 'read,write'] = process.argv.slice(2);
if (!project) {
  console.error('Usage: npm run create-key -- <project-name> [key-name] [read,write]');
  process.exit(1);
}

const config = loadConfig();
if (config.db === 'memory') {
  console.error('URD_DB is "memory": keys would vanish immediately. Set DATABASE_URL first.');
  process.exit(1);
}

const db = createDb(config);
const scopes = scopesArg.split(',').map((s) => s.trim()).filter(Boolean);
const proj = await db.createProject(project);
const { key, hash } = generateKey();
await db.createKey({ projectId: proj.id, name: keyName, hash, scopes });

console.log(`Project: ${proj.name} (${proj.id})`);
console.log(`Key name: ${keyName}   scopes: ${scopes.join(',')}`);
console.log('\nAPI key (shown once, store it safely):\n');
console.log(key);
await db.close();
