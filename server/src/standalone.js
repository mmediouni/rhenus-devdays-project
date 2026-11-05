import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { loadConfig } from './config.js';
import { createDb, createStorage } from './adapters/index.js';
import { createApp } from './core/app.js';
import { hashKey } from './core/auth.js';

// Standalone Node server: for a laptop, an internal server, or Docker.
// It also serves the web dashboard from ./public (Vercel does that by itself).
const config = loadConfig();
const db = createDb(config);
const storage = createStorage(config);
const app = createApp({ db, storage, config });

// Demo convenience: URD_DEV_KEY=<any string starting with urd_> creates a project and
// a key at startup. Meant for the in-memory database, where keys cannot be created
// with the CLI. Do not use in production.
if (process.env.URD_DEV_KEY) {
  const project = await db.createProject('dev');
  await db.createKey({ projectId: project.id, name: 'dev-key', hash: hashKey(process.env.URD_DEV_KEY), scopes: ['read', 'write'] });
  console.log('  dev key enabled (project "dev"). Do not use in production.');
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function serveStatic(urlPath, res) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return false;
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function toRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half'
  });
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && !pathname.startsWith('/v1/') && (await serveStatic(pathname, res))) return;

    const response = await app.handle(toRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[hub] server error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
});

server.listen(config.port, () => {
  console.log(`UI Regression Hub listening on http://localhost:${config.port}`);
  console.log(`  database: ${db.kind}   storage: ${storage.kind}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}
