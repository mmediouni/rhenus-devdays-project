/**
 * Optional sync with a UI Regression Hub (see /server).
 * The extension works fully offline; this module only adds an upload on top.
 *
 * Settings live in chrome.storage.local. The hub allows cross-origin requests
 * (CORS) with bearer-key auth, so no extra host permission is needed.
 */

import { getSnapshot } from './db.js';

const SETTINGS_KEY = 'urd:hub';
const QUEUE_KEY = 'urd:hubQueue';
const RESULTS_KEY = 'urd:hubResults';
const MAX_QUEUE = 200;
const MAX_RESULTS = 300;
const REQUEST_TIMEOUT_MS = 30000;

export const DEFAULT_HUB_SETTINGS = Object.freeze({
  enabled: false,
  url: '',
  apiKey: '',
  // 'domain': label = hostname of the page (keeps each system's history separate)
  // 'custom': label = the fixed text below (environment, branch, build...)
  labelMode: 'domain',
  label: 'extension'
});

/** Accept only http(s) origins (+ optional path prefix). Returns '' when invalid. */
export function normalizeHubUrl(input) {
  if (typeof input !== 'string') return '';
  let u;
  try {
    u = new URL(input.trim());
  } catch (e) {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

export function sanitizeHubSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled === true,
    url: normalizeHubUrl(r.url || ''),
    apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim().slice(0, 300) : '',
    labelMode: r.labelMode === 'custom' ? 'custom' : 'domain',
    label: (typeof r.label === 'string' ? r.label.trim().slice(0, 100) : '') || DEFAULT_HUB_SETTINGS.label
  };
}

export function isHubConfigured(s) {
  return !!(s && s.enabled && s.url && s.apiKey);
}

export async function loadHubSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeHubSettings(stored[SETTINGS_KEY]);
  } catch (e) {
    return sanitizeHubSettings(null);
  }
}

export async function saveHubSettings(settings) {
  const clean = sanitizeHubSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  return clean;
}

export function labelFor(snapshot, settings) {
  if (settings.labelMode === 'custom') return settings.label;
  return snapshot.domain || 'default';
}

/** Pure: build the JSON body for POST /v1/snapshots. */
export function buildUploadBody(snapshot, settings) {
  const image = snapshot.fullScreenshot || snapshot.screenshot;
  const vp = snapshot.viewport || {};
  return {
    url: snapshot.url,
    label: labelFor(snapshot, settings),
    source: 'extension',
    image,
    viewport: vp.width ? { width: vp.width, height: vp.height || 0 } : undefined,
    meta: {
      title: snapshot.title || '',
      tag: snapshot.label || '',
      domain: snapshot.domain || '',
      capturedAt: snapshot.timestamp || null,
      extensionSnapshotId: snapshot.id,
      fullPage: !!snapshot.fullScreenshot && snapshot.fullScreenshot !== snapshot.screenshot,
      fullPageTruncated: !!snapshot.fullPageTruncated
    }
  };
}

class HubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function hubRequest(settings, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(settings.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    throw new HubError(e.name === 'AbortError' ? 'Hub request timed out' : `Cannot reach hub (${e.message})`, 0);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HubError(data.error || `Hub returned ${res.status}`, res.status);
  return data;
}

/** For the "Test connection" button. Does not need the sync to be enabled. */
export async function testHubConnection(settings) {
  const s = sanitizeHubSettings({ ...settings, enabled: true });
  if (!s.url) throw new Error('Enter a valid http(s) hub URL.');
  if (!s.apiKey) throw new Error('Enter an API key.');
  // health has no auth; whoami proves the key works
  const health = await fetch(s.url + '/v1/health').then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) throw new Error('Hub did not answer /v1/health. Check the URL.');
  const who = await hubRequest(s, 'GET', '/v1/whoami');
  return { scopes: who.scopes, key: who.key };
}

async function readJsonList(key) {
  try {
    const stored = await chrome.storage.local.get(key);
    return stored[key];
  } catch (e) {
    return undefined;
  }
}

async function enqueue(id) {
  const queue = (await readJsonList(QUEUE_KEY)) || [];
  if (!queue.includes(id)) queue.push(id);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
}

async function dequeue(id) {
  const queue = (await readJsonList(QUEUE_KEY)) || [];
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.filter((x) => x !== id) });
}

export async function getPendingCount() {
  const queue = (await readJsonList(QUEUE_KEY)) || [];
  return queue.length;
}

async function rememberResult(snapshotId, result) {
  const map = (await readJsonList(RESULTS_KEY)) || {};
  map[snapshotId] = { ...result, at: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > MAX_RESULTS) {
    keys.sort((a, b) => map[a].at - map[b].at);
    for (const k of keys.slice(0, keys.length - MAX_RESULTS)) delete map[k];
  }
  await chrome.storage.local.set({ [RESULTS_KEY]: map });
}

export async function getHubResult(snapshotId) {
  const map = (await readJsonList(RESULTS_KEY)) || {};
  return map[snapshotId] || null;
}

function summarize(data) {
  const cmp = data.vsBaseline || data.vsPrevious || null;
  return {
    hubId: data.id,
    verdict: data.verdict,
    diffPercentage: cmp ? cmp.diffPercentage : null,
    firstSnapshot: !!data.firstSnapshot
  };
}

/**
 * Upload one snapshot. Returns { status: 'synced'|'queued'|'failed'|'off', ... }.
 * Network errors and 5xx are queued for retry; 4xx (bad key, too large) are not.
 */
export async function syncSnapshotToHub(snapshot, settings) {
  const s = settings || (await loadHubSettings());
  if (!isHubConfigured(s)) return { status: 'off' };

  try {
    const data = await hubRequest(s, 'POST', '/v1/snapshots', buildUploadBody(snapshot, s));
    const out = { status: 'synced', ...summarize(data) };
    await rememberResult(snapshot.id, out);
    await dequeue(snapshot.id);
    return out;
  } catch (e) {
    const retryable = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
    if (retryable) {
      await enqueue(snapshot.id);
      return { status: 'queued', error: e.message };
    }
    const hint = e.status === 413 ? ' (image too large for this hub)' : '';
    return { status: 'failed', error: e.message + hint };
  }
}

/** Retry everything in the queue. Stops at the first connectivity failure. */
export async function flushHubQueue(settings) {
  const s = settings || (await loadHubSettings());
  if (!isHubConfigured(s)) return { synced: 0, remaining: await getPendingCount() };

  const queue = (await readJsonList(QUEUE_KEY)) || [];
  let synced = 0;
  for (const id of queue) {
    const snap = await getSnapshot(id);
    if (!snap) {
      await dequeue(id); // deleted locally in the meantime
      continue;
    }
    const r = await syncSnapshotToHub(snap, s);
    if (r.status === 'synced') synced++;
    else if (r.status === 'queued') break; // hub unreachable: try later
    else await dequeue(id); // permanent failure: do not retry forever
  }
  return { synced, remaining: await getPendingCount() };
}
