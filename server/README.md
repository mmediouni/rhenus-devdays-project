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

### Staging on Vercel + Supabase (step by step)

Use your own accounts. Nothing here is tied to a specific account, and every value is an environment variable.

**1. Supabase (database + image bucket)**
1. Create a project. Note the database password.
2. *Storage* > *New bucket* > name `snapshots`, keep it **private**.
3. *Project Settings* > *Database* > *Connection string*: copy the **Transaction pooler** string (port 6543, recommended for serverless) and put your password in it. This is `DATABASE_URL`.
4. *Project Settings* > *API*: copy the project URL and the **service_role** key (a secret: server only, never in the extension or the browser).

**2. Create the tables and a key** (once, from your computer, in `server/`)
```bash
export DATABASE_URL="postgresql://postgres.xxxx:PASSWORD@aws-0-xx.pooler.supabase.com:6543/postgres"
npm install
npm run migrate                       # creates the tables
npm run create-key -- my-project laptop   # prints the API key once: copy it
```

**3. Deploy on Vercel**
1. *Add New* > *Project* > import this repository and pick the branch to deploy.
2. Set **Root Directory** to `server`. Framework preset: **Other**. Leave build and output settings empty (there is no build step).
3. Add the environment variables below, then **Deploy**.
4. Open `https://<your-app>.vercel.app/v1/health`. It must answer `{"ok":true,"db":"postgres","storage":"supabase",...}`.
5. Open `https://<your-app>.vercel.app/`, paste the API key, and you see the dashboard.

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | the Supabase pooler connection string |
| `URD_STORAGE` | `supabase` |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the service_role key |
| `SUPABASE_BUCKET` | `snapshots` |

The server refuses to start on Vercel with the in-memory database or local disk storage (they would silently lose data), and says what is missing.

**4. Point the clients at it**
- Extension popup > *Hub sync*: URL `https://<your-app>.vercel.app`, your API key.
- Playwright / CI: `URD_URL=https://<your-app>.vercel.app` and `URD_KEY=<key>`.

**Limits to know:** Vercel functions limit the request body to about 4.5 MB, so very large full-page screenshots can be rejected there (the extension shows "image too large for this hub"). A direct-to-storage upload is the planned fix; a self-hosted server has no such limit (`URD_MAX_BODY_BYTES`). Check the function timeout of your Vercel plan for very large images.

**Moving to your own server later:** deploy the Docker image (below) with a PostgreSQL, run `npm run migrate` there, and either keep using the Supabase bucket (same variables) or set `URD_STORAGE=local`. Existing data is not moved automatically; export it from Postgres and copy the bucket files if you need the history.

### Internal server / Docker

```bash
docker build -t urd-hub server
docker run -p 8787:8787 -v urd-data:/data \
  -e DATABASE_URL=postgres://... -e URD_PG_SSL=disable urd-hub
```

## Web dashboard

The hub serves a dashboard at `/` (the `public/` folder, no build step). Paste an API key to sign in; the key stays in your browser's local storage and is sent only to this hub.

- **Left:** every page and label with its latest verdict, with a filter.
- **Timeline:** each snapshot with thumbnail, verdict, % changed, source, URL, note and a **baseline** marker.
- **Compare:** set any two snapshots as **A** and **B** (they may come from different labels, for example two systems) and view them side by side, as a difference image or with a blend slider.
- **Approve** makes a snapshot the new baseline; **Note** records what changed.

Locally without a database you can try it with a demo key:

```bash
URD_DEV_KEY=urd_demo_key npm start      # http://localhost:8787, in-memory, lost on restart
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

## Chrome extension sync

Open the extension popup, expand **Hub sync**, then enter the hub URL and an API key and press **Test connection**, then **Save**.

- The extension stays local-first. Snapshots are always saved in the browser; the upload is an extra step after each capture.
- The full-page screenshot is uploaded (viewport image if no full page was captured).
- **Label** sent to the hub is either the page domain (default, keeps each system's history separate) or a fixed text you choose (environment, branch, build...).
- If the hub is unreachable (or answers 5xx/429), the snapshot is queued and retried on the next capture, when you press Save, and when the browser starts. Permanent errors (bad key, image too large) are shown and not retried.
- No extra browser permission is needed: the hub answers cross-origin requests and the key is sent as a bearer token. Set `URD_CORS_ORIGIN` if you want to restrict origins.

## Not built yet

Pulling the shared timeline back into the extension, Cypress command, direct-to-storage uploads, key management endpoints, text/HTML diff in the hub.
