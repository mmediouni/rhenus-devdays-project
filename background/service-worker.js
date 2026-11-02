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

  // 2. Capture high-resolution screenshot
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
    format: 'png'
  });

  // 3. Assemble snapshot record
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

