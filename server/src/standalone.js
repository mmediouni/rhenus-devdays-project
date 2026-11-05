import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig } from './config.js';
import { createDb, createStorage } from './adapters/index.js';
import { createApp } from './core/app.js';

// Standalone Node server: for a laptop, an internal server, or Docker.
const config = loadConfig();
const db = createDb(config);
const storage = createStorage(config);
const app = createApp({ db, storage, config });

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
