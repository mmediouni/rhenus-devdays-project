/**
 * UI Regression Detector - Dashboard Controller
 * Full-featured analysis studio for visual regressions, code/DOM diffs,
 * CSS landmark inspections, and exportable reports.
 */

import {
  getAllSnapshots,
  getSnapshot,
  deleteSnapshot,
  clearAllSnapshots,
  exportAllData,
  importData
} from '../utils/db.js';

import { compareImages } from '../utils/visual-diff.js';
import {
  computeTextDiff,
  compareLandmarkStyles,
  compareDomStats
} from '../utils/text-diff.js';

// State
let allSnapshots = [];
let filteredSnapshots = [];
let groupedPages = new Map(); // normalizedUrl -> array of snapshots
let selectedPageKey = null;

let baselineSnap = null;
let currentSnap = null;
let currentDiffResult = null;
let activeVisualMode = 'side-by-side';
let activeCodeDiffMode = 'unified'; // or 'split'

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadDataFromUrlParamsOrStorage();
});

function setupEventListeners() {
  // Search & Filter
  document.getElementById('search-input').addEventListener('input', handleFilterChange);
  document.getElementById('domain-select').addEventListener('change', handleFilterChange);

  // Snapshot Selectors in Header
  document.getElementById('select-baseline').addEventListener('change', (e) => {
    setBaseline(e.target.value);
  });
  document.getElementById('select-current').addEventListener('change', (e) => {
    setCurrent(e.target.value);
  });

  // Tab Navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Visual mode segments (Side-by-side, slider, diff-mask, onion)
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setVisualMode(btn.dataset.mode);
    });
  });

  // Code Diff view toggle (unified vs split)
  document.getElementById('btn-diff-unified').addEventListener('click', () => {
    setCodeDiffMode('unified');
  });
  document.getElementById('btn-diff-split').addEventListener('click', () => {
    setCodeDiffMode('split');
  });

  // Onion skin slider
  const onionSlider = document.getElementById('onion-slider');
  onionSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    document.getElementById('onion-val').textContent = `${val}% Blend`;
    const curImg = document.getElementById('onion-img-current');
    if (curImg) curImg.style.opacity = val / 100;
  });

  // Slider Wipe draggable handle
  setupSliderHandle();

  // Export HTML Report
  document.getElementById('btn-export-report').addEventListener('click', exportHtmlReport);

  // Backup & Import
  document.getElementById('btn-export-json').addEventListener('click', handleExportJson);
  document.getElementById('input-import-json').addEventListener('change', handleImportJson);

  // Clear data
  document.getElementById('btn-clear-all').addEventListener('click', handleClearAll);
}

/**
 * Reads URL params (?url=...&baseline=...&current=...) or loads default
 */
async function loadDataFromUrlParamsOrStorage() {
  allSnapshots = await getAllSnapshots();
  rebuildPageGroups();
  populateDomainDropdown();
  updateTopMetrics();

  const urlParams = new URLSearchParams(window.location.search);
  const targetUrl = urlParams.get('url');
  const targetBaseline = urlParams.get('baseline');
  const targetCurrent = urlParams.get('current');

  if (groupedPages.size === 0) {
    showEmptyWorkspace();
    return;
  }

  // Determine initial page
  if (targetUrl && groupedPages.has(normalizeUrlKey(targetUrl))) {
    selectedPageKey = normalizeUrlKey(targetUrl);
  } else {
    // Select first available page group
    selectedPageKey = groupedPages.keys().next().value;
  }

  renderPageList();
  renderTimelineForSelectedPage();

  const snapsForPage = groupedPages.get(selectedPageKey) || [];
  if (snapsForPage.length > 0) {
    if (targetCurrent && snapsForPage.find(s => s.id === targetCurrent)) {
      currentSnap = snapsForPage.find(s => s.id === targetCurrent);
    } else {
      currentSnap = snapsForPage[0]; // newest
    }

    if (targetBaseline && snapsForPage.find(s => s.id === targetBaseline)) {
      baselineSnap = snapsForPage.find(s => s.id === targetBaseline);
    } else {
      // baseline is previous or first snapshot
      baselineSnap = snapsForPage.length > 1 ? snapsForPage[1] : snapsForPage[0];
    }
  }

  updateComparisonDropdowns();
  await runComparison();
}

function rebuildPageGroups() {
  groupedPages.clear();
  for (const s of allSnapshots) {
    const key = normalizeUrlKey(s.url);
    if (!groupedPages.has(key)) {
      groupedPages.set(key, []);
    }
    groupedPages.get(key).push(s);
  }

  // Sort each page's snapshots newest first
  for (const list of groupedPages.values()) {
    list.sort((a, b) => b.timestamp - a.timestamp);
  }
}

function normalizeUrlKey(url) {
  try {
    const p = new URL(url);
    return `${p.origin}${p.pathname.replace(/\/$/, '')}`;
  } catch (e) {
    return url;
  }
}

function populateDomainDropdown() {
  const select = document.getElementById('domain-select');
  const domains = new Set();
  for (const s of allSnapshots) {
    if (s.domain) domains.add(s.domain);
  }

  select.innerHTML = '<option value="ALL">All Domains</option>';
  for (const d of Array.from(domains).sort()) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  }
}

function updateTopMetrics() {
  document.getElementById('metric-pages').textContent = groupedPages.size;
  document.getElementById('metric-snapshots').textContent = allSnapshots.length;
}

function handleFilterChange() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const domainFilter = document.getElementById('domain-select').value;

  renderPageList(query, domainFilter);
}

function renderPageList(query = '', domainFilter = 'ALL') {
  const listEl = document.getElementById('page-list');
  listEl.innerHTML = '';

  let count = 0;
  for (const [key, snaps] of groupedPages.entries()) {
    const sample = snaps[0];
    if (domainFilter !== 'ALL' && sample.domain !== domainFilter) continue;

    if (query) {
      const matchTitle = sample.title && sample.title.toLowerCase().includes(query);
      const matchUrl = sample.url && sample.url.toLowerCase().includes(query);
      const matchLabel = snaps.some(s => s.label && s.label.toLowerCase().includes(query));
      if (!matchTitle && !matchUrl && !matchLabel) continue;
    }

    count++;
    const item = document.createElement('div');
    item.className = `page-item ${key === selectedPageKey ? 'active' : ''}`;
    item.innerHTML = `
      <span class="page-item-title truncate">${escapeHtml(sample.title || sample.domain)}</span>
      <span class="page-item-url truncate">${escapeHtml(sample.url)}</span>
      <span class="badge" style="align-self: flex-start; margin-top: 2px;">${snaps.length} snap${snaps.length > 1 ? 's' : ''}</span>
    `;

    item.addEventListener('click', () => {
      selectedPageKey = key;
      renderPageList(query, domainFilter);
      renderTimelineForSelectedPage();

      const pageSnaps = groupedPages.get(key) || [];
      currentSnap = pageSnaps[0] || null;
      baselineSnap = pageSnaps.length > 1 ? pageSnaps[1] : pageSnaps[0] || null;

      updateComparisonDropdowns();
      runComparison();
    });

    listEl.appendChild(item);
  }

  document.getElementById('page-list-count').textContent = count;
}

function renderTimelineForSelectedPage() {
  const listEl = document.getElementById('timeline-list');
  listEl.innerHTML = '';

  const pageSnaps = groupedPages.get(selectedPageKey) || [];
  document.getElementById('timeline-count').textContent = pageSnaps.length;

  if (pageSnaps.length === 0) {
    listEl.innerHTML = '<div class="diff-empty">No snapshots for this page.</div>';
    return;
  }

  pageSnaps.forEach((snap, idx) => {
    const card = document.createElement('div');
    const isBase = baselineSnap && baselineSnap.id === snap.id;
    const isCur = currentSnap && currentSnap.id === snap.id;

    card.className = `timeline-card ${isBase ? 'is-baseline' : ''} ${isCur ? 'is-current' : ''}`;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-label truncate">${escapeHtml(snap.label)}</span>
        <div class="card-role-badges">
          ${isBase ? '<span class="role-badge badge-a">Baseline A</span>' : ''}
          ${isCur ? '<span class="role-badge badge-b">Current B</span>' : ''}
        </div>
      </div>
      <div class="card-body">
        <img src="${snap.screenshot}" alt="Thumb" class="card-thumb" />
        <div class="card-meta">
          <span>📅 ${snap.dateFormatted}</span>
          <span>📐 ${snap.viewport?.width || '--'}x${snap.viewport?.height || '--'}</span>
          <span>🏷️ ${snap.dom?.stats?.elementsTotal || '--'} elements</span>
        </div>
      </div>
      <div class="card-actions">
        <div class="role-buttons">
          <button class="btn-role ${isBase ? 'active-a' : ''}" data-role="A">Set as A</button>
          <button class="btn-role ${isCur ? 'active-b' : ''}" data-role="B">Set as B</button>
        </div>
        <button class="btn-del-snap" title="Delete snapshot" data-id="${snap.id}">✕</button>
      </div>
    `;

    // Role A / B buttons
    card.querySelector('[data-role="A"]').addEventListener('click', () => {
      setBaseline(snap.id);
    });
    card.querySelector('[data-role="B"]').addEventListener('click', () => {
      setCurrent(snap.id);
    });

    // Delete snapshot
    card.querySelector('.btn-del-snap').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete snapshot "${snap.label}"?`)) {
        await deleteSnapshot(snap.id);
        allSnapshots = await getAllSnapshots();
        rebuildPageGroups();
        renderPageList();
        renderTimelineForSelectedPage();
        updateTopMetrics();
        await runComparison();
      }
    });

    listEl.appendChild(card);
  });
}

function updateComparisonDropdowns() {
  const selectBase = document.getElementById('select-baseline');
  const selectCur = document.getElementById('select-current');
  selectBase.innerHTML = '';
  selectCur.innerHTML = '';

  const pageSnaps = groupedPages.get(selectedPageKey) || [];

  pageSnaps.forEach(s => {
    const optBase = document.createElement('option');
    optBase.value = s.id;
    optBase.textContent = `${s.label} (${s.dateFormatted.split(' ')[1] || ''})`;
    selectBase.appendChild(optBase);

    const optCur = document.createElement('option');
    optCur.value = s.id;
    optCur.textContent = `${s.label} (${s.dateFormatted.split(' ')[1] || ''})`;
    selectCur.appendChild(optCur);
  });

  if (baselineSnap) selectBase.value = baselineSnap.id;
  if (currentSnap) selectCur.value = currentSnap.id;
}

function setBaseline(id) {
  const found = allSnapshots.find(s => s.id === id);
  if (found) {
    baselineSnap = found;
    updateComparisonDropdowns();
    renderTimelineForSelectedPage();
    runComparison();
  }
}

function setCurrent(id) {
  const found = allSnapshots.find(s => s.id === id);
  if (found) {
    currentSnap = found;
    updateComparisonDropdowns();
    renderTimelineForSelectedPage();
    runComparison();
  }
}

/**
 * Runs full comparison (Visual, DOM, CSS, Meta) between baselineSnap & currentSnap
 */
async function runComparison() {
  if (!baselineSnap || !currentSnap) {
    showDiffCardState('Ready', 'Select two snapshots to compare', 'pass');
    return;
  }

  // Update timestamps
  document.getElementById('header-baseline-time').textContent = `${baselineSnap.label} • ${baselineSnap.dateFormatted}`;
  document.getElementById('header-current-time').textContent = `${currentSnap.label} • ${currentSnap.dateFormatted}`;

  // 1. Visual comparison
  try {
    currentDiffResult = await compareImages(baselineSnap.screenshot, currentSnap.screenshot);
    renderVisualComparison(currentDiffResult);
  } catch (err) {
    console.error('Visual compare error:', err);
  }

  // 2. DOM / Code comparison
  renderDomComparison();

  // 3. CSS Landmarks & Stylesheets comparison
  renderCssComparison();

  // 4. Metadata comparison
  renderMetadataComparison();
}

function renderVisualComparison(diff) {
  const card = document.getElementById('diff-summary-card');
  const verdictEl = document.getElementById('diff-verdict-title');
  const badgeEl = document.getElementById('diff-percent-badge');
  const statsEl = document.getElementById('diff-stats-detail');
  const iconEl = document.getElementById('diff-status-icon');

  badgeEl.textContent = `${diff.diffPercentage}% Diff`;
  statsEl.textContent = `${diff.diffPixels.toLocaleString()} of ${diff.totalPixels.toLocaleString()} pixels changed`;

  card.classList.remove('status-pass', 'status-warning', 'status-regression');

  if (diff.diffPercentage === 0) {
    card.classList.add('status-pass');
    verdictEl.textContent = 'Pixel Perfect Match';
    iconEl.textContent = '✓';
    document.getElementById('metric-status').textContent = 'Match';
    document.getElementById('metric-status').className = 'metric-value status-ready';
  } else if (diff.diffPercentage < 0.2) {
    card.classList.add('status-warning');
    verdictEl.textContent = 'Minor Variation';
    iconEl.textContent = '⚠';
    document.getElementById('metric-status').textContent = 'Minor Diff';
    document.getElementById('metric-status').className = 'metric-value';
  } else {
    card.classList.add('status-regression');
    verdictEl.textContent = 'UI Regression Detected';
    iconEl.textContent = '!';
    document.getElementById('metric-status').textContent = 'Regression';
    document.getElementById('metric-status').className = 'metric-value';
  }

  // Side-by-side images
  document.getElementById('img-baseline').src = baselineSnap.screenshot;
  document.getElementById('img-current').src = currentSnap.screenshot;

  // Slider Wipe images
  document.getElementById('slider-img-baseline').src = baselineSnap.screenshot;
  document.getElementById('slider-img-current').src = currentSnap.screenshot;

  // Diff Mask
  document.getElementById('img-diff-mask').src = diff.diffDataUrl || baselineSnap.screenshot;

  // Onion skin
  document.getElementById('onion-img-baseline').src = baselineSnap.screenshot;
  document.getElementById('onion-img-current').src = currentSnap.screenshot;
}

function renderDomComparison() {
  const domA = baselineSnap.dom || {};
  const domB = currentSnap.dom || {};

  // Render node summary metrics
  const cardsContainer = document.getElementById('dom-summary-cards');
  const comparisons = compareDomStats(domA, domB);
  cardsContainer.innerHTML = '';

  comparisons.forEach(item => {
    const card = document.createElement('div');
    card.className = 'stat-metric-card';
    const deltaClass = item.delta > 0 ? 'delta-pos' : item.delta < 0 ? 'delta-neg' : 'delta-zero';
    const deltaPrefix = item.delta > 0 ? '+' : '';

    card.innerHTML = `
      <span class="stat-metric-name">${item.metric}</span>
      <div class="stat-metric-values">
        <span class="stat-metric-val">${item.current}</span>
        <span class="stat-metric-delta ${deltaClass}">(${deltaPrefix}${item.delta})</span>
      </div>
    `;
    cardsContainer.appendChild(card);
  });

  // Calculate text diff
  const textA = domA.html || '';
  const textB = domB.html || '';
  const diffResult = computeTextDiff(textA, textB);

  document.getElementById('dom-add-count').textContent = `+${diffResult.stats.added}`;
  document.getElementById('dom-del-count').textContent = `-${diffResult.stats.deleted}`;
  document.getElementById('dom-eq-count').textContent = diffResult.stats.unchanged;

  const codeDiffContainer = document.getElementById('code-diff-output');
  if (activeCodeDiffMode === 'split') {
    codeDiffContainer.innerHTML = diffResult.renderSplitHtml();
  } else {
    codeDiffContainer.innerHTML = diffResult.renderUnifiedHtml();
  }
}

function renderCssComparison() {
  const cssA = baselineSnap.css || {};
  const cssB = currentSnap.css || {};

  // Landmarks table
  const changes = compareLandmarkStyles(cssA.computedLandmarks || {}, cssB.computedLandmarks || {});
  const tableWrap = document.getElementById('css-landmarks-table');

  if (changes.length === 0) {
    tableWrap.innerHTML = `
      <div class="diff-empty" style="color: var(--green);">
        ✓ No computed style changes detected across standard landmarks (body, headers, buttons, nav).
      </div>
    `;
  } else {
    let html = `
      <table class="landmarks-table">
        <thead>
          <tr>
            <th>Element / Selector</th>
            <th>CSS Property</th>
            <th>Baseline (A)</th>
            <th>Current (B)</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const change of changes) {
      for (const prop of change.changedProps) {
        html += `
          <tr class="style-changed-row">
            <td><span class="style-selector-pill">${escapeHtml(change.selector)}</span></td>
            <td><strong>${escapeHtml(prop.property)}</strong></td>
            <td><span class="val-baseline">${escapeHtml(prop.baseline)}</span></td>
            <td><span class="val-current">${escapeHtml(prop.current)}</span></td>
          </tr>
        `;
      }
    }

    html += '</tbody></table>';
    tableWrap.innerHTML = html;
  }

  // Embedded stylesheets rules diff
  const rulesA = (cssA.inlineStyles || []).map(s => s.cssText).join('\n\n/* --- */\n\n');
  const rulesB = (cssB.inlineStyles || []).map(s => s.cssText).join('\n\n/* --- */\n\n');
  const rulesDiff = computeTextDiff(rulesA, rulesB);

  const rulesContainer = document.getElementById('css-rules-diff-output');
  rulesContainer.innerHTML = rulesDiff.renderUnifiedHtml();
}

function renderMetadataComparison() {
  const metaContainer = document.getElementById('meta-tab-container');
  const metaA = baselineSnap.meta || {};
  const metaB = currentSnap.meta || {};
  const vpA = baselineSnap.viewport || {};
  const vpB = currentSnap.viewport || {};

  metaContainer.innerHTML = `
    <div class="meta-grid">
      <div class="meta-card">
        <span class="meta-card-label">Page Title</span>
        <span class="meta-card-val">${escapeHtml(metaB.title || metaA.title || 'Untitled')}</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Target URL</span>
        <span class="meta-card-val">${escapeHtml(currentSnap.url)}</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Baseline Viewport</span>
        <span class="meta-card-val">${vpA.width || 0} x ${vpA.height || 0} (DPR: ${vpA.dpr || 1})</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Current Viewport</span>
        <span class="meta-card-val">${vpB.width || 0} x ${vpB.height || 0} (DPR: ${vpB.dpr || 1})</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Baseline Recorded At</span>
        <span class="meta-card-val">${baselineSnap.dateFormatted}</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Current Recorded At</span>
        <span class="meta-card-val">${currentSnap.dateFormatted}</span>
      </div>
    </div>
  `;
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const activePanel = document.getElementById(tabId);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePanel) activePanel.classList.add('active');

  const visualControls = document.getElementById('visual-mode-controls');
  if (tabId === 'tab-visual') {
    visualControls.classList.remove('hidden');
  } else {
    visualControls.classList.add('hidden');
  }
}

function setVisualMode(mode) {
  activeVisualMode = mode;
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const views = {
    'side-by-side': 'view-side-by-side',
    'slider': 'view-slider',
    'diff-mask': 'view-diff-mask',
    'onion': 'view-onion'
  };

  for (const [key, id] of Object.entries(views)) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('hidden', key !== mode);
    }
  }
}

function setCodeDiffMode(mode) {
  activeCodeDiffMode = mode;
  document.getElementById('btn-diff-unified').classList.toggle('active', mode === 'unified');
  document.getElementById('btn-diff-split').classList.toggle('active', mode === 'split');
  renderDomComparison();
}

/**
 * Interactive Wipe / Split Slider
 */
function setupSliderHandle() {
  const box = document.getElementById('slider-box');
  const handle = document.getElementById('slider-handle');
  let isDragging = false;

  const updatePosition = (clientX) => {
    const rect = box.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));

    box.style.setProperty('--slider-pos', `${percent}%`);
  };

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      updatePosition(e.clientX);
    }
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  box.addEventListener('click', (e) => {
    updatePosition(e.clientX);
  });
}

/**
 * Generates and downloads a self-contained, standalone interactive HTML report!
 */
function exportHtmlReport() {
  if (!baselineSnap || !currentSnap || !currentDiffResult) {
    alert('Please select both Baseline and Current snapshots first.');
    return;
  }

  const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>UI Regression Report - ${escapeHtml(currentSnap.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; line-height: 1.5; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 16px; margin-bottom: 24px; }
    h1 { margin: 0 0 6px 0; font-size: 22px; color: #38bdf8; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 700; font-size: 13px; text-transform: uppercase; background: ${currentDiffResult.diffPercentage === 0 ? 'rgba(16,185,129,0.2)' : 'rgba(236,72,153,0.2)'}; color: ${currentDiffResult.diffPercentage === 0 ? '#34d399' : '#f472b6'}; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px; }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid rgba(255,255,255,0.08); }
    .card h3 { margin-top: 0; font-size: 14px; color: #94a3b8; }
    img { max-width: 100%; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    .meta-table { width: 100%; font-size: 13px; border-collapse: collapse; margin-top: 10px; }
    .meta-table td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .meta-table td:first-child { color: #94a3b8; font-weight: 600; width: 140px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>UI Regression Audit Report</h1>
    <span class="status-badge">${escapeHtml(currentDiffResult.verdict)} &bull; ${currentDiffResult.diffPercentage}% Difference</span>
    <table class="meta-table">
      <tr><td>URL</td><td><a href="${escapeHtml(currentSnap.url)}" style="color: #38bdf8;" target="_blank">${escapeHtml(currentSnap.url)}</a></td></tr>
      <tr><td>Baseline (A)</td><td>${escapeHtml(baselineSnap.label)} (${baselineSnap.dateFormatted})</td></tr>
      <tr><td>Current (B)</td><td>${escapeHtml(currentSnap.label)} (${currentSnap.dateFormatted})</td></tr>
      <tr><td>Pixels Changed</td><td>${currentDiffResult.diffPixels.toLocaleString()} / ${currentDiffResult.totalPixels.toLocaleString()}</td></tr>
    </table>
  </div>

  <h2>Visual Regression Diff</h2>
  <div class="grid">
    <div class="card">
      <h3>Baseline Snapshot (A)</h3>
      <img src="${baselineSnap.screenshot}" alt="Baseline" />
    </div>
    <div class="card">
      <h3>Current Snapshot (B)</h3>
      <img src="${currentSnap.screenshot}" alt="Current" />
    </div>
  </div>

  <div class="card" style="margin-top: 20px;">
    <h3>Regression Heatmap (Pink highlights altered regions)</h3>
    <img src="${currentDiffResult.diffDataUrl}" alt="Diff Heatmap" />
  </div>
</body>
</html>`;

  downloadFile(`regression-report-${Date.now()}.html`, reportHtml, 'text/html');
}

async function handleExportJson() {
  const jsonStr = await exportAllData();
  downloadFile(`ui-regression-data-${Date.now()}.json`, jsonStr, 'application/json');
}

async function handleImportJson(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const data = JSON.parse(evt.target.result);
      const count = await importData(data);
      alert(`Successfully imported ${count} snapshots!`);
      allSnapshots = await getAllSnapshots();
      rebuildPageGroups();
      populateDomainDropdown();
      updateTopMetrics();
      renderPageList();
      renderTimelineForSelectedPage();
      await runComparison();
    } catch (err) {
      alert(`Import error: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

async function handleClearAll() {
  if (confirm('Are you sure you want to permanently clear ALL saved snapshots across all pages?')) {
    await clearAllSnapshots();
    allSnapshots = [];
    groupedPages.clear();
    updateTopMetrics();
    renderPageList();
    renderTimelineForSelectedPage();
    showEmptyWorkspace();
  }
}

function showEmptyWorkspace() {
  const main = document.querySelector('.main-content');
  main.innerHTML = `
    <div class="diff-empty" style="padding-top: 100px;">
      <h2 style="color: var(--cyan); margin-bottom: 8px;">No Snapshots Recorded Yet</h2>
      <p style="color: var(--text-dim); max-width: 400px; margin: 0 auto;">
        Open any webpage, click the UI Regression Detector extension icon in your Chrome toolbar, and take your first snapshot!
      </p>
    </div>
  `;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
