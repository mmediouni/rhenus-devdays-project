/**
 * UI Regression Detector - Background Service Worker
 * Coordinates tab capture, DOM/CSS extraction, and IndexedDB storage.
 */

import { saveSnapshot, countSnapshotsForUrl, pruneSnapshotsForUrl } from '../utils/db.js';
import { syncSnapshotToHub, flushHubQueue } from '../utils/hub.js';

const MAX_SNAPSHOTS_PER_PAGE = 30;
const MIN_CAPTURE_INTERVAL_MS = 600; // captureVisibleTab is rate limited (~2/s)
const MAX_CANVAS_DIM = 16000;
const RESTRICTED_PREFIXES = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'devtools://', 'view-source:', 'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TAKE_SNAPSHOT') {
    handleTakeSnapshot(message.payload)
      .then(result => sendResponse({ success: true, snapshot: { id: result.id, label: result.label }, hub: result.hub }))
      .catch(err => {
        console.error('[Service Worker] Error taking snapshot:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'OPEN_DASHBOARD') {
    handleOpenDashboard(message.params)
      .then(tab => sendResponse({ success: true, tabId: tab.id }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

let lastCaptureAt = 0;

/** Rate-limit-safe wrapper around captureVisibleTab */
async function captureTab(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } finally {
    lastCaptureAt = Date.now();
  }
}

async function handleTakeSnapshot(payload = {}) {
  const { label = '', tabId = null } = payload;

  let activeTab;
  if (tabId) {
    activeTab = await chrome.tabs.get(tabId);
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  }

  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found.');
  }

  const tabUrl = activeTab.url || activeTab.pendingUrl || '';
  if (!tabUrl || RESTRICTED_PREFIXES.some(p => tabUrl.startsWith(p))) {
    throw new Error('Cannot capture this page (system page or no access). Open a regular web page and click the extension icon on it.');
  }

  const tabId_ = activeTab.id;

  // 1. Inject content script on demand (idempotent), then freeze animations / wait for fonts
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId_ }, files: ['content/content.js'] });
  } catch (injectErr) {
    throw new Error(`Cannot access this page: ${injectErr.message}`);
  }

  let pageData;
  let screenshotDataUrl;
  let fullScreenshotDataUrl = null;
  let fullPageFailed = false;
  let fullPageTruncated = false;
  const captureFull = payload.captureFullPage !== false;

  try {
    await sendTabMessage(tabId_, { action: 'PREPARE_CAPTURE' });

    // 2. Collect DOM / CSS / viewport
    pageData = await sendTabMessage(tabId_, { action: 'EXTRACT_PAGE_SNAPSHOT' });
    if (!pageData || !pageData.data) {
      throw new Error('No data received from page content script.');
    }

    // 3. Visible viewport screenshot
    screenshotDataUrl = await captureTab(activeTab.windowId);

    // 4. Full-page stitched screenshot
    if (captureFull && pageData.data.viewport) {
      try {
        const result = await captureFullPageStitched(tabId_, activeTab.windowId, pageData.data.viewport);
        fullScreenshotDataUrl = result.dataUrl;
        fullPageTruncated = result.truncated;
      } catch (fullErr) {
        console.warn('[Service Worker] Full-page capture failed, falling back to viewport:', fullErr);
        fullPageFailed = true;
      }
    }
  } finally {
    // Always restore scroll position, unhide fixed elements and unfreeze animations
    const vp = (pageData && pageData.data && pageData.data.viewport) || {};
    try {
      await sendTabMessage(tabId_, {
        action: 'RESTORE_AFTER_FULLPAGE',
        payload: { originalScrollX: vp.scrollX || 0, originalScrollY: vp.scrollY || 0 }
      });
    } catch (e) { /* tab may have navigated */ }
  }

  // 5. Assemble snapshot record
  const timestamp = Date.now();
  const dateObj = new Date(timestamp);
  const dateFormatted = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();

  let domain = 'unknown';
  let path = '/';
  try {
    const parsed = new URL(tabUrl);
    domain = parsed.hostname;
    path = parsed.pathname;
  } catch (e) {
    domain = tabUrl;
  }

  const snapshot = {
    id: `snap_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    dateFormatted,
    url: tabUrl,
    domain,
    path,
    groupKey: `${domain}${path.replace(/\/$/, '')}`,
    title: activeTab.title || 'Untitled',
    label: label.trim() || `Snapshot at ${dateObj.toLocaleTimeString()}`,
    screenshot: screenshotDataUrl,
    fullScreenshot: fullScreenshotDataUrl || screenshotDataUrl,
    fullPageFailed: captureFull ? fullPageFailed : false,
    fullPageTruncated,
    viewport: pageData.data.viewport,
    meta: pageData.data.meta,
    dom: pageData.data.dom,
    css: pageData.data.css
  };

  // 6. Persist, then enforce retention
  await saveSnapshot(snapshot);
  await pruneSnapshotsForUrl(tabUrl, MAX_SNAPSHOTS_PER_PAGE, [snapshot.id]);

  // 7. Badge
  const count = await countSnapshotsForUrl(tabUrl);
  chrome.action.setBadgeText({ tabId: tabId_, text: String(count) });
  chrome.action.setBadgeBackgroundColor({ tabId: tabId_, color: '#06b6d4' });

  // 8. Optional hub sync. The local snapshot is already safe, so a hub problem
  //    never fails the capture; it is reported and queued for retry instead.
  let hub = { status: 'off' };
  try {
    hub = await syncSnapshotToHub(snapshot);
    if (hub.status === 'synced') await flushHubQueue();
  } catch (e) {
    console.warn('[Service Worker] Hub sync error:', e);
    hub = { status: 'failed', error: e.message };
  }

  return { id: snapshot.id, label: snapshot.label, hub };
}

// Retry queued uploads when the browser starts.
chrome.runtime.onStartup.addListener(() => {
  flushHubQueue().catch(e => console.warn('[Service Worker] Hub queue flush failed:', e));
});

/**
 * Open or focus the Dashboard tab. The tab id is remembered in session storage,
 * so no broad "tabs" permission is needed to find it.
 */
async function handleOpenDashboard(params = {}) {
  const dashboardUrl = chrome.runtime.getURL('dashboard/dashboard.html');
  const query = new URLSearchParams();
  if (params.pageUrl) query.set('url', params.pageUrl);
  if (params.baselineId) query.set('baseline', params.baselineId);
  if (params.currentId) query.set('current', params.currentId);
  const qs = query.toString();
  const url = qs ? `${dashboardUrl}?${qs}` : dashboardUrl;

  const stored = await chrome.storage.session.get('dashboardTabId');
  if (stored.dashboardTabId) {
    try {
      const existing = await chrome.tabs.get(stored.dashboardTabId);
      if (existing && existing.id) {
        await chrome.tabs.update(existing.id, { active: true, url });
        await chrome.windows.update(existing.windowId, { focused: true });
        return existing;
      }
    } catch (e) { /* tab was closed */ }
  }

  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ dashboardTabId: tab.id });
  return tab;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(response);
    });
  });
}

/**
 * Capture full-page screenshot by scrolling and stitching slices.
 * Returns { dataUrl, truncated }.
 */
async function captureFullPageStitched(tabId, windowId, viewport) {
  const { height, dpr = 1, scrollHeight } = viewport;
  let totalHeight = Math.max(height, scrollHeight);

  if (totalHeight <= height) {
    return { dataUrl: await captureTab(windowId), truncated: false };
  }

  // Canvas dimension limits: cap very tall pages
  let truncated = false;
  const maxCssHeight = Math.floor(MAX_CANVAS_DIM / dpr);
  if (totalHeight > maxCssHeight) {
    totalHeight = maxCssHeight;
    truncated = true;
  }

  const slices = [];
  let curY = 0;
  while (curY < totalHeight) {
    slices.push(curY);
    if (curY + height >= totalHeight) break;
    curY += height;
    if (curY + height > totalHeight) curY = totalHeight - height;
  }

  const capturedSlices = [];

  for (let i = 0; i < slices.length; i++) {
    const res = await sendTabMessage(tabId, {
      action: 'SCROLL_FOR_FULLPAGE_SLICE',
      payload: { x: 0, y: slices[i], hideFixed: i > 0 }
    });
    const dataUrl = await captureTab(windowId);
    capturedSlices.push({
      yPos: res && res.success && Number.isFinite(res.actualY) ? res.actualY : slices[i],
      dataUrl
    });
  }

  // Stitch onto an OffscreenCanvas. Pixel scale is derived from the real capture width.
  const bitmaps = [];
  for (const slice of capturedSlices) {
    const blob = await (await fetch(slice.dataUrl)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }

  const pxPerCss = bitmaps[0].width / viewport.width;
  const canvasWidth = bitmaps[0].width;
  const canvasHeight = Math.round(totalHeight * pxPerCss);
  const offscreen = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = offscreen.getContext('2d');

  capturedSlices.forEach((slice, i) => {
    ctx.drawImage(bitmaps[i], 0, Math.round(slice.yPos * pxPerCss));
    bitmaps[i].close();
  });

  const resultBlob = await offscreen.convertToBlob({ type: 'image/png' });
  return { dataUrl: await blobToDataUrl(resultBlob), truncated };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
