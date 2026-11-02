/**
 * UI Regression Detector - Text & DOM Diff Engine
 * Computes line-by-line differences, Myers LCS algorithm,
 * and structural comparisons for HTML and CSS snapshots.
 */

/**
 * Computes diff between two text strings using LCS
 * @param {string} textA - Baseline text
 * @param {string} textB - Current text
 * @returns {Object} diff result with lines, stats, and HTML renderers
 */
export function computeTextDiff(textA = '', textB = '') {
  const linesA = textA.split(/\r?\n/);
  const linesB = textB.split(/\r?\n/);

  const lcsMatrix = buildLcsMatrix(linesA, linesB);
  const diffItems = backtrackLcs(lcsMatrix, linesA, linesB, linesA.length, linesB.length);

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
      hasChanges: added > 0 || deleted > 0
    },
    renderUnifiedHtml: () => renderUnifiedView(diffItems),
    renderSplitHtml: () => renderSplitView(diffItems)
  };
}

/**
 * Build dynamic programming matrix for LCS
 */
function buildLcsMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  // If inputs are excessively large (> 2000 lines), downsample or trim for speed
  const maxLines = 1500;
  const safeA = m > maxLines ? a.slice(0, maxLines) : a;
  const safeB = n > maxLines ? b.slice(0, maxLines) : b;
  const rows = safeA.length + 1;
  const cols = safeB.length + 1;

  const dp = new Array(rows);
  for (let i = 0; i < rows; i++) {
    dp[i] = new Uint16Array(cols);
  }

  for (let i = 0; i < safeA.length; i++) {
    for (let j = 0; j < safeB.length; j++) {
      if (safeA[i] === safeB[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  return dp;
}

/**
 * Backtrack LCS matrix to produce diff items
 */
function backtrackLcs(dp, a, b, i, j) {
  const result = [];
  let curI = Math.min(i, dp.length - 1);
  let curJ = Math.min(j, dp[0].length - 1);

  let lineNumA = curI;
  let lineNumB = curJ;

  const temp = [];

  while (curI > 0 || curJ > 0) {
    if (curI > 0 && curJ > 0 && a[curI - 1] === b[curJ - 1]) {
      temp.push({
        type: 'equal',
        text: a[curI - 1],
        lineA: curI,
        lineB: curJ
      });
      curI--;
      curJ--;
    } else if (curJ > 0 && (curI === 0 || dp[curI][curJ - 1] >= dp[curI - 1][curJ])) {
      temp.push({
        type: 'add',
        text: b[curJ - 1],
        lineA: null,
        lineB: curJ
      });
      curJ--;
    } else if (curI > 0 && (curJ === 0 || dp[curI][curJ - 1] < dp[curI - 1][curJ])) {
      temp.push({
        type: 'delete',
        text: a[curI - 1],
        lineA: curI,
        lineB: null
      });
      curI--;
    }
  }

  return temp.reverse();
}

/**
 * Render unified diff HTML
 */
function renderUnifiedView(diffItems) {
  if (!diffItems || diffItems.length === 0) {
    return '<div class="diff-empty">No diff items.</div>';
  }

  let html = '<div class="diff-table unified-diff">';
  for (const item of diffItems) {
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

/**
 * Render split (side-by-side) diff HTML
 */
function renderSplitView(diffItems) {
  if (!diffItems || diffItems.length === 0) {
    return '<div class="diff-empty">No diff items.</div>';
  }

  let html = '<div class="diff-table split-diff">';
  for (const item of diffItems) {
    if (item.type === 'equal') {
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
 * e.g., body, header, nav, h1, buttons
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
        changedProps.push({
          property: prop,
          baseline: valA,
          current: valB
        });
      }
    }

    if (changedProps.length > 0) {
      changes.push({
        selector,
        changedProps
      });
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

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

