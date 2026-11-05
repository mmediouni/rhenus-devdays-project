/**
 * UI Regression Detector - Popup Controller
 */

import { getSnapshotsForPage, deleteSnapshot } from '../utils/db.js';
import { loadGroups, envLabel, pickDefaultPair } from '../utils/environments.js';
import { compareImages } from '../utils/visual-diff.js';
import { safeImageSrc, escapeHtml } from '../utils/common.js';
import { confirmDialog } from '../utils/ui.js';
import { loadHubSettings, saveHubSettings, testHubConnection, flushHubQueue, getPendingCount, isHubConfigured } from '../utils/hub.js';

let currentTab = null;
let pageSnapshots = [];
let envGroups = [];

/** "[test] " prefix when the page is shared by several environments, else '' */
function envPrefix(snap, snaps) {
  const domains = new Set(snaps.map(s => s.domain));
  return domains.size > 1 ? `[${envLabel(snap.domain, envGroups)}] ` : '';
}

document.addEventListener('DOMContentLoaded', async () => {
  await initPopup();
});

async function initPopup() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  if (!currentTab) {
    showStatus('No active browser tab found.', 'error');
    return;
  }

  // Update page info
  document.getElementById('page-title').textContent = currentTab.title || 'Untitled';
  document.getElementById('page-url').textContent = currentTab.url || '';

  // Attach event listeners
  document.getElementById('btn-capture').addEventListener('click', handleCapture);
  document.getElementById('snapshot-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCapture();
  });

  document.getElementById('btn-open-dashboard').addEventListener('click', () => {
    openDashboard();
  });
  document.getElementById('open-dashboard-top-btn').addEventListener('click', () => {
    openDashboard();
  });

  setupHubSettings();

  // Load snapshots for current page
  await refreshPageHistory();
}

// ---------------------------------------------------------------------------
// Hub sync settings
// ---------------------------------------------------------------------------

function hubFormValues() {
  return {
    enabled: document.getElementById('hub-enabled').checked,
    url: document.getElementById('hub-url').value,
    apiKey: document.getElementById('hub-key').value,
    labelMode: document.getElementById('hub-label-mode').value,
    label: document.getElementById('hub-label').value
  };
}

function showHubStatus(text, type) {
  const el = document.getElementById('hub-status');
  el.textContent = text;
  el.className = `status-msg ${type}`;
}

async function refreshHubBadge() {
  const badge = document.getElementById('hub-state');
  const settings = await loadHubSettings();
  const pending = await getPendingCount();
  if (!isHubConfigured(settings)) {
    badge.textContent = 'off';
    badge.className = 'hub-state';
  } else if (pending > 0) {
    badge.textContent = `${pending} pending`;
    badge.className = 'hub-state pending';
  } else {
    badge.textContent = 'on';
    badge.className = 'hub-state on';
  }
}

async function setupHubSettings() {
  const modeSel = document.getElementById('hub-label-mode');
  const labelInput = document.getElementById('hub-label');
  const syncLabelVisibility = () => labelInput.classList.toggle('hidden', modeSel.value !== 'custom');

  const s = await loadHubSettings();
  document.getElementById('hub-enabled').checked = s.enabled;
  document.getElementById('hub-url').value = s.url;
  document.getElementById('hub-key').value = s.apiKey;
  modeSel.value = s.labelMode;
  labelInput.value = s.labelMode === 'custom' ? s.label : '';
  syncLabelVisibility();
  modeSel.addEventListener('change', syncLabelVisibility);
  await refreshHubBadge();

  document.getElementById('btn-hub-test').addEventListener('click', async () => {
    showHubStatus('Testing connection...', 'loading');
    try {
      const r = await testHubConnection(hubFormValues());
      showHubStatus(`Connected. Key "${r.key}" (${(r.scopes || []).join(', ')})`, 'success');
    } catch (err) {
      showHubStatus(err.message, 'error');
    }
  });

  document.getElementById('btn-hub-save').addEventListener('click', async () => {
    try {
      const saved = await saveHubSettings(hubFormValues());
      if (document.getElementById('hub-url').value.trim() && !saved.url) {
        showHubStatus('Hub URL must start with http:// or https://', 'error');
        return;
      }
      document.getElementById('hub-url').value = saved.url;
      showHubStatus(saved.enabled ? 'Saved. New snapshots will be uploaded.' : 'Saved. Sync is off.', 'success');
      if (isHubConfigured(saved)) {
        const r = await flushHubQueue(saved);
        if (r.synced) showHubStatus(`Saved. Uploaded ${r.synced} queued snapshot(s).`, 'success');
      }
      await refreshHubBadge();
    } catch (err) {
      showHubStatus(err.message, 'error');
    }
  });
}

function describeHub(hub) {
  if (!hub || hub.status === 'off') return '';
  if (hub.status === 'synced') {
    const pct = hub.diffPercentage != null ? ` (${hub.diffPercentage}% changed)` : '';
    return hub.firstSnapshot ? ' Hub: first snapshot, saved as baseline.' : ` Hub: ${hub.verdict}${pct}.`;
  }
  if (hub.status === 'queued') return ' Hub unreachable: queued for retry.';
  return ` Hub upload failed: ${hub.error || 'unknown error'}.`;
}

async function refreshPageHistory() {
  if (!currentTab || !currentTab.url) return;

  try {
    envGroups = await loadGroups();
    pageSnapshots = await getSnapshotsForPage(currentTab.url, envGroups);
    document.getElementById('page-snapshot-count').textContent = pageSnapshots.length;

    renderHistoryList(pageSnapshots);
    await updateQuickCompare(pageSnapshots);
  } catch (err) {
    console.error('Error refreshing snapshots:', err);
  }
}

async function handleCapture() {
  const captureBtn = document.getElementById('btn-capture');
  const labelInput = document.getElementById('snapshot-label');
  const chkFullPage = document.getElementById('chk-fullpage');
  const label = labelInput.value.trim();
  const captureFullPage = chkFullPage ? chkFullPage.checked : true;

  try {
    captureBtn.classList.add('loading');
    captureBtn.disabled = true;
    showStatus(captureFullPage ? 'Capturing viewport, full page & DOM...' : 'Capturing viewport, DOM & CSS...', 'loading');

    const response = await chrome.runtime.sendMessage({
      action: 'TAKE_SNAPSHOT',
      payload: {
        label,
        captureFullPage,
        tabId: currentTab.id
      }
    });

    if (!response || !response.success) {
      throw new Error(response ? response.error : 'Failed to capture snapshot.');
    }

    const hubNote = describeHub(response.hub);
    const hubBad = response.hub && (response.hub.status === 'failed' || response.hub.status === 'queued');
    showStatus('Snapshot captured successfully!' + hubNote, hubBad ? 'error' : 'success');
    labelInput.value = '';

    await refreshPageHistory();
    await refreshHubBadge();

    setTimeout(() => {
      hideStatus();
    }, hubNote ? 6000 : 2500);
  } catch (err) {
    console.error('Capture error:', err);
    showStatus(err.message, 'error');
  } finally {
    captureBtn.classList.remove('loading');
    captureBtn.disabled = false;
  }
}

async function updateQuickCompare(snapshots) {
  const quickSection = document.getElementById('quick-compare-section');
  const badge = document.getElementById('quick-diff-badge');

  if (!snapshots || snapshots.length < 2) {
    quickSection.classList.add('hidden');
    return;
  }

  quickSection.classList.remove('hidden');

  // snapshots are sorted newest first. Same default as the dashboard: compare against the
  // newest snapshot from another environment when there is one (setting is shared via localStorage).
  let mode = 'auto';
  try { mode = JSON.parse(localStorage.getItem('urd:compareMode')) || 'auto'; } catch (e) { /* default */ }
  const { current: latest, baseline: previous } = pickDefaultPair(snapshots, mode);

  // Populate cards
  document.getElementById('label-baseline').textContent = envPrefix(previous, snapshots) + (previous.label || previous.dateFormatted);
  setThumb('thumb-baseline', previous.screenshot, 'Baseline');

  document.getElementById('label-current').textContent = envPrefix(latest, snapshots) + (latest.label || latest.dateFormatted);
  setThumb('thumb-current', latest.screenshot, 'Latest');

  badge.textContent = 'Calculating diff...';
  badge.className = 'badge';

  try {
    // Downscale: the badge only needs an approximate percentage
    const diff = await compareImages(previous.screenshot, latest.screenshot, { maxPixels: 600000 });
    badge.textContent = diff.sizeMismatch ? `${diff.diffPercentage}% diff (size differs)` : `${diff.diffPercentage}% diff`;
    badge.classList.add(diff.verdict === 'PASS' ? 'badge-pass' : 'badge-diff');
  } catch (e) {
    badge.textContent = 'Diff Ready';
  }

  const compareBtn = document.getElementById('btn-view-quick-diff');
  compareBtn.onclick = () => {
    openDashboard({
      pageUrl: currentTab.url,
      baselineId: previous.id,
      currentId: latest.id
    });
  };
}

function renderHistoryList(snapshots) {
  const container = document.getElementById('history-list');
  const emptyState = document.getElementById('empty-history');

  container.innerHTML = '';

  if (!snapshots || snapshots.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  snapshots.forEach((snap, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    item.innerHTML = `
      <img alt="Thumb" class="item-thumb" />
      <div class="item-info">
        <span class="item-label truncate">${escapeHtml(envPrefix(snap, snapshots) + snap.label)}</span>
        <span class="item-time">${snap.dateFormatted}</span>
      </div>
      <div class="item-actions">
        <button class="btn-icon-xs btn-open-item" title="Inspect in Dashboard" data-id="${snap.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
        <button class="btn-icon-xs btn-del-item" title="Delete Snapshot" data-id="${snap.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    item.querySelector('.item-thumb').src = safeImageSrc(snap.screenshot);

    // View button
    item.querySelector('.btn-open-item').addEventListener('click', () => {
      openDashboard({
        pageUrl: currentTab.url,
        currentId: snap.id
      });
    });

    // Delete button
    item.querySelector('.btn-del-item').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(`Delete snapshot "${snap.label}"?`)) {
        await deleteSnapshot(snap.id);
        await refreshPageHistory();
      }
    });

    container.appendChild(item);
  });
}

function openDashboard(params = {}) {
  const finalParams = {
    pageUrl: currentTab ? currentTab.url : '',
    ...params
  };

  chrome.runtime.sendMessage({
    action: 'OPEN_DASHBOARD',
    params: finalParams
  });
}

function showStatus(text, type = 'loading') {
  const el = document.getElementById('capture-status');
  el.textContent = text;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
}

function hideStatus() {
  const el = document.getElementById('capture-status');
  el.classList.add('hidden');
}

function setThumb(containerId, src, alt) {
  const container = document.getElementById(containerId);
  container.textContent = '';
  const img = document.createElement('img');
  img.alt = alt;
  img.src = safeImageSrc(src);
  container.appendChild(img);
}

