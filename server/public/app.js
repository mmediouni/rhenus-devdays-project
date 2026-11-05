// UI Regression Hub dashboard. Plain ES modules, no build step.
// All DOM is built with textContent / createElement: data from the hub is never parsed as HTML.

const KEY_STORAGE = 'urd:hubkey';
const root = document.getElementById('app');

const state = {
  key: safeGet(KEY_STORAGE),
  who: null,
  pages: [],
  filter: '',
  selected: null, // { pageKey, label }
  timeline: null,
  a: null, // snapshot objects chosen for comparison (kept across page changes)
  b: null,
  view: 'side'
};

const blobCache = new Map();

function safeGet(k) {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
}
function safeSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ }
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${state.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    logout();
    throw new Error('Invalid or expired API key');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return raw ? res : res.json();
}

// <img> cannot send the Authorization header, so images are fetched and shown as blob URLs.
async function blobUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const res = await api(path, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(path, url);
  return url;
}

function lazyImg(path, alt) {
  const img = h('img', { alt, loading: 'lazy' });
  blobUrl(path).then((u) => { img.src = u; }).catch(() => { img.alt = 'image unavailable'; });
  return img;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function pct(snap) {
  const c = snap.vsBaseline || snap.vsPrevious;
  return c && c.diffPercentage != null ? `${c.diffPercentage}%` : null;
}

// ---------------------------------------------------------------- login

function logout() {
  state.key = '';
  state.who = null;
  safeSet(KEY_STORAGE, '');
  render();
}

function renderLogin(message = '') {
  const input = h('input', { type: 'password', placeholder: 'urd_...', autocomplete: 'off', 'aria-label': 'API key' });
  const err = h('div', { class: 'err', role: 'alert' }, message);
  const submit = async () => {
    state.key = input.value.trim();
    err.textContent = '';
    try {
      state.who = await api('/v1/whoami');
      safeSet(KEY_STORAGE, state.key);
      await loadPages();
      render();
    } catch (e) {
      state.key = '';
      err.textContent = e.message;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  root.replaceChildren(
    h('div', { class: 'login' },
      h('h1', {}, 'UI Regression Hub'),
      h('p', {}, 'Enter your API key to see the timeline of your snapshots.'),
      input,
      h('button', { class: 'primary', onclick: submit }, 'Open'),
      err
    )
  );
  input.focus();
}

// ---------------------------------------------------------------- data

async function loadPages() {
  state.pages = (await api('/v1/pages')).pages;
}

async function loadTimeline() {
  if (!state.selected) return;
  const { pageKey, label } = state.selected;
  state.timeline = await api(`/v1/timeline?pageKey=${encodeURIComponent(pageKey)}&label=${encodeURIComponent(label)}&limit=100`);
}

async function select(page) {
  state.selected = { pageKey: page.pageKey, label: page.label };
  state.timeline = null;
  render();
  try {
    await loadTimeline();
  } catch (e) {
    toast(e.message);
  }
  render();
}

async function refresh() {
  try {
    await loadPages();
    await loadTimeline();
  } catch (e) {
    toast(e.message);
  }
  render();
}

// ---------------------------------------------------------------- compare

function setSide(side, snap) {
  state[side] = snap;
  render();
}

function describe(snap, tag) {
  if (!snap) return `${tag}: not set`;
  return `${tag}: ${snap.label} • ${fmtTime(snap.createdAt)}`;
}

function renderCompare() {
  const { a, b } = state;
  const wrap = h('section', { class: 'compare' });
  const bar = h('div', { class: 'bar' },
    h('strong', {}, 'Compare'),
    h('span', { class: 'badge' }, describe(a, 'A')),
    h('span', { class: 'badge' }, describe(b, 'B')),
    (a || b) && h('button', { class: 'small', onclick: () => { state.a = null; state.b = null; render(); } }, 'Clear')
  );
  wrap.append(bar);

  if (!a || !b) {
    wrap.append(h('div', { class: 'summary' }, 'Use the A and B buttons on two snapshots below. They can come from different pages or labels (for example two systems).'));
    return wrap;
  }

  const summary = h('div', { class: 'summary' }, 'Comparing...');
  wrap.append(
    h('div', { class: 'bar' },
      ['side', 'diff', 'blend'].map((v) =>
        h('button', { class: `small${state.view === v ? ' active' : ''}`, onclick: () => { state.view = v; render(); } },
          { side: 'Side by side', diff: 'Difference', blend: 'Blend' }[v])
      )
    ),
    summary
  );

  const imgA = `/v1/snapshots/${a.id}/image`;
  const imgB = `/v1/snapshots/${b.id}/image`;
  const body = h('div', {});
  wrap.append(body);

  if (state.view === 'side') {
    body.append(h('div', { class: 'views side' },
      h('figure', {}, h('figcaption', {}, 'A (before)'), lazyImg(imgA, 'Snapshot A')),
      h('figure', {}, h('figcaption', {}, 'B (after)'), lazyImg(imgB, 'Snapshot B'))
    ));
  } else if (state.view === 'diff') {
    body.append(h('div', { class: 'views' },
      h('figure', {}, h('figcaption', {}, 'Changed pixels in magenta/red'), lazyImg(`/v1/compare?a=${a.id}&b=${b.id}&format=png`, 'Difference'))
    ));
  } else {
    const top = lazyImg(imgB, 'Snapshot B');
    top.className = 'top';
    top.style.opacity = '0.5';
    const val = h('span', { class: 'val' }, '50%');
    const slider = h('input', {
      type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Blend between A and B',
      oninput: (e) => { top.style.opacity = String(e.target.value / 100); val.textContent = `${e.target.value}%`; }
    });
    body.append(
      h('div', { class: 'blend-ctl' }, 'A', slider, 'B', val),
      h('div', { class: 'views' }, h('div', { class: 'blend' }, lazyImg(imgA, 'Snapshot A'), top))
    );
  }

  api(`/v1/compare?a=${a.id}&b=${b.id}`).then((d) => {
    const r = d.result;
    summary.replaceChildren(
      h('span', { class: `badge ${r.verdict}` }, r.verdict), ' ',
      h('b', {}, `${r.diffPercentage}%`), ` of pixels changed (${r.diffPixels.toLocaleString()})`,
      r.sizeMismatch ? ` • sizes differ: ${r.sizeA.width}×${r.sizeA.height} vs ${r.sizeB.width}×${r.sizeB.height}` : ''
    );
  }).catch((e) => { summary.textContent = e.message; });

  return wrap;
}

// ---------------------------------------------------------------- timeline

async function approve(snap) {
  if (!confirm('Use this snapshot as the new approved baseline for this page and label?')) return;
  try {
    await api('/v1/baselines', { method: 'POST', body: { snapshotId: snap.id } });
    toast('Baseline approved.');
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function editNote(snap) {
  const note = prompt('Note for this snapshot (what changed, ticket, build...)', snap.note || '');
  if (note === null) return;
  try {
    await api(`/v1/snapshots/${snap.id}`, { method: 'PATCH', body: { note } });
    await loadTimeline();
    render();
  } catch (e) {
    toast(e.message);
  }
}

function renderEntry(snap, baselineId) {
  const isBaseline = snap.id === baselineId;
  const change = pct(snap);
  return h('article', { class: `entry${state.a?.id === snap.id ? ' isA' : ''}${state.b?.id === snap.id ? ' isB' : ''}` },
    h('div', { class: 'thumb' }, lazyImg(`/v1/snapshots/${snap.id}/image`, 'Snapshot thumbnail')),
    h('div', {},
      h('div', { class: 'line1' },
        h('span', { class: 'when' }, fmtTime(snap.createdAt)),
        h('span', { class: `badge ${snap.verdict}` }, snap.verdict),
        change && h('span', { class: 'badge' }, `${change} changed`),
        isBaseline && h('span', { class: 'badge baseline' }, 'baseline')
      ),
      h('div', { class: 'info' },
        `${snap.source} • ${snap.width}×${snap.height}`,
        snap.url ? ` • ${snap.url}` : '',
        snap.meta?.tag ? ` • "${snap.meta.tag}"` : ''
      ),
      snap.note && h('div', { class: 'note' }, snap.note)
    ),
    h('div', { class: 'actions' },
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => setSide('a', snap) }, 'A'),
        h('button', { class: 'small', onclick: () => setSide('b', snap) }, 'B')
      ),
      !isBaseline && h('button', { class: 'small', onclick: () => approve(snap) }, 'Approve'),
      h('button', { class: 'small', onclick: () => editNote(snap) }, 'Note')
    )
  );
}

function renderMain() {
  const main = h('main', { class: 'main' });
  main.append(renderCompare());

  if (!state.selected) {
    main.append(h('div', { class: 'empty' }, state.pages.length ? 'Select a page on the left to see its timeline.' : 'No snapshots yet. Send one from the extension or from Playwright.'));
    return main;
  }

  const { pageKey, label } = state.selected;
  main.append(h('div', { class: 'head' },
    h('h2', {}, pageKey),
    h('span', { class: 'meta' }, `label: ${label}`)
  ));

  if (!state.timeline) {
    main.append(h('div', { class: 'empty' }, 'Loading...'));
    return main;
  }

  const baselineId = state.timeline.baselines?.[label]?.snapshotId;
  const list = h('div', { class: 'timeline' });
  for (const s of state.timeline.snapshots) list.append(renderEntry(s, baselineId));
  main.append(list);
  return main;
}

// ---------------------------------------------------------------- shell

function renderSidebar() {
  const search = h('input', {
    type: 'search', placeholder: 'Filter pages...', value: state.filter, 'aria-label': 'Filter pages',
    oninput: (e) => { state.filter = e.target.value; renderList(); }
  });
  const list = h('div', {});
  function renderList() {
    const query = state.filter.toLowerCase();
    list.replaceChildren(
      ...state.pages
        .filter((p) => !query || p.pageKey.toLowerCase().includes(query) || p.label.toLowerCase().includes(query))
        .map((p) => {
          const sel = state.selected && state.selected.pageKey === p.pageKey && state.selected.label === p.label;
          return h('button', { class: `page-item${sel ? ' selected' : ''}`, onclick: () => select(p) },
            h('div', { class: 'pk' }, p.pageKey),
            h('div', { class: 'sub' },
              h('span', {}, `${p.label} • ${p.count} snapshot${p.count === 1 ? '' : 's'}`),
              h('span', { class: `badge ${p.lastVerdict}` }, p.lastVerdict)
            )
          );
        })
    );
    if (!list.children.length) list.append(h('div', { class: 'empty' }, 'No pages.'));
  }
  renderList();
  return h('aside', { class: 'sidebar' }, search, list);
}

function render() {
  if (!state.key || !state.who) {
    renderLogin();
    return;
  }
  root.replaceChildren(
    h('div', { class: 'shell' },
      h('header', { class: 'topbar' },
        h('h1', {}, 'UI Regression Hub'),
        h('div', { class: 'who' },
          `key: ${state.who.key} (${(state.who.scopes || []).join(', ')})`,
          h('button', { class: 'small', onclick: refresh }, 'Refresh'),
          h('button', { class: 'small', onclick: logout }, 'Sign out')
        )
      ),
      renderSidebar(),
      renderMain()
    )
  );
}

// ---------------------------------------------------------------- start

async function start() {
  if (!state.key) return renderLogin();
  try {
    state.who = await api('/v1/whoami');
    await loadPages();
    render();
  } catch (e) {
    renderLogin(e.message);
  }
}

start();
