# UI Regression Hub

Central, portable API for UI Regression Detector. The Chrome extension, Playwright, Cypress and CI all send screenshots to the same place. The hub compares each one with the previous snapshot and with the approved baseline, and keeps a change log (timeline) per page.

> Status: first iteration (branch `v2.0.0-hub`). The extension keeps working fully offline on its own; the hub is optional.

## Concepts

| Term | Meaning |
|------|---------|
| **project** | A workspace. An API key belongs to exactly one project. |
| **pageKey** | Identity of a page or test step, independent of the host. Either given (`pageKey` / `step`) or derived from the URL path + query. |
| **label** | Free-form tag: environment, branch, build number... Nothing is hardcoded. |
| **snapshot** | One screenshot with its comparison results. Append-only, so the timeline is the change log. |
| **baseline** | The approved reference per (pageKey, label). The first snapshot becomes it automatically. |

Verdict (same thresholds as the extension): `NEW`, `PASS`, `MINOR_DIFF`, `REGRESSION` (>= 0.2%).

## Portability

Everything that differs between environments is an environment variable. The code has three swappable layers:

| Layer | Options | Variable |
|-------|---------|----------|
| Database | PostgreSQL (Supabase, managed, self-hosted) or in-memory | `DATABASE_URL`, `URD_DB` |
| Image storage | local disk, Supabase Storage | `URD_STORAGE` |
| Hosting | Vercel (`api/index.js`), plain Node (`src/standalone.js`), Docker | n/a |

No Supabase SDK is used: Postgres is reached with plain SQL and Storage through its REST API. Leaving Supabase means changing `DATABASE_URL` and setting `URD_STORAGE=local`.

### Try it locally (no database)

```bash
cd server
npm install
npm start          # in-memory database, images in ./data
```

Keys cannot be created against the in-memory database, so for anything real use Postgres:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/urd
export URD_PG_SSL=disable
npm run migrate
npm run create-key -- my-project ci
npm start
```

### Staging on Vercel + Supabase

1. Supabase: create a project and a **private** Storage bucket named `snapshots`.
2. Run `npm run migrate` once with the Supabase connection string as `DATABASE_URL`.
3. Vercel: import the repo, set **Root Directory** to `server`, and add the variables below.
4. Create a key with `npm run create-key` (using the same `DATABASE_URL`).

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Supabase Postgres connection string |
| `URD_STORAGE` | `supabase` |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service role key (server only, never in the extension) |
| `SUPABASE_BUCKET` | `snapshots` |

Vercel functions limit the request body to about 4.5 MB, so very large full-page screenshots can be rejected there. A direct-to-storage upload is the planned fix; a self-hosted server has no such limit (`URD_MAX_BODY_BYTES`).

### Internal server / Docker

```bash
docker build -t urd-hub server
docker run -p 8787:8787 -v urd-data:/data \
  -e DATABASE_URL=postgres://... -e URD_PG_SSL=disable urd-hub
```

## API

All routes except `/v1/health` need `Authorization: Bearer <key>` (or `X-API-Key`). Scopes: `read`, `write`.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/v1/health` | Liveness, shows db and storage kind |
| GET | `/v1/whoami` | Project and scopes of the key |
| POST | `/v1/snapshots` | Upload and compare a screenshot |
| GET | `/v1/snapshots/:id` | Snapshot with comparison results |
| GET | `/v1/snapshots/:id/image` | The PNG |
| PATCH | `/v1/snapshots/:id` | Set a note `{note}` |
| GET | `/v1/timeline?pageKey=&label=&limit=` | Change log of a page (newest first) |
| GET | `/v1/pages` | All pages and labels with the latest verdict |
| GET | `/v1/compare?a=&b=[&format=png]` | Diff two stored snapshots (JSON or diff image) |
| POST | `/v1/baselines` | Approve a snapshot as baseline `{snapshotId}` |

`POST /v1/snapshots` body:

```json
{
  "step": "checkout-step-2",
  "url": "https://app.example/checkout",
  "label": "main",
  "source": "playwright",
  "viewport": { "width": 1280, "height": 720 },
  "image": "<base64 PNG or data URL>",
  "meta": { "build": "1234" }
}
```

Only PNG is accepted at the moment.

## Playwright

```js
import { createClient } from '../server/clients/urd-client.js';
const urd = createClient({ baseUrl: process.env.URD_URL, apiKey: process.env.URD_KEY, label: process.env.URD_LABEL || 'main' });

test('shipment list', async ({ page }) => {
  await page.goto('/shipments');
  await urd.snapshotPage(page, 'shipment-list');   // throws on REGRESSION
});
```

## Tests

```bash
cd server && npm install && npm test
```

The API tests use the in-memory database and storage, so no Postgres is needed.

## Security notes

- Keys are stored as SHA-256 hashes and shown once. Scope them per project and revoke by setting `revoked_at`.
- Screenshots may contain sensitive data. Use a private bucket, and prefer self-hosting for internal applications.
- `SUPABASE_SERVICE_KEY` must only exist on the server.

## Not built yet

Extension sync (upload queue and pull), hub-served web dashboard, Cypress command, direct-to-storage uploads, key management endpoints, text/HTML diff in the hub.
