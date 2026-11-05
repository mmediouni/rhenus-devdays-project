import { randomUUID } from 'node:crypto';
import { authenticate, can } from './auth.js';
import { comparePng, decodeImageInput, isPng, readSize, verdictFor } from './diff.js';

/**
 * Framework-agnostic API. `handle(Request) -> Response` uses only web-standard
 * objects, so it runs unchanged on Vercel, a plain Node server, Deno or a worker.
 */
export function createApp({ db, storage, config }) {
  const cors = (extra = {}) => ({
    'Access-Control-Allow-Origin': config.corsOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Max-Age': '86400',
    ...extra
  });

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    });

  const fail = (status, message, code) => json(status, { error: message, code: code || undefined });

  const png = (buf) =>
    new Response(buf, {
      status: 200,
      headers: cors({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' })
    });

  async function readJson(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > config.maxBodyBytes) {
      const e = new Error('Request body too large');
      e.status = 413;
      throw e;
    }
    try {
      return await request.json();
    } catch {
      const e = new Error('Body must be valid JSON');
      e.status = 400;
      throw e;
    }
  }

  const clean = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  /** Page identity is host-independent so the same page matches across systems. */
  function derivePageKey(body) {
    const explicit = clean(body.pageKey) || clean(body.step);
    if (explicit) return explicit;
    try {
      const u = new URL(body.url);
      return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
    } catch {
      return '';
    }
  }

  function publicSnapshot(s) {
    return {
      id: s.id,
      pageKey: s.pageKey,
      label: s.label,
      source: s.source,
      url: s.url,
      viewport: s.viewport,
      width: s.width,
      height: s.height,
      meta: s.meta,
      note: s.note,
      prevId: s.prevId,
      baselineId: s.baselineId,
      vsPrevious: s.vsPrev,
      vsBaseline: s.vsBaseline,
      verdict: s.verdict,
      createdAt: s.createdAt
    };
  }

  const summarize = (r) => ({
    verdict: r.verdict,
    diffPercentage: r.diffPercentage,
    diffPixels: r.diffPixels,
    sizeMismatch: r.sizeMismatch,
    sizeA: r.sizeA,
    sizeB: r.sizeB
  });

  // ---- routes ----------------------------------------------------------

  async function createSnapshot(auth, request) {
    if (!can(auth, 'write')) return fail(403, 'This key cannot write', 'forbidden');
    const body = await readJson(request);

    const pageKey = derivePageKey(body);
    if (!pageKey) return fail(400, 'Provide pageKey, step or a valid url', 'bad_request');
    const label = clean(body.label, 100) || 'default';

    let buf;
    try {
      buf = decodeImageInput(body.image);
    } catch (e) {
      return fail(400, e.message, 'bad_request');
    }
    if (!isPng(buf)) return fail(415, 'Only PNG images are supported', 'unsupported_media');
    const size = readSize(buf);
    if (!size.width || !size.height || size.width * size.height > 80_000_000) {
      return fail(413, 'Image dimensions are too large', 'too_large');
    }

    const prev = await db.latestSnapshot(auth.projectId, pageKey, label);
    const baseline = await db.getBaseline(auth.projectId, pageKey, label);

    const opts = {
      threshold: Number.isFinite(body.threshold) ? body.threshold : config.diffThreshold,
      regressionPercent: config.regressionPercent
    };

    const compareWith = async (other) => {
      if (!other) return null;
      const otherBuf = await storage.get(other.imageKey);
      if (!otherBuf) return null;
      try {
        return summarize(comparePng(otherBuf, buf, opts));
      } catch {
        return null;
      }
    };

    const baselineSnap = baseline ? await db.getSnapshot(auth.projectId, baseline.snapshotId) : null;
    const vsPrev = await compareWith(prev);
    const vsBaseline = baselineSnap && baselineSnap.id !== prev?.id ? await compareWith(baselineSnap) : vsPrev;

    // The verdict follows the baseline when one exists, else the previous snapshot.
    const decisive = baselineSnap ? vsBaseline : vsPrev;
    const verdict = decisive ? decisive.verdict : 'NEW';

    const id = randomUUID();
    const imageKey = `${auth.projectId}/${id}.png`;
    await storage.put(imageKey, buf, 'image/png');

    const meta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {};
    const row = await db.insertSnapshot({
      id,
      projectId: auth.projectId,
      pageKey,
      label,
      source: clean(body.source, 40) || 'api',
      url: clean(body.url, 2000) || null,
      viewport:
        body.viewport && Number(body.viewport.width) > 0
          ? { width: Math.round(Number(body.viewport.width)), height: Math.round(Number(body.viewport.height)) || 0 }
          : null,
      imageKey,
      width: size.width,
      height: size.height,
      meta,
      prevId: prev?.id || null,
      baselineId: baselineSnap?.id || null,
      vsPrev,
      vsBaseline: baselineSnap ? vsBaseline : null,
      verdict
    });

    // Without an approved baseline, the first snapshot becomes it automatically.
    let autoBaseline = false;
    if (!baseline && !prev) {
      await db.setBaseline({ projectId: auth.projectId, pageKey, label, snapshotId: row.id, approvedBy: 'auto (first snapshot)' });
      autoBaseline = true;
    }

    return json(201, { ...publicSnapshot(row), firstSnapshot: !prev, autoBaseline });
  }

  async function getTimeline(auth, url) {
    if (!can(auth, 'read')) return fail(403, 'This key cannot read', 'forbidden');
    const pageKey = clean(url.searchParams.get('pageKey'));
    if (!pageKey) return fail(400, 'pageKey is required', 'bad_request');
    const label = clean(url.searchParams.get('label'), 100);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
    const rows = await db.timeline(auth.projectId, pageKey, label || null, limit);
    const baselines = {};
    for (const l of new Set(rows.map((r) => r.label))) {
      const b = await db.getBaseline(auth.projectId, pageKey, l);
      if (b) baselines[l] = b;
    }
    return json(200, { pageKey, label: label || null, baselines, snapshots: rows.map(publicSnapshot) });
  }

  async function approveBaseline(auth, request) {
    if (!can(auth, 'write')) return fail(403, 'This key cannot write', 'forbidden');
    const body = await readJson(request);
    const snap = await db.getSnapshot(auth.projectId, clean(body.snapshotId, 64));
    if (!snap) return fail(404, 'Snapshot not found', 'not_found');
    const b = await db.setBaseline({
      projectId: auth.projectId,
      pageKey: snap.pageKey,
      label: snap.label,
      snapshotId: snap.id,
      approvedBy: clean(body.approvedBy, 100) || auth.keyName
    });
    return json(200, { baseline: b });
  }

  async function compareTwo(auth, url) {
    if (!can(auth, 'read')) return fail(403, 'This key cannot read', 'forbidden');
    const [a, b] = await Promise.all(
      ['a', 'b'].map((k) => db.getSnapshot(auth.projectId, clean(url.searchParams.get(k), 64)))
    );
    if (!a || !b) return fail(404, 'Both snapshots (a, b) must exist', 'not_found');
    const [ba, bb] = await Promise.all([storage.get(a.imageKey), storage.get(b.imageKey)]);
    if (!ba || !bb) return fail(404, 'Image missing from storage', 'not_found');
    const wantImage = url.searchParams.get('format') === 'png';
    const r = comparePng(ba, bb, {
      threshold: Number(url.searchParams.get('threshold') ?? config.diffThreshold),
      regressionPercent: config.regressionPercent,
      withImage: wantImage
    });
    if (wantImage) return png(r.image);
    return json(200, { a: publicSnapshot(a), b: publicSnapshot(b), result: summarize(r) });
  }

  async function snapshotRoute(auth, id, sub, request) {
    if (request.method === 'PATCH' && !sub) {
      if (!can(auth, 'write')) return fail(403, 'This key cannot write', 'forbidden');
      const body = await readJson(request);
      const s = await db.updateSnapshotNote(auth.projectId, id, clean(body.note, 2000));
      return s ? json(200, publicSnapshot(s)) : fail(404, 'Snapshot not found', 'not_found');
    }
    if (!can(auth, 'read')) return fail(403, 'This key cannot read', 'forbidden');
    const s = await db.getSnapshot(auth.projectId, id);
    if (!s) return fail(404, 'Snapshot not found', 'not_found');
    if (!sub) return json(200, publicSnapshot(s));
    if (sub === 'image') {
      const buf = await storage.get(s.imageKey);
      return buf ? png(buf) : fail(404, 'Image missing from storage', 'not_found');
    }
    return fail(404, 'Not found', 'not_found');
  }

  // ---- dispatcher ------------------------------------------------------

  async function handle(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    try {
      const url = new URL(request.url);
      // Strip an optional /api prefix so the same router works behind any mount point.
      const route = url.pathname.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';

      if (route === '/v1/health' || route === '/health') {
        return json(200, { ok: true, db: db.kind, storage: storage.kind, version: '0.1.0' });
      }

      const auth = await authenticate(request, db);
      if (!auth) return fail(401, 'Missing or invalid API key', 'unauthorized');

      const m = request.method;
      if (route === '/v1/whoami' && m === 'GET') return json(200, { projectId: auth.projectId, key: auth.keyName, scopes: auth.scopes });
      if (route === '/v1/snapshots' && m === 'POST') return await createSnapshot(auth, request);
      if (route === '/v1/timeline' && m === 'GET') return await getTimeline(auth, url);
      if (route === '/v1/compare' && m === 'GET') return await compareTwo(auth, url);
      if (route === '/v1/baselines' && m === 'POST') return await approveBaseline(auth, request);
      if (route === '/v1/pages' && m === 'GET') {
        if (!can(auth, 'read')) return fail(403, 'This key cannot read', 'forbidden');
        return json(200, { pages: await db.listPages(auth.projectId) });
      }

      const sm = /^\/v1\/snapshots\/([\w-]{1,64})(?:\/(image))?$/.exec(route);
      if (sm && (m === 'GET' || m === 'PATCH')) return await snapshotRoute(auth, sm[1], sm[2], request);

      return fail(404, 'Not found', 'not_found');
    } catch (e) {
      if (e.status) return fail(e.status, e.message);
      console.error('[hub] unhandled error:', e);
      return fail(500, 'Internal error', 'internal');
    }
  }

  return { handle, verdictFor };
}
