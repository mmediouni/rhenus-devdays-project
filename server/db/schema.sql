-- UI Regression Hub schema. Plain PostgreSQL: works on Supabase, any managed
-- Postgres, or a self-hosted instance. No Supabase-specific features are used.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- API keys are stored hashed (sha256). The clear key is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT ARRAY['read','write'],
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- One row per captured screenshot. Append-only: the timeline is the change log.
-- page_key identifies "the same page or step" independently of the host.
-- label is a free-form tag (environment, branch, build number, ...).
CREATE TABLE IF NOT EXISTS snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_key     text NOT NULL,
  label        text NOT NULL DEFAULT 'default',
  source       text NOT NULL DEFAULT 'api',
  url          text,
  viewport_w   integer,
  viewport_h   integer,
  image_key    text NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  note         text,
  prev_id      uuid,
  baseline_id  uuid,
  vs_prev      jsonb,
  vs_baseline  jsonb,
  verdict      text NOT NULL DEFAULT 'NEW',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_timeline_idx
  ON snapshots (project_id, page_key, label, created_at DESC);

-- The approved reference per (page, label). Mutable: last approval wins.
CREATE TABLE IF NOT EXISTS baselines (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_key     text NOT NULL,
  label        text NOT NULL,
  snapshot_id  uuid NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  approved_by  text,
  PRIMARY KEY (project_id, page_key, label)
);
