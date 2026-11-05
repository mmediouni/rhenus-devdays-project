import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { loadConfig } from '../src/config.js';
import { createMemoryDb } from '../src/adapters/db-memory.js';
import { createMemoryStorage } from '../src/adapters/storage-local.js';
import { createApp } from '../src/core/app.js';
import { generateKey } from '../src/core/auth.js';

function solid(w, h, [r, g, b], patch) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  if (patch) patch(png);
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

async function setup(scopes = ['read', 'write']) {
  const config = loadConfig({});
  const db = createMemoryDb();
  const storage = createMemoryStorage();
  const app = createApp({ db, storage, config });
  const project = await db.createProject('demo');
  const { key, hash } = generateKey();
  await db.createKey({ projectId: project.id, name: 'test', hash, scopes });
  const call = (method, path, body, k = key) =>
    app.handle(
      new Request('http://hub.test' + path, {
        method,
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      })
    );
  return { call, db, key };
}

test('health needs no key', async () => {
  const { call } = await setup();
  const res = await call('GET', '/v1/health', undefined, '');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('rejects missing or wrong key', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/v1/pages', undefined, 'urd_wrong')).status, 401);
  assert.equal((await call('GET', '/v1/pages', undefined, '')).status, 401);
});

test('first snapshot becomes the baseline, later ones are compared', async () => {
  const { call } = await setup();
  const base = { step: 'home', label: 'main', source: 'test' };

  const r1 = await call('POST', '/v1/snapshots', { ...base, image: solid(40, 40, [255, 255, 255]) });
  assert.equal(r1.status, 201);
  const s1 = await r1.json();
  assert.equal(s1.verdict, 'NEW');
  assert.equal(s1.autoBaseline, true);

  const r2 = await call('POST', '/v1/snapshots', { ...base, image: solid(40, 40, [255, 255, 255]) });
  const s2 = await r2.json();
  assert.equal(s2.verdict, 'PASS');
  assert.equal(s2.vsPrevious.diffPixels, 0);
  assert.equal(s2.prevId, s1.id);

  const r3 = await call('POST', '/v1/snapshots', {
    ...base,
    image: solid(40, 40, [255, 255, 255], (p) => {
      for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) p.data.writeUInt32BE(0x000000ff, (y * 40 + x) * 4);
    })
  });
  const s3 = await r3.json();
  assert.equal(s3.verdict, 'REGRESSION');
  assert.ok(s3.vsBaseline.diffPercentage > 40);
});

test('timeline lists newest first and respects labels', async () => {
  const { call } = await setup();
  const white = solid(20, 20, [255, 255, 255]);
  await call('POST', '/v1/snapshots', { step: 'p', label: 'a', image: white });
  await call('POST', '/v1/snapshots', { step: 'p', label: 'a', image: white });
  await call('POST', '/v1/snapshots', { step: 'p', label: 'b', image: white });

  const all = await (await call('GET', '/v1/timeline?pageKey=p')).json();
  assert.equal(all.snapshots.length, 3);
  const onlyA = await (await call('GET', '/v1/timeline?pageKey=p&label=a')).json();
  assert.equal(onlyA.snapshots.length, 2);
  assert.ok(onlyA.snapshots[0].createdAt >= onlyA.snapshots[1].createdAt);

  const pages = await (await call('GET', '/v1/pages')).json();
  assert.equal(pages.pages.length, 2);
});

test('approving a new baseline changes what later snapshots are compared to', async () => {
  const { call } = await setup();
  const white = solid(20, 20, [255, 255, 255]);
  const black = solid(20, 20, [0, 0, 0]);
  await call('POST', '/v1/snapshots', { step: 'p', image: white });
  const changed = await (await call('POST', '/v1/snapshots', { step: 'p', image: black })).json();
  assert.equal(changed.verdict, 'REGRESSION');

  const ok = await call('POST', '/v1/baselines', { snapshotId: changed.id });
  assert.equal(ok.status, 200);

  const after = await (await call('POST', '/v1/snapshots', { step: 'p', image: black })).json();
  assert.equal(after.verdict, 'PASS');
});

test('read-only keys cannot write', async () => {
  const { call } = await setup(['read']);
  const res = await call('POST', '/v1/snapshots', { step: 'p', image: solid(10, 10, [0, 0, 0]) });
  assert.equal(res.status, 403);
});

test('rejects non-PNG and missing page identity', async () => {
  const { call } = await setup();
  const bad = await call('POST', '/v1/snapshots', { step: 'p', image: 'data:image/png;base64,AAAA' });
  assert.equal(bad.status, 415);
  const noKey = await call('POST', '/v1/snapshots', { image: solid(10, 10, [0, 0, 0]) });
  assert.equal(noKey.status, 400);
});

test('derives a host independent page key from the url', async () => {
  const { call } = await setup();
  const img = solid(10, 10, [0, 0, 0]);
  const a = await (await call('POST', '/v1/snapshots', { url: 'https://one.example/cart?x=1', label: 'one', image: img })).json();
  const b = await (await call('POST', '/v1/snapshots', { url: 'https://two.example/cart?x=1', label: 'two', image: img })).json();
  assert.equal(a.pageKey, '/cart?x=1');
  assert.equal(b.pageKey, '/cart?x=1');
});

test('compare endpoint diffs two stored snapshots', async () => {
  const { call } = await setup();
  const a = await (await call('POST', '/v1/snapshots', { step: 'p', label: 'a', image: solid(10, 10, [0, 0, 0]) })).json();
  const b = await (await call('POST', '/v1/snapshots', { step: 'p', label: 'b', image: solid(10, 10, [255, 255, 255]) })).json();
  const res = await call('GET', `/v1/compare?a=${a.id}&b=${b.id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.verdict, 'REGRESSION');
  const img = await call('GET', `/v1/compare?a=${a.id}&b=${b.id}&format=png`);
  assert.equal(img.headers.get('content-type'), 'image/png');
});
