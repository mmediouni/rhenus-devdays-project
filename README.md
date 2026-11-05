# 🎯 UI Regression Detector

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Pure JavaScript](https://img.shields.io/badge/Extension-Vanilla%20ES6+-yellow?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![IndexedDB](https://img.shields.io/badge/Storage-IndexedDB%20Unlimited-green?logo=databricks)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](https://opensource.org/licenses/MIT)

**UI Regression Detector** captures page snapshots (screenshot, full-page screenshot, DOM, CSS) and shows what changed between two moments: pixel heatmaps, line-by-line HTML and CSS diffs, and an exportable report.

It has two parts that work together or alone:

| Part | What it is | Needed? |
|------|-----------|---------|
| **Chrome extension** | Captures snapshots and compares them in a dashboard. Everything stays in your browser. | Yes |
| **Hub** (`server/`) | A small API that also receives screenshots from **Playwright, Cypress and CI**, compares them with the previous run and the approved baseline, and keeps a change log per page. Runs on Vercel, a plain Node server or Docker. | Optional |

---

## 📑 Table of Contents

- [Why UI Regression Detector?](#-why-ui-regression-detector)
- [System Architecture](#-system-architecture)
- [How to Use (step by step)](#-how-to-use-step-by-step)
  - [Part A: Use the extension on its own](#part-a-use-the-extension-on-its-own)
  - [Part B: Compare the same app on several systems](#part-b-compare-the-same-app-on-several-systems)
  - [Part C: Connect the extension to a hub](#part-c-connect-the-extension-to-a-hub)
  - [Part D: Send screenshots from Playwright or CI](#part-d-send-screenshots-from-playwright-or-ci)
  - [Understanding the results](#understanding-the-results)
- [Core Features](#-core-features)
- [Installation Guide](#-installation-guide)
- [File & Codebase Organization](#-file--codebase-organization)
- [Technical Deep Dive](#-technical-deep-dive)
- [Privacy & Security](#-privacy--security)
- [License](#-license)

---

## 💡 Why UI Regression Detector?

Typical visual testing tools need heavy CI infrastructure or a paid cloud. This project starts where you already are, in the browser, and grows only when you need it:

- 🚀 **Zero setup for the extension**: load it in Chrome, no build step, no dependencies.
- 🔒 **Local by default**: snapshots live in your browser's IndexedDB. Nothing is sent anywhere unless you turn on hub sync.
- ⚡ **Instant feedback**: change something, take a second snapshot, see the pixel heatmap and the HTML/CSS changes at once.
- 🔌 **Portable hub when you need it**: share history with a team and feed it from automated tests. The hub is configured only through environment variables, so it moves from a staging cloud to your own server without code changes.
- 🏷️ **Nothing hardcoded**: environments are just labels (a domain, `staging`, a branch, a build number) that you choose.

---

## 🏗️ System Architecture

```mermaid
flowchart LR
    subgraph Browser
        Popup[Popup] --> SW[Service Worker]
        SW --> CS[Content Script\nDOM + CSS + viewport]
        SW --> IDB[(IndexedDB\nlocal history)]
        IDB --> Dash[Dashboard\nvisual / HTML / CSS diff]
    end

    SW -. optional upload\nAPI key .-> Hub

    subgraph Hub[Hub - server/]
        API[HTTP API] --> Diff[Pixel diff +\nverdict]
        Diff --> DB[(PostgreSQL)]
        Diff --> Files[(Image storage\nlocal or Supabase)]
    end

    PW[Playwright] -->|API key| API
    CY[Cypress / CI] -->|API key| API
```

The extension never depends on the hub: if it is off or unreachable, you keep working locally, and queued uploads are retried later.

---

## 📖 How to Use (step by step)

### Part A: Use the extension on its own

This is the core workflow and needs nothing but Chrome.

**1. Install the extension** (see [Installation Guide](#-installation-guide)) and pin its icon.

**2. Take a first snapshot (your reference).**
Open the page you want to watch, click the extension icon, type a label such as `Baseline 1.0`, and press **Take Snapshot Now**.
*What happens:* the extension takes a screenshot of the visible area, scrolls the page to build a full-page screenshot, and records the HTML, the CSS and key computed styles. Animations are frozen and fonts/images awaited first, so repeated captures are stable. Everything is saved in your browser. The toolbar badge shows how many snapshots exist for this page.

*Tip:* leave **Capture Full Page** ticked unless the page is extremely long or has infinite scrolling.

**3. Change something, then take a second snapshot.**
Deploy a change, edit the CSS, or switch to another build. Reload the same page, use the same window size, and take another snapshot with a new label such as `After refactor`.
*Why the same window size:* screenshots of different sizes cannot be compared fairly, and the dashboard warns you when they differ.

**4. Read the quick result in the popup.**
When there are two or more snapshots, the popup shows a **Quick Regression Check** with an approximate `% diff` between the latest two. It is a fast hint, not the final answer.

**5. Open the full dashboard.**
Press **Open Full Regression Dashboard**. Pick the page in the left sidebar. The two snapshots to compare are chosen in the top bar:
- **Baseline (A)**: the reference, the "before".
- **Current (B)**: the version you are checking, the "after".

**6. Choose the scope: Viewport or Full Page.**
👁️ **Viewport** compares what was visible on screen. 📜 **Full Page** compares the whole page from top to bottom. The summary banner shows the percentage of pixels that changed and a verdict (see [Understanding the results](#understanding-the-results)).

**7. Look at the change in four ways.** Use the tabs of the visual panel:
- **Side-by-Side**: both images next to each other.
- **Slider Wipe**: drag the handle to reveal A and B on the same spot, best for spotting small shifts.
- **Difference Mask**: only the changed pixels, in magenta, with a box around the changed area.
- **Onion Skin**: a blend slider under the preview mixes A and B. Move it to see elements "jump".

**8. Check what changed in the code.** Beside the pixels:
- **HTML**: Unified or Split diff, one tag per line, with long unchanged parts collapsed. Added lines are green, removed lines red.
- **CSS**: changes in key styles (font, color, spacing, display...) on landmark elements such as header, nav, main, buttons.
- **Metadata**: element counts, viewport and page details.

This answers "what changed visually" and "which code change caused it".

**9. Remove noise (false positives).**
- **Tolerance slider**: raise it to ignore tiny color differences such as anti-aliasing.
- **Ignore regions**: hold `Shift` and drag a rectangle on the **Difference Mask** to exclude areas that always change, like ads, clocks or carousels. They are remembered for that page. Use **Clear ignored regions** to remove them.

**10. Decide: bug or intended change?**
- If it is a **bug**, fix it and take a new snapshot.
- If it is **intended**, press **✓ Approve as new baseline** in the summary banner. Snapshot B becomes the reference for that page, and later snapshots are compared against it by default. You can also pin any snapshot with **☆ Golden**.

**11. Share the result.**
- **Export HTML Report** creates one self-contained file (screenshots included) to attach to a ticket or pull request.
- **Export JSON** backs up all snapshots, and **Import** restores them, for example on another computer.

**Try it without your own app:** open `demo/sample-app.html`, take a snapshot, click one of the simulator buttons (change color, shift layout, modify text), take another snapshot, and open the dashboard.

---

### Part B: Compare the same app on several systems

Teams often run the same app on several hosts, for example a test system and a QA system. Define them as one **environment group** and they are treated as one application.

1. In the dashboard sidebar press **🌐 Environments…**.
2. Accept a **suggested group** (hosts that differ only by a name like `test` / `qa` are suggested automatically), or tick the domains yourself and create a group with a name.
3. Take snapshots of the same page on each system. Pages with the same path and query are merged into one entry, with a small badge showing the environment on every snapshot.
4. In the sidebar, set **Default compare**:
   - *Other environment*: compares the newest snapshot with the newest one from a different environment (system against system).
   - *Previous snapshot*: classic before/after on the same system.
5. In the HTML diff, host names are masked (`{env-host}`), so links that differ only by host do not hide the real differences.

Groups apply when reading, so snapshots you already took are merged immediately and nothing stored is rewritten.

---

### Part C: Connect the extension to a hub

Do this when you want a shared history for a team, or want automated tests to feed the same timeline. The extension keeps working locally either way.

**1. Start a hub.** Pick one (details in [server/README.md](server/README.md)):
- *Quickest, on your own machine:* run PostgreSQL (for example in Docker), then
  ```bash
  cd server
  npm install
  export DATABASE_URL=postgres://user:pass@localhost:5432/urd
  export URD_PG_SSL=disable
  npm run migrate        # creates the tables
  npm start              # http://localhost:8787
  ```
- *Staging in the cloud:* deploy `server/` to Vercel and use Supabase for the database and image bucket.
- *Internal server:* run the Docker image from `server/` with your own PostgreSQL.

The same code runs in all three. Moving from one to another only changes environment variables.

**2. Create an API key** (shown once, store it safely):
```bash
npm run create-key -- my-project laptop
```
A key belongs to one project and can have `read` and `write` rights.

**3. Configure the extension.** Open the popup, expand **Hub sync**, then:
- tick *Upload snapshots to the hub*,
- enter the **Hub URL** (for example `http://localhost:8787`) and the **API key**,
- choose the **label** sent with every snapshot: the page domain (separate history per system) or a fixed text such as `staging` or `build-42`,
- press **Test connection**, then **Save**.

**4. Take snapshots as usual.** After each capture the popup also shows the hub's answer, for example `Hub: PASS`, `Hub: REGRESSION (3.1% changed)` or `first snapshot, saved as baseline`.
*How the hub decides:* the first snapshot of a page becomes its baseline automatically. Every later one is compared with the previous snapshot and with the approved baseline.

**5. If the hub is down,** nothing is lost. The snapshot stays in your browser, is queued, and is uploaded on the next capture, when you press Save, or when the browser starts.

---

### Part D: Send screenshots from Playwright or CI

Automated tests can send a screenshot at any moment and get an immediate verdict.

**1.** Make sure a hub is running and you have an API key (Part C, steps 1-2). Give the test environment two variables: `URD_URL` and `URD_KEY`.

**2.** Use the small client from this repository in your Playwright test:

```js
import { test } from '@playwright/test';
import { createClient } from '../server/clients/urd-client.js';

const urd = createClient({
  baseUrl: process.env.URD_URL,
  apiKey: process.env.URD_KEY,
  label: process.env.URD_LABEL || 'main'   // environment, branch or build: you decide
});

test('shipment list looks the same', async ({ page }) => {
  await page.goto('/shipments');
  await urd.snapshotPage(page, 'shipment-list');   // screenshot + upload + compare
});
```

**3. What happens on each run.**
- The first run stores the screenshot as the baseline for `shipment-list`.
- Later runs are compared with it. If more than 0.2% of the pixels changed, the verdict is `REGRESSION` and `snapshotPage` throws, so the test fails with the percentage in the message.
- Every run is added to the page's timeline, which is the change log.

**4. Accept an intended change** by approving that snapshot as the new baseline (`POST /v1/baselines` or `urd.approve(snapshotId)`). Without this step, the old design keeps failing.

**5. Read the history:** `GET /v1/timeline?pageKey=shipment-list` returns every run, newest first, with its verdict and percentage. Cypress and other tools can call the same HTTP API (documented in [server/README.md](server/README.md)).

> Run baseline and comparison runs on the same machine type or CI image. Fonts and anti-aliasing differ between systems and cause small false differences.

---

### Understanding the results

| Verdict | Meaning |
|---------|---------|
| **NEW** (hub) | First snapshot of this page and label. It becomes the baseline. |
| **PASS** | No pixel changed. |
| **MINOR_DIFF** | Less than 0.2% of pixels changed. Often anti-aliasing or a small detail. Worth a look. |
| **REGRESSION** | 0.2% or more changed. Something visible moved or changed. |

- The **percentage** is changed pixels divided by total pixels. The **tolerance** controls how different a pixel must be to count.
- If the two images have **different sizes**, the extra area counts as changed. For full-page captures a height difference is normal when content was added; a width difference usually means different window sizes.
- Very large images are compared at a reduced size for speed and marked as approximate.

---

## ✨ Core Features

### Multi-layer snapshots
- **Visual**: visible-viewport screenshot and a stitched full-page screenshot (fixed headers hidden between slices).
- **Structure**: cleaned HTML, doctype and element counts.
- **Styling**: embedded and external stylesheet rules, plus computed styles of key landmarks and `[data-testid]` elements.
- **Environment**: URL, domain, title, window size, device pixel ratio and scroll offsets.

### Regression Studio dashboard
Domain filter and search, baseline and current selectors, scope switcher (Viewport / Full Page), four visual modes (Side-by-Side, Slider Wipe, Difference Mask, Onion Skin), HTML diff (Unified / Split), CSS landmark comparison and metadata comparison.

### DOM and code diff
Myers O(ND) line diff with prefix/suffix trimming, so large pages diff quickly. HTML is normalized before comparing (one tag per line, script bodies and nonces removed) and long unchanged runs are collapsed.

### Reducing false positives
Tolerance slider, ignore regions, golden baseline, animation freezing, font and image waiting, size-mismatch warnings.

### Environment groups
Treat several hosts as one app and compare the same page across them (see [Part B](#part-b-compare-the-same-app-on-several-systems)).

### Approve as new baseline
One click to accept the current snapshot as the reference for the page.

### Reports
Standalone HTML report with embedded screenshots, and JSON backup/import.

### Hub (optional)
Central API with API keys, a timeline per page, baselines, host-independent page identity, and a dependency-free client for tests (see [server/README.md](server/README.md)).

---

## 🚀 Installation Guide

### The extension
Requires Google Chrome or a Chromium browser (Edge, Brave, ...). No build step.

1. Clone or download the repository:
   ```bash
   git clone https://github.com/mmediouni/rhenus-devdays-project.git
   ```
2. Open `chrome://extensions/` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin the **UI Regression Detector** icon in the toolbar.

### Development tools (optional)
Node.js 18.17 or newer is needed only to run tests and lint, or to run the hub.

```bash
npm install
npm test        # unit tests for diffs, environment groups and hub helpers
npm run lint
cd server && npm install && npm test      # hub API tests
```

---

## 📁 File & Codebase Organization

```
rhenus-devdays-project/
├── manifest.json            # Manifest V3 configuration & permissions
├── package.json             # Dev tooling only (tests, lint)
├── eslint.config.js  .prettierrc.json
├── tests/                   # Unit tests for the extension (node --test)
├── .github/workflows/ci.yml # Lint, test, package; also tests the hub
├── CHANGELOG.md  LICENSE
├── background/service-worker.js   # Capture coordinator, retention, hub upload
├── content/content.js             # Extracts DOM, CSS & viewport data
├── popup/                         # Toolbar popup (capture, quick compare, hub settings)
├── dashboard/                     # Regression studio (visual, HTML and CSS diff, environments dialog)
├── utils/
│   ├── db.js                # IndexedDB storage (indexed, validated import/export)
│   ├── common.js            # escapeHtml, URL normalization, safe URL/image helpers
│   ├── environments.js      # Environment groups (merge several hosts into one app)
│   ├── hub.js               # Optional hub sync: settings, upload, retry queue
│   ├── ui.js                # Toasts and dialogs
│   ├── visual-diff.js       # Canvas pixel diff, ignore regions, heatmap
│   └── text-diff.js         # Myers line diff & CSS landmark inspector
├── server/                  # The hub (own package.json; see server/README.md)
│   ├── src/core/            # Framework-agnostic API, auth, PNG diff
│   ├── src/adapters/        # Swappable database and storage (Postgres, memory, local disk, Supabase)
│   ├── api/index.js         # Vercel entry point
│   ├── src/standalone.js    # Plain Node / Docker entry point
│   ├── db/schema.sql        # PostgreSQL schema
│   ├── clients/urd-client.js# Client for Playwright / Cypress tasks / CI
│   └── scripts/             # create-key, migrate
├── demo/sample-app.html     # Interactive testbed page
└── icons/
```

---

## 🔬 Technical Deep Dive

### Pixel distance
The extension's diff weighs color channels by perceived brightness on offscreen canvas buffers:

$$\Delta = (|R_A - R_B| \times 0.299) + (|G_A - G_B| \times 0.587) + (|B_A - B_B| \times 0.114) + (|A_A - A_B| \times 0.1)$$

Pixels above the tolerance are drawn on the heatmap with a bounding box. The hub uses `pixelmatch` with the same 0.2% regression threshold.

### Storage
Screenshots and HTML exceed `chrome.storage.local` limits, so the extension uses IndexedDB (`UIRegressionDetectorDB`) with indexes on url, domain, timestamp and a normalized `pageKey` (origin + path + query). The newest 30 snapshots per page are kept. The hub stores metadata in PostgreSQL and images in files or a storage bucket.

### Hub design
- `createApp({ db, storage, config })` is a pure `Request -> Response` function, so the same code runs on Vercel, Node or Docker.
- Page identity is host-independent (`pageKey`), and `label` is free text, which is what lets the same page be tracked per system, branch or build.
- Snapshots are append-only; only baselines and notes change.

---

## 🔒 Privacy & Security

- **Local by default**: with hub sync off, the extension does not contact any server and all data stays in your browser.
- **Optional hub sync**: only if you enable it and enter a hub URL and API key, the full-page screenshot, page URL, title and viewport size of each new snapshot are uploaded. HTML and CSS are not uploaded. Use a hub you control for internal applications, since screenshots can show sensitive data.
- **Hub keys**: stored hashed (SHA-256) on the hub, scoped per project, shown once. The extension keeps its key in `chrome.storage.local`. The storage service key (Supabase) belongs only on the server.
- **Permissions**: `activeTab`, `scripting`, `storage`, `unlimitedStorage`. The content script is injected only when you capture. No `tabs` or host permissions.
- **Redaction**: password and hidden input values and CSRF meta tokens are removed from stored HTML. Treat exported JSON and HTML reports as sensitive.
- **Safe import**: imported JSON is validated; only raster data-URL images and http(s)/file URLs are accepted.

---

## 📄 License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).
