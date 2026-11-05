/**
 * UI Regression Detector - Dashboard Controller
 * Full-featured analysis studio for visual regressions, code/DOM diffs,
 * CSS landmark inspections, and exportable reports.
 */

import {
  getAllSnapshots,
  deleteSnapshot,
  clearAllSnapshots,
  exportAllData,
  importData
} from '../utils/db.js';

import { compareImages } from '../utils/visual-diff.js';
import {
  computeTextDiff,
  compareLandmarkStyles,
  compareDomStats,
  normalizeHtmlForDiff
} from '../utils/text-diff.js';
import { escapeHtml, safeImageSrc, safeHttpUrl } from '../utils/common.js';
import { toast, confirmDialog } from '../utils/ui.js';
import { loadGroups, groupKeyFor, findGroup, envLabel, pickDefaultPair } from '../utils/environments.js';
import { openEnvironmentsDialog } from './environments-ui.js';

// Environment groups (domains treated as the same app), loaded from chrome.storage
let envGroups = [];
let pendingReselectUrl = null;

// Per-viewer preferences (localStorage may be unavailable -> degrade gracefully)
const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`urd:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`urd:${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
};

// State
let allSnapshots = [];
let groupedPages = new Map(); // normalizedUrl -> array of snapshots
let selectedPageKey = null;

let baselineSnap = null;
let currentSnap = null;
let currentDiffResult = null;
let activeVisualScope = 'viewport'; // 'viewport' | 'fullpage'
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

  // Scope toggle (Viewport vs Full Page)
  const btnScopeVp = document.getElementById('btn-scope-viewport');
  const btnScopeFp = document.getElementById('btn-scope-fullpage');
  if (btnScopeVp && btnScopeFp) {
    btnScopeVp.addEventListener('click', () => setVisualScope('viewport'));
    btnScopeFp.addEventListener('click', () => setVisualScope('fullpage'));
  }

  // Visual mode segments (Side-by-side, slider, diff-mask, onion)
  document.querySelectorAll('.segment-btn[data-mode]').forEach(btn => {
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

  // Tolerance slider + ignore regions
  setupVisualExtras();

  // Environment groups + default compare mode
  setupEnvironmentControls();

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
  envGroups = await loadGroups();
  allSnapshots = await getAllSnapshots();
  rebuildPageGroups();
  populateDomainDropdown();
  updateTopMetrics();

  const urlParams = new URLSearchParams(window.location.search);
  // After editing environment groups, stay on the page being viewed (its key may have changed)
  const reselectUrl = pendingReselectUrl;
  pendingReselectUrl = null;
  const targetUrl = reselectUrl || urlParams.get('url');
  const targetBaseline = reselectUrl ? null : urlParams.get('baseline');
  const targetCurrent = reselectUrl ? null : urlParams.get('current');

  if (groupedPages.size === 0) {
    showEmptyWorkspace();
    return;
  }
  hideEmptyWorkspace();

  // Determine initial page
  if (targetUrl && groupedPages.has(groupKeyFor(targetUrl, envGroups))) {
    selectedPageKey = groupKeyFor(targetUrl, envGroups);
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
      baselineSnap = defaultBaselineFor(snapsForPage);
    }
  }

  renderTimelineForSelectedPage();
  updateComparisonDropdowns();
  await runComparison();
}

function rebuildPageGroups() {
  groupedPages.clear();
  for (const s of allSnapshots) {
    const key = groupKeyFor(s.url, envGroups);
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

/** Golden baseline (pinned reference) for a page, if any and still existing */
function getGoldenSnapshot(pageKey) {
  const id = prefs.get(`golden:${pageKey}`, null);
  if (!id) return null;
  return (groupedPages.get(pageKey) || []).find(s => s.id === id) || null;
}

function defaultBaselineFor(snaps) {
  const golden = getGoldenSnapshot(selectedPageKey);
  if (golden && snaps[0] && golden.id !== snaps[0].id) return golden;
  // 'auto' prefers the newest snapshot from another environment, 'previous' the one before
  return pickDefaultPair(snaps, prefs.get('compareMode', 'auto')).baseline;
}

/** Short environment label of a snapshot's domain, e.g. "test" / "qaint" */
function envOf(snap) {
  return envLabel(snap.domain, envGroups);
}

/** Environment names present for a page, in first-seen order */
function envsOfPage(snaps) {
  return [...new Set(snaps.map(envOf))];
}

/** Hosts to mask in HTML diffs when comparing two environments of the same app */
function hostsToMask() {
  const hosts = new Set();
  for (const snap of [baselineSnap, currentSnap]) {
    if (!snap) continue;
    const group = findGroup(snap.domain, envGroups);
    (group ? group.domains : [snap.domain]).forEach(h => hosts.add(h));
  }
  // Longest first so a host that contains another is replaced entirely
  return [...hosts].sort((a, b) => b.length - a.length);
}

function getIgnoreRegions() {
  return prefs.get(`ignore:${selectedPageKey}`, []);
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
    if (domainFilter !== 'ALL' && !snaps.some(s => s.domain === domainFilter)) continue;

    if (query) {
      const matchTitle = sample.title && sample.title.toLowerCase().includes(query);
      const matchUrl = sample.url && sample.url.toLowerCase().includes(query);
      const matchLabel = snaps.some(s => s.label && s.label.toLowerCase().includes(query));
      if (!matchTitle && !matchUrl && !matchLabel) continue;
    }

    count++;
    const envs = envsOfPage(snaps);
    const item = document.createElement('div');
    item.className = `page-item ${key === selectedPageKey ? 'active' : ''}`;
    item.innerHTML = `
      <span class="page-item-title truncate">${escapeHtml(sample.title || sample.domain)}</span>
      <span class="page-item-url truncate">${escapeHtml(sample.url)}</span>
      ${envs.length > 1 ? `<span class="page-item-url truncate">🌐 ${escapeHtml(envs.join(' ↔ '))}</span>` : ''}
      <span class="badge" style="align-self: flex-start; margin-top: 2px;">${snaps.length} snap${snaps.length > 1 ? 's' : ''}</span>
    `;

    item.addEventListener('click', () => {
      selectedPageKey = key;
      renderPageList(query, domainFilter);

      const pageSnaps = groupedPages.get(key) || [];
      currentSnap = pageSnaps[0] || null;
      baselineSnap = defaultBaselineFor(pageSnaps);

      renderTimelineForSelectedPage();
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

  const golden = getGoldenSnapshot(selectedPageKey);

  pageSnaps.forEach((snap) => {
    const card = document.createElement('div');
    const isBase = baselineSnap && baselineSnap.id === snap.id;
    const isCur = currentSnap && currentSnap.id === snap.id;
    const isGolden = golden && golden.id === snap.id;

    card.className = `timeline-card ${isBase ? 'is-baseline' : ''} ${isCur ? 'is-current' : ''}`;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-label truncate">${isGolden ? '★ ' : ''}${escapeHtml(snap.label)}</span>
        <div class="card-role-badges">
          ${isBase ? '<span class="role-badge badge-a">Baseline A</span>' : ''}
          ${isCur ? '<span class="role-badge badge-b">Current B</span>' : ''}
        </div>
      </div>
      <div class="card-body">
        <img alt="Thumb" class="card-thumb" />
        <div class="card-meta">
          <span title="${escapeHtml(snap.domain)}">🌐 ${escapeHtml(envOf(snap))}</span>
          <span>📅 ${snap.dateFormatted}</span>
          <span>📐 ${snap.viewport?.width || '--'}x${snap.viewport?.height || '--'}</span>
          <span>🏷️ ${snap.dom?.stats?.elementsTotal || '--'} elements</span>
        </div>
      </div>
      <div class="card-actions">
        <div class="role-buttons">
          <button class="btn-role ${isBase ? 'active-a' : ''}" data-role="A">Set as A</button>
          <button class="btn-role ${isCur ? 'active-b' : ''}" data-role="B">Set as B</button>
          <button class="btn-role ${isGolden ? 'active-a' : ''}" data-role="golden" title="${isGolden ? 'Unpin golden baseline' : 'Pin as golden baseline (default reference for this page)'}">${isGolden ? '★ Golden' : '☆ Golden'}</button>
        </div>
        <button class="btn-del-snap" title="Delete snapshot" aria-label="Delete snapshot">✕</button>
      </div>
    `;

    card.querySelector('.card-thumb').src = safeImageSrc(snap.screenshot);

    card.querySelector('[data-role="golden"]').addEventListener('click', () => {
      prefs.set(`golden:${selectedPageKey}`, isGolden ? null : snap.id);
      if (!isGolden) setBaseline(snap.id);
      else renderTimelineForSelectedPage();
    });

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
      if (await confirmDialog(`Delete snapshot "${snap.label}"?`)) {
        await deleteSnapshot(snap.id);
        allSnapshots = await getAllSnapshots();
        rebuildPageGroups();
        const remaining = groupedPages.get(selectedPageKey) || [];
        if (remaining.length === 0) {
          baselineSnap = null;
          currentSnap = null;
          selectedPageKey = groupedPages.keys().next().value || null;
          if (!selectedPageKey) return showEmptyWorkspace();
          const fallback = groupedPages.get(selectedPageKey);
          currentSnap = fallback[0];
          baselineSnap = defaultBaselineFor(fallback);
        } else {
          if (!remaining.find(s => s.id === currentSnap?.id)) currentSnap = remaining[0];
          if (!remaining.find(s => s.id === baselineSnap?.id)) baselineSnap = defaultBaselineFor(remaining);
        }
        populateDomainDropdown();
        renderPageList();
        renderTimelineForSelectedPage();
        updateComparisonDropdowns();
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
    optBase.textContent = `[${envOf(s)}] ${s.label} (${s.dateFormatted.split(' ')[1] || ''})`;
    selectBase.appendChild(optBase);

    const optCur = document.createElement('option');
    optCur.value = s.id;
    optCur.textContent = `[${envOf(s)}] ${s.label} (${s.dateFormatted.split(' ')[1] || ''})`;
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

function getActiveImages() {
  if (activeVisualScope === 'fullpage') {
    return {
      imgA: (baselineSnap && baselineSnap.fullScreenshot) || (baselineSnap && baselineSnap.screenshot),
      imgB: (currentSnap && currentSnap.fullScreenshot) || (currentSnap && currentSnap.screenshot),
      label: 'Full Page'
    };
  }
  return {
    imgA: baselineSnap && baselineSnap.screenshot,
    imgB: currentSnap && currentSnap.screenshot,
    label: 'Viewport'
  };
}

async function setVisualScope(scope) {
  activeVisualScope = scope;
  const btnVp = document.getElementById('btn-scope-viewport');
  const btnFp = document.getElementById('btn-scope-fullpage');
  if (btnVp) btnVp.classList.toggle('active', scope === 'viewport');
  if (btnFp) btnFp.classList.toggle('active', scope === 'fullpage');

  await runVisualComparison();
}

const MAX_DIFF_PIXELS_VIEWPORT = 10_000_000;
const MAX_DIFF_PIXELS_FULLPAGE = 4_000_000;
let visualRunId = 0;

async function runVisualComparison() {
  if (!baselineSnap || !currentSnap) return;
  const { imgA, imgB, label } = getActiveImages();
  if (!imgA || !imgB) return;

  const runId = ++visualRunId;

  // Show the images right away so previews never depend on the (heavy) diff succeeding
  showPreviewImages(imgA, imgB);
  document.getElementById('diff-percent-badge').textContent = `Calculating (${label})…`;
  document.getElementById('diff-stats-detail').textContent = '';

  // Let the browser paint the previews / "Calculating" text before the heavy work
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  if (runId !== visualRunId) return;

  try {
    const result = await compareImages(imgA, imgB, {
      threshold: prefs.get('sensitivity', 10) / 100,
      ignoreRegions: getIgnoreRegions(),
      // Full-page images can be tens of millions of pixels; compare a downscaled copy
      maxPixels: activeVisualScope === 'fullpage' ? MAX_DIFF_PIXELS_FULLPAGE : MAX_DIFF_PIXELS_VIEWPORT
    });
    if (runId !== visualRunId) return; // a newer comparison superseded this one
    currentDiffResult = result;
    renderVisualComparison(currentDiffResult, imgA, imgB, label);
    warnAboutComparability();
  } catch (err) {
    if (runId !== visualRunId) return;
    console.error('Visual compare error:', err);
    document.getElementById('diff-percent-badge').textContent = 'Comparison failed';
    document.getElementById('diff-stats-detail').textContent = err.message;
    toast(`Visual comparison failed: ${err.message}`, 'error');
  }
}

function showPreviewImages(imgA, imgB) {
  const srcA = safeImageSrc(imgA);
  const srcB = safeImageSrc(imgB);
  document.getElementById('img-baseline').src = srcA;
  document.getElementById('img-current').src = srcB;
  document.getElementById('slider-img-baseline').src = srcA;
  document.getElementById('slider-img-current').src = srcB;
  document.getElementById('img-diff-mask').src = srcA;
  document.getElementById('onion-img-baseline').src = srcA;
  document.getElementById('onion-img-current').src = srcB;
}

let lastWarning = '';
function warnAboutComparability() {
  const warnings = [];
  if (currentDiffResult && currentDiffResult.sizeMismatch) {
    const a = currentDiffResult.sizeA;
    const b = currentDiffResult.sizeB;
    const widthDiffers = a.width !== b.width;
    // A full-page height change is an expected result of content changes, not a capture problem
    if (widthDiffers || activeVisualScope === 'viewport') {
      warnings.push(`Image sizes differ (${a.width}×${a.height} vs ${b.width}×${b.height}); the extra area counts as changed. Compare snapshots taken at the same window size.`);
    }
  }
  if (activeVisualScope === 'fullpage' && ((baselineSnap && baselineSnap.fullPageFailed) || (currentSnap && currentSnap.fullPageFailed))) {
    warnings.push('A full-page capture failed for one of these snapshots; the viewport image was used instead.');
  }
  const text = warnings.join(' ');
  if (text && text !== lastWarning) toast(text, 'warn', 7000);
  lastWarning = text;
}

/** Sidebar controls: "Environments" dialog button and the default comparison mode. */
function setupEnvironmentControls() {
  const domainSelect = document.getElementById('domain-select');
  if (!domainSelect || document.getElementById('urd-env-controls')) return;

  const wrap = document.createElement('div');
  wrap.id = 'urd-env-controls';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;font-size:12px;';
  wrap.innerHTML = `
    <button id="urd-env-btn" type="button" class="segment-btn" title="Treat several domains (e.g. test / qaint) as the same app">🌐 Environments…</button>
    <label title="Which snapshot a page is compared against by default">
      Default compare:
      <select id="urd-compare-mode" style="width:100%">
        <option value="auto">Other environment (if any)</option>
        <option value="previous">Previous snapshot</option>
      </select>
    </label>
  `;
  domainSelect.insertAdjacentElement('afterend', wrap);

  const modeSelect = wrap.querySelector('#urd-compare-mode');
  modeSelect.value = prefs.get('compareMode', 'auto');
  modeSelect.addEventListener('change', () => {
    prefs.set('compareMode', modeSelect.value);
    const snaps = groupedPages.get(selectedPageKey) || [];
    if (snaps.length) {
      currentSnap = snaps[0];
      baselineSnap = defaultBaselineFor(snaps);
      renderTimelineForSelectedPage();
      updateComparisonDropdowns();
      runComparison();
    }
  });

  wrap.querySelector('#urd-env-btn').addEventListener('click', () => {
    openEnvironmentsDialog({
      domains: [...new Set(allSnapshots.map(s => s.domain).filter(Boolean))].sort(),
      groups: envGroups,
      onChange: () => {
        pendingReselectUrl = currentSnap ? currentSnap.url : null;
        loadDataFromUrlParamsOrStorage();
      }
    });
  });
}

/** Sensitivity slider + ignore-region controls, injected next to the visual mode controls. */
function setupVisualExtras() {
  const host = document.getElementById('visual-mode-controls');
  if (!host || document.getElementById('urd-extras')) return;

  const wrap = document.createElement('div');
  wrap.id = 'urd-extras';
  wrap.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-left:12px;font-size:12px;';
  wrap.innerHTML = `
    <label title="Per-pixel color tolerance. Higher = ignore smaller color differences.">Tolerance
      <input id="urd-sensitivity" type="range" min="0" max="30" step="1" style="vertical-align:middle;width:90px" />
      <span id="urd-sensitivity-val"></span>
    </label>
    <button id="urd-clear-ignore" type="button" class="segment-btn" title="Shift+drag on the Difference Mask to exclude a region (ads, timestamps, carousels)">Clear ignored regions</button>
  `;
  host.appendChild(wrap);

  const slider = wrap.querySelector('#urd-sensitivity');
  const val = wrap.querySelector('#urd-sensitivity-val');
  slider.value = prefs.get('sensitivity', 10);
  val.textContent = `${slider.value}%`;
  slider.addEventListener('input', () => { val.textContent = `${slider.value}%`; });
  slider.addEventListener('change', () => {
    prefs.set('sensitivity', Number(slider.value));
    runVisualComparison();
  });

  wrap.querySelector('#urd-clear-ignore').addEventListener('click', () => {
    prefs.set(`ignore:${selectedPageKey}`, []);
    toast('Ignored regions cleared.', 'success');
    runVisualComparison();
  });

  setupIgnoreRegionDrawing();
}

/** Shift+drag on the diff mask image to add an ignore region (stored in original image pixels). */
function setupIgnoreRegionDrawing() {
  const img = document.getElementById('img-diff-mask');
  if (!img) return;
  let start = null;

  const toImagePoint = (e) => {
    const rect = img.getBoundingClientRect();
    const w = currentDiffResult ? currentDiffResult.width : img.naturalWidth;
    const h = currentDiffResult ? currentDiffResult.height : img.naturalHeight;
    return {
      x: Math.max(0, Math.min(w, ((e.clientX - rect.left) / rect.width) * w)),
      y: Math.max(0, Math.min(h, ((e.clientY - rect.top) / rect.height) * h))
    };
  };

  img.addEventListener('pointerdown', (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    start = toImagePoint(e);
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener('pointerup', (e) => {
    if (!start) return;
    const end = toImagePoint(e);
    const region = {
      x: Math.round(Math.min(start.x, end.x)),
      y: Math.round(Math.min(start.y, end.y)),
      w: Math.round(Math.abs(end.x - start.x)),
      h: Math.round(Math.abs(end.y - start.y))
    };
    start = null;
    if (region.w < 4 || region.h < 4) return;
    prefs.set(`ignore:${selectedPageKey}`, [...getIgnoreRegions(), region]);
    toast('Region will be ignored in comparisons.', 'success');
    runVisualComparison();
  });
  img.addEventListener('dragstart', (e) => e.preventDefault());
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

  // 1. Visual comparison (respects active scope: Viewport vs Fullpage)
  await runVisualComparison();

  // 2. DOM / Code comparison
  renderDomComparison();

  // 3. CSS Landmarks & Stylesheets comparison
  renderCssComparison();

  // 4. Metadata comparison
  renderMetadataComparison();
}

function renderVisualComparison(diff, imgA, imgB, scopeLabel = 'Viewport') {
  const card = document.getElementById('diff-summary-card');
  const verdictEl = document.getElementById('diff-verdict-title');
  const badgeEl = document.getElementById('diff-percent-badge');
  const statsEl = document.getElementById('diff-stats-detail');
  const iconEl = document.getElementById('diff-status-icon');

  badgeEl.textContent = `${diff.diffPercentage}% Diff (${scopeLabel})`;
  statsEl.textContent = `${diff.diffPixels.toLocaleString()} of ${diff.totalPixels.toLocaleString()} pixels changed` +
    (diff.scale < 1 ? ' (approx., downscaled)' : '') +
    (diff.sizeMismatch && diff.sizeA.height !== diff.sizeB.height && diff.sizeA.width === diff.sizeB.width
      ? ` • page height ${diff.sizeA.height}px → ${diff.sizeB.height}px`
      : '');

  card.classList.remove('status-pass', 'status-warning', 'status-regression');

  if (diff.verdict === 'PASS') {
    card.classList.add('status-pass');
    verdictEl.textContent = 'Pixel Perfect Match';
    iconEl.textContent = '✓';
    document.getElementById('metric-status').textContent = 'Match';
    document.getElementById('metric-status').className = 'metric-value status-ready';
  } else if (diff.verdict === 'MINOR_DIFF') {
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

  const srcA = safeImageSrc(imgA);
  const srcB = safeImageSrc(imgB);

  // Tall (full-page) images: size the slider box to the image ratio and top-align onion layers
  const tall = activeVisualScope === 'fullpage';
  const sliderBox = document.getElementById('slider-box');
  const onionBox = document.querySelector('.onion-view-box');
  if (sliderBox) {
    sliderBox.classList.toggle('tall', tall);
    sliderBox.style.aspectRatio = tall && diff.width && diff.height ? `${diff.width} / ${diff.height}` : '';
  }
  if (onionBox) onionBox.classList.toggle('tall', tall);

  // Side-by-side images
  document.getElementById('img-baseline').src = srcA;
  document.getElementById('img-current').src = srcB;

  // Slider Wipe images
  document.getElementById('slider-img-baseline').src = srcA;
  document.getElementById('slider-img-current').src = srcB;

  // Diff Mask
  document.getElementById('img-diff-mask').src = diff.diffDataUrl || srcA;

  // Onion skin
  document.getElementById('onion-img-baseline').src = srcA;
  document.getElementById('onion-img-current').src = srcB;
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
  const masked = hostsToMask();
  const textA = normalizeHtmlForDiff(domA.html || '', masked);
  const textB = normalizeHtmlForDiff(domB.html || '', masked);
  const diffResult = computeTextDiff(textA, textB);
  if (diffResult.stats.truncated) {
    toast('DOM changes are too large to diff line-by-line; showing a full replace.', 'warn');
  }

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
        <span class="meta-card-label">Baseline URL (${escapeHtml(envOf(baselineSnap))})</span>
        <span class="meta-card-val">${escapeHtml(baselineSnap.url)}</span>
      </div>
      <div class="meta-card">
        <span class="meta-card-label">Current URL (${escapeHtml(envOf(currentSnap))})</span>
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
  document.querySelectorAll('.segment-btn[data-mode]').forEach(btn => {
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

  let percentNow = 50;

  const setPercent = (percent) => {
    percentNow = Math.max(0, Math.min(100, percent));
    box.style.setProperty('--slider-pos', `${percentNow}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(percentNow)));
  };

  const updatePosition = (clientX) => {
    const rect = box.getBoundingClientRect();
    if (!rect.width) return;
    setPercent(((clientX - rect.left) / rect.width) * 100);
  };

  // Keyboard + screen reader support
  handle.setAttribute('role', 'slider');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', 'Comparison position');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.setAttribute('aria-valuenow', '50');
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { setPercent(percentNow - step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setPercent(percentNow + step); e.preventDefault(); }
    else if (e.key === 'Home') { setPercent(0); e.preventDefault(); }
    else if (e.key === 'End') { setPercent(100); e.preventDefault(); }
  });

  // Pointer events cover mouse, touch and pen
  handle.addEventListener('pointerdown', (e) => {
    isDragging = true;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (isDragging) updatePosition(e.clientX);
  });
  const stopDrag = () => { isDragging = false; };
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);

  box.addEventListener('click', (e) => {
    updatePosition(e.clientX);
  });
}

/**
 * Generates and downloads a self-contained, standalone interactive HTML report!
 */
function exportHtmlReport() {
  if (!baselineSnap || !currentSnap || !currentDiffResult) {
    toast('Please select both Baseline and Current snapshots first.', 'warn');
    return;
  }

  const { imgA: rawA, imgB: rawB, label: scopeLabel } = getActiveImages();
  const imgA = safeImageSrc(rawA);
  const imgB = safeImageSrc(rawB);
  const diffImg = safeImageSrc(currentDiffResult.diffDataUrl);
  const safeUrl = safeHttpUrl(currentSnap.url);
  const sizeNote = currentDiffResult.sizeMismatch
    ? `<tr><td>Warning</td><td>Image sizes differ (${currentDiffResult.sizeA.width}×${currentDiffResult.sizeA.height} vs ${currentDiffResult.sizeB.width}×${currentDiffResult.sizeB.height})</td></tr>`
    : '';

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
    <span class="status-badge">${escapeHtml(currentDiffResult.verdict)} &bull; ${currentDiffResult.diffPercentage}% Difference (${scopeLabel})</span>
    <table class="meta-table">
      <tr><td>Baseline URL (A)</td><td>${escapeHtml(baselineSnap.url)} <em>[${escapeHtml(envOf(baselineSnap))}]</em></td></tr>
      <tr><td>Current URL (B)</td><td><a href="${escapeHtml(safeUrl)}" style="color: #38bdf8;" target="_blank" rel="noopener noreferrer">${escapeHtml(currentSnap.url)}</a> <em>[${escapeHtml(envOf(currentSnap))}]</em></td></tr>
      ${sizeNote}
      <tr><td>Baseline (A)</td><td>${escapeHtml(baselineSnap.label)} (${baselineSnap.dateFormatted})</td></tr>
      <tr><td>Current (B)</td><td>${escapeHtml(currentSnap.label)} (${currentSnap.dateFormatted})</td></tr>
      <tr><td>Comparison Scope</td><td><strong>${escapeHtml(scopeLabel)}</strong></td></tr>
      <tr><td>Pixels Changed</td><td>${currentDiffResult.diffPixels.toLocaleString()} / ${currentDiffResult.totalPixels.toLocaleString()}</td></tr>
    </table>
  </div>

  <h2>Visual Regression Diff (${scopeLabel})</h2>
  <div class="grid">
    <div class="card">
      <h3>Baseline Snapshot (A)</h3>
      <img src="${imgA}" alt="Baseline" />
    </div>
    <div class="card">
      <h3>Current Snapshot (B)</h3>
      <img src="${imgB}" alt="Current" />
    </div>
  </div>

  <div class="card" style="margin-top: 20px;">
    <h3>Regression Heatmap (Pink highlights altered regions)</h3>
    <img src="${diffImg}" alt="Diff Heatmap" />
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
      const { imported, skipped } = await importData(data);
      toast(
        `Imported ${imported} snapshot${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} invalid` : ''}.`,
        skipped ? 'warn' : 'success'
      );
      await loadDataFromUrlParamsOrStorage();
    } catch (err) {
      toast(`Import error: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function handleClearAll() {
  if (await confirmDialog('Permanently clear ALL saved snapshots across all pages?', 'Clear all')) {
    await clearAllSnapshots();
    allSnapshots = [];
    groupedPages.clear();
    updateTopMetrics();
    renderPageList();
    renderTimelineForSelectedPage();
    showEmptyWorkspace();
  }
}

/** Non-destructive empty state: hides the workspace instead of wiping its DOM. */
function showEmptyWorkspace() {
  const main = document.querySelector('.main-content');
  let banner = document.getElementById('urd-empty');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'urd-empty';
    banner.className = 'diff-empty';
    banner.style.paddingTop = '100px';
    banner.innerHTML = `
      <h2 style="color: var(--cyan); margin-bottom: 8px;">No Snapshots Recorded Yet</h2>
      <p style="color: var(--text-dim); max-width: 400px; margin: 0 auto;">
        Open any webpage, click the UI Regression Detector extension icon in your Chrome toolbar, and take your first snapshot!
      </p>
    `;
    main.appendChild(banner);
  }
  for (const child of main.children) {
    if (child !== banner) child.style.display = 'none';
  }
  banner.style.display = '';
}

function hideEmptyWorkspace() {
  const main = document.querySelector('.main-content');
  const banner = document.getElementById('urd-empty');
  if (banner) banner.style.display = 'none';
  for (const child of main.children) {
    if (child !== banner) child.style.display = '';
  }
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
