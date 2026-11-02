/**
 * UI Regression Detector - IndexedDB Storage Helper
 * Provides high-capacity client-side persistence for snapshots,
 * including base64 screenshots, full DOM structures, and CSS styles.
 */

const DB_NAME = 'UIRegressionDetectorDB';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

let dbInstance = null;

export async function openDB() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('pageUrl', 'url', { unique: false });
        store.createIndex('domain', 'domain', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('groupKey', 'groupKey', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('Failed to open IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Save a new snapshot
 * @param {Object} snapshot 
 */
export async function saveSnapshot(snapshot) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(snapshot);

    req.onsuccess = () => resolve(snapshot);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve snapshot by ID
 * @param {string} id 
 */
export async function getSnapshot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve all snapshots, sorted newest first
 */
export async function getAllSnapshots() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => {
      const results = req.result || [];
      results.sort((a, b) => b.timestamp - a.timestamp);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve snapshots for a specific URL, newest first
 * @param {string} url 
 */
export async function getSnapshotsForUrl(url) {
  const all = await getAllSnapshots();
  // Match exact URL or normalized URL (without trailing slashes or hash)
  const norm = normalizeUrl(url);
  return all.filter(s => normalizeUrl(s.url) === norm);
}

/**
 * Delete a single snapshot by ID
 * @param {string} id 
 */
export async function deleteSnapshot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clear all snapshots for a given URL
 * @param {string} url 
 */
export async function clearSnapshotsForUrl(url) {
  const list = await getSnapshotsForUrl(url);
  for (const item of list) {
    await deleteSnapshot(item.id);
  }
}

/**
 * Clear all snapshots in database
 */
export async function clearAllSnapshots() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Export all data to JSON string
 */
export async function exportAllData() {
  const all = await getAllSnapshots();
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    count: all.length,
    snapshots: all
  }, null, 2);
}

/**
 * Import snapshots from parsed JSON object or array
 * @param {Array|Object} data 
 */
export async function importData(data) {
  const items = Array.isArray(data) ? data : (data.snapshots || []);
  let count = 0;
  for (const item of items) {
    if (item.id && item.url) {
      await saveSnapshot(item);
      count++;
    }
  }
  return count;
}

/**
 * Helper to normalize URLs for grouping
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch (e) {
    return url;
  }
}

