/**
 * UI Regression Detector - Popup Controller
 */

import { getSnapshotsForUrl, deleteSnapshot } from '../utils/db.js';
import { compareImages } from '../utils/visual-diff.js';

let currentTab = null;
let pageSnapshots = [];

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

  // Load snapshots for current page
  await refreshPageHistory();
}

async function refreshPageHistory() {
  if (!currentTab || !currentTab.url) return;

  try {
    pageSnapshots = await getSnapshotsForUrl(currentTab.url);
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
  const label = labelInput.value.trim();

  try {
    captureBtn.classList.add('loading');
    captureBtn.disabled = true;
    showStatus('Capturing screen, DOM & CSS...', 'loading');

    const response = await chrome.runtime.sendMessage({
      action: 'TAKE_SNAPSHOT',
      payload: {
        label,
        tabId: currentTab.id
      }
    });

    if (!response || !response.success) {
      throw new Error(response ? response.error : 'Failed to capture snapshot.');
    }

    showStatus('Snapshot captured successfully!', 'success');
    labelInput.value = '';

    await refreshPageHistory();

    setTimeout(() => {
      hideStatus();
    }, 2500);
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

  // snapshots are sorted newest first
  const latest = snapshots[0];
  const previous = snapshots[1]; // baseline is immediate previous or first snapshot

  // Populate cards
  document.getElementById('label-baseline').textContent = previous.label || previous.dateFormatted;
  document.getElementById('thumb-baseline').innerHTML = `<img src="${previous.screenshot}" alt="Baseline" />`;

  document.getElementById('label-current').textContent = latest.label || latest.dateFormatted;
  document.getElementById('thumb-current').innerHTML = `<img src="${latest.screenshot}" alt="Latest" />`;

  badge.textContent = 'Calculating diff...';
  badge.className = 'badge';

  try {
    const diff = await compareImages(previous.screenshot, latest.screenshot);
    badge.textContent = `${diff.diffPercentage}% diff`;
    if (diff.diffPercentage === 0) {
      badge.classList.add('badge-pass');
    } else {
      badge.classList.add('badge-diff');
    }
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

    const isLatest = idx === 0;

    item.innerHTML = `
      <img src="${snap.screenshot}" alt="Thumb" class="item-thumb" />
      <div class="item-info">
        <span class="item-label truncate">${escapeHtml(snap.label)}</span>
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
      if (confirm(`Delete snapshot "${snap.label}"?`)) {
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

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

