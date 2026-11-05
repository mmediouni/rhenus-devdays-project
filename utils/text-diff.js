/**
 * UI Regression Detector - Text & DOM Diff Engine
 * Line diff using the Myers O(ND) algorithm with common prefix/suffix trimming,
 * plus structural comparisons for CSS landmarks and DOM stats.
 */

import { escapeHtml } from './common.js';

const MAX_EDIT_DISTANCE = 3000;
const CONTEXT_LINES = 3;

/**
 * Normalizes serialized HTML so a line diff is meaningful:
 * strips script bodies and nonces, and puts each tag on its own line.
 */
export function normalizeHtmlForDiff(html = '', maskHosts = []) {
  let out = String(html)
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1/* script body omitted */$2')
    .replace(/\s+nonce="[^"]*"/gi, '');

  // When comparing environments, host names differ in every absolute URL; mask them
  for (const host of maskHosts) {
    if (!host) continue;
    out = out.replace(new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '{env-host}');
  }

  return out.replace(/>\s*</g, '>\n<');
}

/**
 * Computes diff between two text strings.
 * @returns {Object} { diffItems, stats, renderUnifiedHtml, renderSplitHtml }
 */
export function computeTextDiff(textA = '', textB = '') {
  const linesA = textA.split(/\r?\n/);
  const linesB = textB.split(/\r?\n/);

  // Trim common prefix / suffix so the expensive part only sees the changed middle
  let start = 0;
  const minLen = Math.min(linesA.length, linesB.length);
  while (start < minLen && linesA[start] === linesB[start]) start++;

  let endA = linesA.length;
  let endB = linesB.length;
  while (endA > start && endB > start && linesA[endA - 1] === linesB[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = linesA.slice(start, endA);
  const midB = linesB.slice(start, endB);

  let ops = myersDiff(midA, midB, MAX_EDIT_DISTANCE);
  let truncated = false;
  if (ops === null) {
    // Too different to diff precisely: show the middle as one block replace
    truncated = true;
    ops = [
      ...midA.map(text => ({ type: 'delete', text })),
      ...midB.map(text => ({ type: 'add', text }))
    ];
  }

  const diffItems = [];
  let lineA = 0;
  let lineB = 0;

  for (let i = 0; i < start; i++) {
    diffItems.push({ type: 'equal', text: linesA[i], lineA: ++lineA, lineB: ++lineB });
  }
  for (const op of ops) {
    if (op.type === 'equal') {
      diffItems.push({ type: 'equal', text: op.text, lineA: ++lineA, lineB: ++lineB });
    } else if (op.type === 'delete') {
      diffItems.push({ type: 'delete', text: op.text, lineA: ++lineA, lineB: null });
    } else {
      diffItems.push({ type: 'add', text: op.text, lineA: null, lineB: ++lineB });
    }
  }
  for (let i = endA; i < linesA.length; i++) {
    diffItems.push({ type: 'equal', text: linesA[i], lineA: ++lineA, lineB: ++lineB });
  }

  let added = 0;
  let deleted = 0;
  let unchanged = 0;
  for (const item of diffItems) {
    if (item.type === 'add') added++;
    else if (item.type === 'delete') deleted++;
    else unchanged++;
  }

  return {
    diffItems,
    stats: {
      added,
      deleted,
      unchanged,
      totalA: linesA.length,
      totalB: linesB.length,
      hasChanges: added > 0 || deleted > 0,
      truncated
    },
    renderUnifiedHtml: () => renderUnifiedView(diffItems),
    renderSplitHtml: () => renderSplitView(diffItems)
  };
}

/**
 * Myers O(ND) diff. Returns ordered ops [{type:'equal'|'add'|'delete', text}]
 * or null if the edit distance exceeds maxD.
 */
function myersDiff(a, b, maxD) {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map(text => ({ type: 'add', text }));
  if (m === 0) return a.map(text => ({ type: 'delete', text }));

  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    // Snapshot of V (window k = -d..d) before processing step d
    trace.push(v.slice(off - d, off + d + 1));

    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) {
        x = v[off + k + 1];
      } else {
        x = v[off + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;

      if (x >= n && y >= m) {
        return backtrack(trace, a, b, d);
      }
    }
  }
  return null;
}

function backtrack(trace, a, b, D) {
  const ops = [];
  let x = a.length;
  let y = b.length;

  for (let d = D; d > 0; d--) {
    const w = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && w[k - 1 + d] < w[k + 1 + d])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = w[prevK + d];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ type: 'add', text: b[y - 1] });
      y--;
    } else {
      ops.push({ type: 'delete', text: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', text: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * Collapse long runs of unchanged lines into {type:'skip', count} markers.
 */
function collapseEquals(items, context = CONTEXT_LINES) {
  const keep = new Array(items.length).fill(false);
  items.forEach((item, i) => {
    if (item.type !== 'equal') {
      for (let j = Math.max(0, i - context); j <= Math.min(items.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  });
  // If nothing changed, show nothing special (single skip marker)
  const out = [];
  let skipped = 0;
  items.forEach((item, i) => {
    if (keep[i]) {
      if (skipped) {
        out.push({ type: 'skip', count: skipped });
        skipped = 0;
      }
      out.push(item);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}

function renderSkipRow(count) {
  return `<div class="diff-row diff-line-eq"><span class="diff-num"></span><span class="diff-num"></span><span class="diff-sign"></span><span class="diff-code">… ${count} unchanged line${count === 1 ? '' : 's'} …</span></div>`;
}

function renderUnifiedView(diffItems) {
  if (!diffItems || diffItems.length === 0) {
    return '<div class="diff-empty">No diff items.</div>';
  }

  let html = '<div class="diff-table unified-diff">';
  for (const item of collapseEquals(diffItems)) {
    if (item.type === 'skip') {
      html += renderSkipRow(item.count);
      continue;
    }
    const typeClass = item.type === 'add' ? 'diff-line-add' : item.type === 'delete' ? 'diff-line-del' : 'diff-line-eq';
    const prefix = item.type === 'add' ? '+' : item.type === 'delete' ? '-' : ' ';
    const lineA = item.lineA !== null ? item.lineA : '';
    const lineB = item.lineB !== null ? item.lineB : '';

    html += `
      <div class="diff-row ${typeClass}">
        <span class="diff-num diff-num-a">${lineA}</span>
        <span class="diff-num diff-num-b">${lineB}</span>
        <span class="diff-sign">${prefix}</span>
        <span class="diff-code">${escapeHtml(item.text || ' ')}</span>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

function renderSplitView(diffItems) {
  if (!diffItems || diffItems.length === 0) {
    return '<div class="diff-empty">No diff items.</div>';
  }

  let html = '<div class="diff-table split-diff">';
  for (const item of collapseEquals(diffItems)) {
    if (item.type === 'skip') {
      html += renderSkipRow(item.count);
    } else if (item.type === 'equal') {
      html += `
        <div class="diff-split-row diff-line-eq">
          <div class="diff-cell cell-left">
            <span class="diff-num">${item.lineA}</span>
            <span class="diff-code">${escapeHtml(item.text || ' ')}</span>
          </div>
          <div class="diff-cell cell-right">
            <span class="diff-num">${item.lineB}</span>
            <span class="diff-code">${escapeHtml(item.text || ' ')}</span>
          </div>
        </div>
      `;
    } else if (item.type === 'delete') {
      html += `
        <div class="diff-split-row diff-line-del">
          <div class="diff-cell cell-left">
            <span class="diff-num">${item.lineA}</span>
            <span class="diff-code">${escapeHtml(item.text || ' ')}</span>
          </div>
          <div class="diff-cell cell-right diff-cell-empty"></div>
        </div>
      `;
    } else if (item.type === 'add') {
      html += `
        <div class="diff-split-row diff-line-add">
          <div class="diff-cell cell-left diff-cell-empty"></div>
          <div class="diff-cell cell-right">
            <span class="diff-num">${item.lineB}</span>
            <span class="diff-code">${escapeHtml(item.text || ' ')}</span>
          </div>
        </div>
      `;
    }
  }
  html += '</div>';
  return html;
}

/**
 * Compare computed CSS Landmark styles
 */
export function compareLandmarkStyles(stylesA = {}, stylesB = {}) {
  const changes = [];
  const allSelectors = new Set([...Object.keys(stylesA), ...Object.keys(stylesB)]);

  for (const selector of allSelectors) {
    const propsA = stylesA[selector] || {};
    const propsB = stylesB[selector] || {};
    const allProps = new Set([...Object.keys(propsA), ...Object.keys(propsB)]);

    const changedProps = [];

    for (const prop of allProps) {
      const valA = propsA[prop] || '—';
      const valB = propsB[prop] || '—';

      if (valA !== valB) {
        changedProps.push({ property: prop, baseline: valA, current: valB });
      }
    }

    if (changedProps.length > 0) {
      changes.push({ selector, changedProps });
    }
  }

  return changes;
}

/**
 * Compare DOM structural node counts
 */
export function compareDomStats(domA = {}, domB = {}) {
  const statsA = domA.stats || {};
  const statsB = domB.stats || {};

  const keys = ['elementsTotal', 'scriptsCount', 'stylesCount', 'buttonsCount', 'linksCount', 'imagesCount', 'inputsCount'];
  const comparisons = [];

  for (const key of keys) {
    const valA = statsA[key] || 0;
    const valB = statsB[key] || 0;
    comparisons.push({
      metric: key.replace(/([A-Z])/g, ' $1').toLowerCase(),
      baseline: valA,
      current: valB,
      delta: valB - valA
    });
  }

  return comparisons;
}
