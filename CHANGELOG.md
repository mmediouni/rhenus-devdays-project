# Changelog

## Unreleased (branch v2.0.0-hub)

### Added
- **Hub server** (`server/`): portable API that receives screenshots from the extension, Playwright, Cypress or CI, compares them with the previous snapshot and the approved baseline, and keeps a timeline per page. Runs on Vercel, plain Node or Docker; PostgreSQL (Supabase or any) and local or Supabase storage are swappable through environment variables.
- Dependency-free client for Playwright / CI (`server/clients/urd-client.js`).
- **Optional hub sync in the extension**: popup section to set the hub URL, API key and label rule; snapshots are uploaded after capture, the hub verdict is shown, and failed uploads are queued and retried. The extension still works fully offline.

## 1.4.0 - 2026-11-05

### Added
- **Approve as new baseline**: one-click button in the diff summary banner that accepts the Current (B) snapshot as the golden reference for the page.

## 1.3.1 - 2026-11-05

### Changed
- Onion Skin: preview now uses the full width; the blend controls are a compact bar under the preview instead of a wide left column.

## 1.3.0 - 2026-11-05

### Added
- **Environment groups**: treat several domains (e.g. `shop-test.*` / `shop-qa.*`) as one app so the same page can be compared across environments. Auto-suggested groups, environment badges, "default compare" mode (other environment vs previous snapshot), host masking in HTML diffs, cross-environment history in the popup.

## 1.2.0 - 2026-11-04

### Fixed
- Line diff no longer truncates at 1500 lines or overflows; replaced with Myers O(ND) diff plus prefix/suffix trimming and a safe fallback for huge changes.
- Full-page capture is rate-limit safe (>= 600 ms between `captureVisibleTab` calls), uses real capture dimensions, caps canvas size, and records `fullPageFailed` / `fullPageTruncated` instead of silently substituting the viewport image.
- Differing image sizes are detected and warned about instead of silently counting padding as changes.
- Verdict thresholds live in one place (`utils/visual-diff.js`).
- Snapshot lookup uses a new indexed `pageKey` (DB v2, auto-migrated) instead of loading every snapshot.
- Pages that differ only by query string are no longer merged.
- Deleting the last snapshot of a page no longer leaves stale selections; "clear all" no longer destroys the dashboard DOM.

### Security
- No more `innerHTML`/`href` injection of stored values; images are validated as raster data URLs, report links must be http(s).
- Imported JSON is validated and sanitized.
- Removed the always-on `<all_urls>` content script and the `tabs` permission; the content script is injected on demand via `activeTab`.
- Passwords, hidden input values and CSRF meta tokens are redacted from stored HTML.

### Added
- Ignore regions (Shift+drag on the Difference Mask), tolerance slider, golden baseline pinning.
- Animation freezing and font/image wait before capture.
- Readable HTML diffs (one tag per line, script bodies stripped) with collapsed unchanged runs.
- Per-page retention (newest 30 snapshots kept).
- More landmark selectors and `data-testid` element styles.
- Keyboard/touch accessible comparison slider; in-page dialogs and toasts instead of `alert`/`confirm`.
- Unit tests (`npm test`), ESLint config, CI workflow, LICENSE.
