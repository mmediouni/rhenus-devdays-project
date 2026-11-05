/**
 * UI Regression Detector - IndexedDB Storage Helper
 * High-capacity client-side persistence for snapshots.
 */

import { normalizeUrl } from './common.js';

export { normalizeUrl };

const DB_NAME = 'UIRegressionDetectorDB';
const DB_VERSION = 2;
const STORE_NAME = 'snapshots';

let dbInstance = null;

export async function openDB() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;
      let store;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('pageUrl', 'url', { unique: false });
        store.createIndex('domain', 'domain', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('groupKey', 'groupKey', { unique: false });
      } else {
        store = tx.objectStore(STORE_NAME);
      }

      // v2: indexed, normalized page key (avoids loading every snapshot to filter by URL)
      if (!store.indexNames.contains('pageKey')) {
        store.createIndex('pageKey', 'pageKey', { unique: false });
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const value = cursor.value;
          value.pageKey = normalizeUrl(value.url);
          cursor.update(value);
          cursor.continue();
        };
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('Failed to open IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSnapshot(snapshot) {
  const db = await openDB();
  const record = { ...snapshot, pageKey: normalizeUrl(snapshot.url) };
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisify(tx.objectStore(STORE_NAME).put(record));
  return record;
}

export async function getSnapshot(id) {
  const db = await openDB();
  const result = await promisify(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id));
  return result || null;
}

/** All snapshots, newest first */
export async function getAllSnapshots() {
  const db = await openDB();
  const results = (await promisify(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll())) || [];
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}

/** Snapshots for a page (uses the pageKey index), newest first */
export async function getSnapshotsForUrl(url) {
  const db = await openDB();
  const index = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('pageKey');
  const results = (await promisify(index.getAll(normalizeUrl(url)))) || [];
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}

/** Number of snapshots for a page without loading their payloads */
export async function countSnapshotsForUrl(url) {
  const db = await openDB();
  const index = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('pageKey');
  return promisify(index.count(normalizeUrl(url)));
}

export async function deleteSnapshot(id) {
  const db = await openDB();
  await promisify(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id));
  return true;
}

export async function clearSnapshotsForUrl(url) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const index = tx.objectStore(STORE_NAME).index('pageKey');
  await new Promise((resolve, reject) => {
    const req = index.openKeyCursor(IDBKeyRange.only(normalizeUrl(url)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      tx.objectStore(STORE_NAME).delete(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Keep only the newest `max` snapshots of a page. Returns number deleted.
 */
export async function pruneSnapshotsForUrl(url, max, keepIds = []) {
  const list = await getSnapshotsForUrl(url);
  const keep = new Set(keepIds);
  let removed = 0;
  let kept = 0;
  for (const snap of list) {
    if (keep.has(snap.id) || kept < max) {
      kept++;
      continue;
    }
    await deleteSnapshot(snap.id);
    removed++;
  }
  return removed;
}

export async function clearAllSnapshots() {
  const db = await openDB();
  await promisify(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear());
  return true;
}

/** { usage, quota } in bytes, or null if unavailable */
export async function getStorageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch (e) { /* ignore */ }
  return null;
}

export async function exportAllData() {
  const all = await getAllSnapshots();
  return JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    count: all.length,
    snapshots: all
  }, null, 2);
}

const IMAGE_PREFIX = /^data:image\/(png|jpe?g|webp);base64,/;

/**
 * Validate and sanitize one imported record. Returns a clean record or null.
 */
export function sanitizeImportedSnapshot(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !/^[\w.-]{1,100}$/.test(item.id)) return null;
  if (typeof item.url !== 'string') return null;
  try {
    const u = new URL(item.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
  } catch (e) {
    return null;
  }
  if (typeof item.screenshot !== 'string' || !IMAGE_PREFIX.test(item.screenshot)) return null;

  const full = typeof item.fullScreenshot === 'string' && IMAGE_PREFIX.test(item.fullScreenshot)
    ? item.fullScreenshot
    : item.screenshot;

  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  const timestamp = Number.isFinite(item.timestamp) ? item.timestamp : Date.now();
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  return {
    id: item.id,
    timestamp,
    dateFormatted: str(item.dateFormatted, new Date(timestamp).toLocaleString()),
    url: item.url,
    domain: str(item.domain),
    path: str(item.path, '/'),
    groupKey: str(item.groupKey),
    pageKey: normalizeUrl(item.url),
    title: str(item.title, 'Untitled'),
    label: str(item.label, 'Imported snapshot'),
    screenshot: item.screenshot,
    fullScreenshot: full,
    fullPageFailed: !!item.fullPageFailed,
    viewport: obj(item.viewport),
    meta: obj(item.meta),
    dom: { html: str(obj(item.dom).html), stats: obj(obj(item.dom).stats) },
    css: {
      inlineStyles: Array.isArray(obj(item.css).inlineStyles) ? item.css.inlineStyles.filter(s => s && typeof s.cssText === 'string') : [],
      externalSheets: Array.isArray(obj(item.css).externalSheets) ? item.css.externalSheets : [],
      computedLandmarks: obj(obj(item.css).computedLandmarks)
    }
  };
}

/**
 * Import snapshots; returns { imported, skipped }.
 */
export async function importData(data) {
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.snapshots) ? data.snapshots : []);
  let imported = 0;
  let skipped = 0;
  for (const item of items) {
    const clean = sanitizeImportedSnapshot(item);
    if (clean) {
      await saveSnapshot(clean);
      imported++;
    } else {
      skipped++;
    }
  }
  return { imported, skipped };
}
