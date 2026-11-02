/**
 * UI Regression Detector - Background Service Worker
 * Coordinates tab capture, DOM/CSS extraction, and IndexedDB storage.
 */

import { saveSnapshot, getSnapshotsForUrl, getAllSnapshots, deleteSnapshot, clearAllSnapshots } from '../utils/db.js';

// Listen for messages from popup or dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TAKE_SNAPSHOT') {
    handleTakeSnapshot(message.payload)
      .then(result => sendResponse({ success: true, snapshot: result }))
      .catch(err => {
        console.error('[Service Worker] Error taking snapshot:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // asynchronous keep-alive
  }

  if (message.action === 'OPEN_DASHBOARD') {
    handleOpenDashboard(message.params)
      .then(tab => sendResponse({ success: true, tabId: tab.id }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Executes full snapshot capture for the active tab
 */
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

  if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://') || activeTab.url.startsWith('about:')) {
    throw new Error('Cannot capture system browser pages. Please open a regular web page.');
  }

  // 1. Ensure content script is available and collect DOM / CSS
  let pageData;
  try {
    pageData = await sendTabMessageWithRetry(activeTab.id, { action: 'EXTRACT_PAGE_SNAPSHOT' });
  } catch (err) {
    // If not injected, dynamically inject content script and retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content/content.js']
      });
      // Small delay for execution
      await new Promise(r => setTimeout(r, 100));
      pageData = await sendTabMessageWithRetry(activeTab.id, { action: 'EXTRACT_PAGE_SNAPSHOT' });
    } catch (injectErr) {
      throw new Error(`Failed to extract page data: ${injectErr.message}`);
    }
  }

  if (!pageData || !pageData.data) {
    throw new Error('No data received from page content script.');
  }

  // 2. Capture high-resolution visible viewport screenshot
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
    format: 'png'
  });

  // 3. Capture full-page stitched screenshot (top to bottom)
  let fullScreenshotDataUrl = null;
  const captureFull = payload.captureFullPage !== false; // default true
  if (captureFull && pageData.data.viewport) {
    try {
      fullScreenshotDataUrl = await captureFullPageStitched(activeTab.id, activeTab.windowId, pageData.data.viewport);
    } catch (fullErr) {
      console.warn('[Service Worker] Full-page capture failed, falling back to viewport:', fullErr);
      fullScreenshotDataUrl = screenshotDataUrl;
    }
  } else {
    fullScreenshotDataUrl = screenshotDataUrl;
  }

  // 4. Assemble snapshot record
  const timestamp = Date.now();
  const dateObj = new Date(timestamp);
  const dateFormatted = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();

  let domain = 'unknown';
  let path = '/';
  try {
    const parsed = new URL(activeTab.url);
    domain = parsed.hostname;
    path = parsed.pathname;
  } catch (e) {
    domain = activeTab.url;
  }

  const groupKey = `${domain}${path.replace(/\/$/, '')}`;

  const snapshot = {
    id: `snap_${timestamp}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp,
    dateFormatted,
    url: activeTab.url,
    domain,
    path,
    groupKey,
    title: activeTab.title || 'Untitled',
    label: label.trim() || `Snapshot at ${dateObj.toLocaleTimeString()}`,
    screenshot: screenshotDataUrl,
    fullScreenshot: fullScreenshotDataUrl || screenshotDataUrl,
    viewport: pageData.data.viewport,
    meta: pageData.data.meta,
    dom: pageData.data.dom,
    css: pageData.data.css
  };

  // 4. Persist in IndexedDB
  await saveSnapshot(snapshot);

  // 5. Update badge on extension icon
  const pageSnapshots = await getSnapshotsForUrl(activeTab.url);
  chrome.action.setBadgeText({
    tabId: activeTab.id,
    text: String(pageSnapshots.length)
  });
  chrome.action.setBadgeBackgroundColor({
    tabId: activeTab.id,
    color: '#06b6d4' // cyan badge
  });

  return snapshot;
}

/**
 * Open or activate the Dashboard tab
 */
async function handleOpenDashboard(params = {}) {
  const dashboardUrl = chrome.runtime.getURL('dashboard/dashboard.html');
  let url = dashboardUrl;

  const queryParts = [];
  if (params.pageUrl) queryParts.push(`url=${encodeURIComponent(params.pageUrl)}`);
  if (params.baselineId) queryParts.push(`baseline=${encodeURIComponent(params.baselineId)}`);
  if (params.currentId) queryParts.push(`current=${encodeURIComponent(params.currentId)}`);

  if (queryParts.length > 0) {
    url += '?' + queryParts.join('&');
  }

  // Check if dashboard tab is already open
  const tabs = await chrome.tabs.query({ url: `${dashboardUrl}*` });
  if (tabs.length > 0) {
    const existing = tabs[0];
    await chrome.tabs.update(existing.id, { active: true, url });
    return existing;
  } else {
    return await chrome.tabs.create({ url });
  }
}

/**
 * Send message to tab with timeout
 */
function sendTabMessageWithRetry(tabId, message) {
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
 * Capture full-page screenshot by scrolling and stitching slices
 */
async function captureFullPageStitched(tabId, windowId, viewport) {
  const { width, height, dpr = 1, scrollHeight, scrollX: origX = 0, scrollY: origY = 0 } = viewport;
  const totalHeight = Math.max(height, scrollHeight);

  // If page does not exceed visible viewport, no need to stitch
  if (totalHeight <= height) {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  // Calculate slice Y positions
  const slices = [];
  let curY = 0;
  while (curY < totalHeight) {
    slices.push(curY);
    if (curY + height >= totalHeight) break;
    curY += height;
    if (curY + height > totalHeight) {
      curY = totalHeight - height;
    }
  }

  const capturedSlices = [];

  try {
    for (let i = 0; i < slices.length; i++) {
      const yPos = slices[i];
      const isFirst = i === 0;

      // Scroll to slice position (hide sticky/fixed headers after first slice)
      await sendTabMessageWithRetry(tabId, {
        action: 'SCROLL_FOR_FULLPAGE_SLICE',
        payload: { x: 0, y: yPos, hideFixed: !isFirst }
      });

      // Small delay for browser rendering/paint to settle
      await new Promise(r => setTimeout(r, 120));

      const sliceDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      capturedSlices.push({
        yPos,
        dataUrl: sliceDataUrl
      });
    }
  } finally {
    // Always restore scroll position and unhide fixed elements
    await sendTabMessageWithRetry(tabId, {
      action: 'RESTORE_AFTER_FULLPAGE',
      payload: { originalScrollX: origX, originalScrollY: origY }
    });
  }

  // Stitch slices onto an OffscreenCanvas
  const canvasWidth = Math.round(width * dpr);
  const canvasHeight = Math.round(totalHeight * dpr);
  const offscreen = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = offscreen.getContext('2d');

  for (const slice of capturedSlices) {
    const res = await fetch(slice.dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    const destY = Math.round(slice.yPos * dpr);
    ctx.drawImage(bitmap, 0, destY);
  }

  const resultBlob = await offscreen.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(resultBlob);
}

/**
 * Convert Blob to Data URL in service worker without FileReader
 */
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

