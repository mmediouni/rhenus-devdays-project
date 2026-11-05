# 🎯 UI Regression Detector

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Pure JavaScript](https://img.shields.io/badge/Zero%20Dependencies-Vanilla%20ES6+-yellow?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![IndexedDB](https://img.shields.io/badge/Storage-IndexedDB%20Unlimited-green?logo=databricks)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](https://opensource.org/licenses/MIT)

**UI Regression Detector** is a Google Chrome extension engineered for frontend developers, QA engineers, and designers. It captures full-fidelity page snapshots—combining **high-resolution visual screenshots, full DOM structures, embedded & external CSS, and computed landmark styles**—and provides an analysis studio to detect and inspect regressions between revisions.

---

## 📑 Table of Contents

- [Why UI Regression Detector?](#-why-ui-regression-detector)
- [System Architecture](#-system-architecture)
- [Core Features](#-core-features)
  - [1. Comprehensive Multi-Layer Snapshotting](#1-comprehensive-multi-layer-snapshotting)
  - [2. Quick-Compare Popup](#2-quick-compare-popup)
  - [3. Regression Studio Dashboard](#3-regression-studio-dashboard)
  - [4. Visual Diff Modes](#4-visual-diff-modes)
  - [5. DOM & Code Diff Engine](#5-dom--code-diff-engine)
  - [6. CSS Landmark Styles Inspector](#6-css-landmark-styles-inspector)
  - [7. Standalone HTML Audit Reports](#7-standalone-html-audit-reports)
- [Installation Guide](#-installation-guide)
- [Quick Start / 30-Second Tutorial](#-quick-start--30-second-tutorial)
- [File & Codebase Organization](#-file--codebase-organization)
- [Technical Deep Dive](#-technical-deep-dive)
- [Privacy & Security](#-privacy--security)
- [Contributing & License](#-contributing--license)

---

## 💡 Why UI Regression Detector?

Traditional visual regression tools either require heavy CI/CD infrastructure (Playwright, Cypress, Percy) or cloud subscriptions with slow feedback loops. 

**UI Regression Detector** lives directly in your browser:
- 🚀 **Zero Setup**: No Node.js build steps, no headless browser servers, zero npm dependencies.
- 🔒 **100% Local & Private**: All data stays inside your browser's IndexedDB. No images or code ever leave your machine.
- ⚡ **Instant Verification**: Make changes in your local dev server or staging environment, take a second snapshot, and instantly see pixel-level heatmaps and line-by-line DOM/CSS changes.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    User([User / Tester]) -->|Click Toolbar Icon| Popup[Popup Window\npopup.html / popup.js]
    Popup -->|Capture Request| SW[Service Worker\nservice-worker.js]
    
    subgraph Data Capture Phase
        SW -->|chrome.tabs.captureVisibleTab| Screen[PNG Screenshot Buffer]
        SW -->|EXTRACT_PAGE_SNAPSHOT| CS[Content Script\ncontent.js]
        CS -->|Extracts| DOM[Clean HTML & Doctype]
        CS -->|Extracts| CSS[Stylesheets & Computed Landmarks]
        CS -->|Extracts| Meta[Viewport, DPR & Document Title]
    end
    
    Screen --> DB[(IndexedDB Storage\nUIRegressionDetectorDB)]
    DOM --> DB
    CSS --> DB
    Meta --> DB
    
    DB -->|Read History & Baselines| Dashboard[Regression Studio Dashboard\ndashboard.html / dashboard.js]
    
    subgraph Analysis Engines
        Dashboard --> VDiff[Visual Diff Engine\nPixel-by-pixel Canvas Delta]
        Dashboard --> TDiff[Text & DOM Engine\nMyers LCS Diff Algorithm]
        Dashboard --> CSSDiff[Landmark Styles Inspector\nComputed Property Matcher]
    end
    
    VDiff --> Report[Export Standalone HTML Report]
    TDiff --> Report
    CSSDiff --> Report
```

---

## ✨ Core Features

### 1. Dual-Scope Multi-Layer Snapshotting
A snapshot captures four distinct layers simultaneously, with dual visual scopes:
- **Visual Layer (Dual Screenshots)**:
  - 👁️ **Visible Viewport Screenshot**: High-speed, high-definition capture of the immediate screen viewport.
  - 📜 **Full-Page Stitched Screenshot**: Automatically scrolls from top to bottom, hides fixed/sticky navigation repetitions, captures high-DPI slices, and stitches them on an offscreen canvas into a single continuous image.
- **Structural Layer**: Complete outer HTML, doctype, and element count metrics (buttons, links, scripts, inputs, images).
- **Styling Layer**: Embedded `<style>` rules, external CSS rules, and computed styles for crucial landmarks (`body`, `header`, `nav`, `main`, `footer`, `h1`, `button`, etc.).
- **Environment Metadata**: Page URL, domain, title, window dimensions, device pixel ratio (DPR), and scroll offsets.

### 2. Quick-Compare Popup
- **Instant Delta Badge**: Calculates an approximate (downscaled) visual difference percentage between the previous and the latest snapshot right in the popup (e.g. `2.45% diff`).
- **Full-Page Toggle**: Option to enable/disable full-page capture alongside the standard viewport screenshot.
- **Page Timeline**: Lists historical snapshots taken on the current URL.
- **One-Click Jump**: Launch directly into the full comparison studio.

### 3. Regression Studio Dashboard
A full-screen dashboard organized into:
- **Scope Switcher**: Seamlessly toggle between **👁️ Viewport View** and **📜 Full Page View**—instantly recalculating regressions and updating all comparison modes for the chosen perspective.
- **Left Sidebar**: Filter snapshots by page domain, search by page title or snapshot label, and view chronological snapshot timelines.
- **Top Bar**: Set any snapshot as **Baseline (Reference A)** and any other as **Comparison (Target B)**.
- **Top Metrics**: Displays real-time regression status, pixel differences count, and percentage.

### 4. Visual Diff Modes
Switch seamlessly between 4 specialized visual comparison modes:
1. **Side-by-Side**: Synchronized baseline and comparison panes.
2. **Interactive Slider Wipe**: Draggable curtain handle to wipe across both images and spot differences interactively.
3. **Difference Mask (Heatmap)**: Isolates modified pixels in vibrant fluorescent magenta (`#FF006E`) against dimmed context, accompanied by an adaptive regression bounding box.
4. **Onion Skin**: Transparency blend slider (0% to 100%) to spot subtle micro-shifts and padding alterations.

### 5. DOM & Code Diff Engine
- Built on the **Myers O(ND)** line-diff algorithm with common prefix/suffix trimming, so large pages diff quickly and correctly.
- HTML is normalized before diffing (one tag per line, script bodies and nonces removed) so noise doesn't drown real changes; long unchanged runs are collapsed.
- Supports **Unified Diff** and **Side-by-Side Split Diff** with green addition (`+`) and red deletion (`-`) styling.
- Structural node metric diffs: quickly identify newly added or dropped tags, images, links, or scripts.

### 6. CSS Landmark Styles Inspector
- Automatically flags changes in key CSS properties across landmark components:
  - Typography (`font-family`, `font-size`, `font-weight`, `line-height`)
  - Colors (`color`, `background-color`)
  - Box Model (`padding`, `margin`, `border-radius`, `box-shadow`)
  - Layout (`display`, `position`)

### 7. Reducing False Positives
- **Tolerance slider**: per-pixel color tolerance for the visual diff.
- **Ignore regions**: `Shift`+drag on the *Difference Mask* to exclude dynamic areas (ads, timestamps, carousels). Regions are remembered per page.
- **Golden baseline**: pin any snapshot with `☆ Golden`; it becomes the default reference for that page.
- **Approve as new baseline**: after reviewing a diff, click **✓ Approve as new baseline** in the summary banner to accept the Current (B) snapshot as the golden reference. Every later snapshot of that page (on any environment in its group) is compared against it by default. The button shows **✓ Approved baseline** when B is already the approved one; pick another snapshot with `☆ Golden` to change it.
- Animations are frozen and fonts/images awaited before capture. Compare snapshots taken at the same window size (the dashboard warns when sizes differ).

### 8. Comparing Environments (TEST vs QAINT vs …)
The same app often runs on several hosts, e.g. `rhex-test.appdev.service.rhs.zz` and `rhex-qaint.appdev.service.rhs.zz`. Define them as an **environment group** and they are treated as one application:
- In the dashboard sidebar click **🌐 Environments…**. Groups like `rhex` (test + qaint) are **suggested automatically**; or tick domains and create one manually.
- Pages with the same **path + query** on any domain of the group are merged into one entry, with environment badges (`test`, `qaint`) on every snapshot and in the A/B dropdowns. Existing snapshots merge immediately; nothing stored is rewritten.
- **Default compare** (sidebar): *Other environment* compares the newest snapshot against the newest one from a different environment; *Previous snapshot* keeps classic before/after regression checks. The popup quick-compare follows the same setting.
- Host names are **masked in the HTML diff** (`{env-host}`), so absolute URLs that differ only by host don't drown the real differences.
- The popup lists snapshots of the same page from the other environments too.

### 9. Standalone HTML Audit Reports
- Click **Export HTML Report** to generate a single, self-contained HTML file containing embedded screenshots, diff summaries, and metadata.
- Ideal for attaching to Pull Requests, bug tickets, or sending to QA managers.

---

## 🚀 Installation Guide

### Prerequisites
- Google Chrome or any Chromium-based browser (Edge, Brave, Arc, Opera, Vivaldi).
- **No Node.js or build steps required!**

### Step-by-Step Installation:
1. Clone or download this repository:
   ```bash
   git clone https://github.com/mmediouni/rhenus-devdays-project.git
   ```
2. Open Google Chrome and enter in the address bar:
   ```text
   chrome://extensions/
   ```
3. Enable **Developer mode** via the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. In the file picker, select the cloned directory (the one containing `manifest.json`).
6. The **UI Regression Detector** icon will now appear in your browser toolbar! (Pin it for easy access).

---

## 🧪 Quick Start / 30-Second Tutorial

An interactive testbed page is included in the `demo/` folder so you can test the extension immediately without running your own app:

1. Open `demo/sample-app.html` in Chrome (drag the file into your browser or press `Ctrl + O`).
2. Click the **UI Regression Detector** toolbar icon.
3. Name your snapshot `Baseline 1.0` and click **Take Snapshot Now**.
4. In the test page, click one of the simulator buttons:
   - 🎨 *Change Button Color (CSS)*
   - 📐 *Shift Padding & Size (Layout)*
   - ✍️ *Modify Price & Copy (DOM)*
5. Open the extension popup, label it `Post-Refactor`, and click **Take Snapshot Now**.
6. Click **Open Full Regression Dashboard** to inspect the visual slider, pixel difference heatmap, code diff, and computed CSS property changes!

---

## 📁 File & Codebase Organization

```
rhenus-devdays-project/
├── manifest.json            # Manifest V3 extension configuration & permissions
├── package.json             # Dev tooling only (tests, lint) - the extension has no build step
├── eslint.config.js         # Lint rules
├── tests/                   # Unit tests (node --test)
├── .github/workflows/ci.yml # Lint, test and package on every push / PR
├── CHANGELOG.md  LICENSE
├── README.md                # Comprehensive project documentation & guide
├── background/
│   └── service-worker.js    # Tab capture coordinator & message router
├── content/
│   └── content.js           # Content script extracting DOM, CSS & viewport data
├── popup/
│   ├── popup.html           # Extension toolbar popup interface
│   ├── popup.css            # Dark/neon styled interface stylesheet
│   └── popup.js             # Popup controller & quick-diff runner
├── dashboard/
│   ├── dashboard.html       # Full-screen regression analysis studio
│   ├── dashboard.css        # Studio design system & split-view styling
│   ├── environments-ui.js   # "Environments…" dialog (suggested + manual groups)
│   └── dashboard.js         # Visual slider wipe, DOM diffing, & HTML report export
├── utils/
│   ├── db.js                # Promisified IndexedDB storage manager (indexed, validated import)
│   ├── common.js            # escapeHtml, URL normalization, safe URL / image helpers
│   ├── environments.js      # Environment groups: merge domains (test/qaint/...) into one app
│   ├── ui.js                # In-page toast / confirm dialogs
│   ├── visual-diff.js       # HTML5 Canvas pixel diff, ignore regions & heatmap mask generator
│   └── text-diff.js         # Myers line diff & CSS landmark inspector
├── demo/
│   └── sample-app.html      # Interactive testbed page with UI toggles
└── icons/                   # High-res extension icons (16px, 48px, 128px)
```

---

## 🔬 Technical Deep Dive

### Pixel-by-Pixel Color Distance Formula
The visual diff engine utilizes a weighted perceptual luminance Euclidean distance algorithm on offscreen Canvas image buffers:

$$\Delta = (|R_A - R_B| \times 0.299) + (|G_A - G_B| \times 0.587) + (|B_A - B_B| \times 0.114) + (|A_A - A_B| \times 0.1)$$

Pixels exceeding the variance threshold are flagged and drawn on the difference heatmap canvas with bounding box coordinates `[minX, minY, maxX, maxY]`.

### Storage Architecture
Screenshots and complete HTML DOM trees can exceed Chrome's `chrome.storage.local` limits (5MB–10MB). UI Regression Detector implements a promisified **IndexedDB** engine (`UIRegressionDetectorDB`) with indexes on `url`, `domain`, `timestamp` and a normalized `pageKey` (origin + path + query), so per-page lookups don't scan the whole store. The newest 30 snapshots per page are kept automatically.

### Development
```bash
npm install
npm test      # unit tests for the diff engines and helpers
npm run lint
```

---

## 🔒 Privacy & Security

- **No Remote Telemetry**: By default the extension does not communicate with any server.
- **Local Storage by Default**: All captured data resides in your browser's local IndexedDB.
- **Optional Hub Sync**: only if you enable *Hub sync* in the popup and enter a hub URL and API key, the full-page screenshot, page URL, title and viewport size of each new snapshot are uploaded to that hub (see [server/README.md](server/README.md)). HTML and CSS data are not uploaded. Use a hub you control for internal applications.
- **Permission Scoping**: Uses `activeTab` and `scripting`; the content script is injected on demand when you click *Take Snapshot*, never automatically on every page. No `tabs` or host permissions.
- **Redaction**: password / hidden input values and CSRF-token meta tags are removed from stored HTML. Snapshots still contain the rest of the page (including any personal data visible on it), so treat exported JSON and HTML reports as sensitive and avoid snapshotting pages with secrets you can't share.
- **Safe import**: imported JSON is validated; only raster data-URL images and http(s)/file URLs are accepted.

---

## 📄 License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).
