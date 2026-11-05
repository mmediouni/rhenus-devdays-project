import pg from 'pg';

function sslOption(config) {
  const mode = config.pgSsl;
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  // auto: managed hosts (Supabase, ...) need TLS, localhost does not
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(config.databaseUrl);
  return local ? false : { rejectUnauthorized: false };
}

function snap(r) {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    pageKey: r.page_key,
    label: r.label,
    source: r.source,
    url: r.url,
    viewport: r.viewport_w ? { width: r.viewport_w, height: r.viewport_h } : null,
    imageKey: r.image_key,
    width: r.width,
    height: r.height,
    meta: r.meta || {},
    note: r.note,
    prevId: r.prev_id,
    baselineId: r.baseline_id,
    vsPrev: r.vs_prev,
    vsBaseline: r.vs_baseline,
    verdict: r.verdict,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
  };
}

export function createPostgresDb(config) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required when URD_DB=postgres');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: sslOption(config),
    max: 5
  });

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',

    async createProject(name) {
      const r = await q(
        `INSERT INTO projects (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, created_at`,
        [name]
      );
      return { id: r.rows[0].id, name: r.rows[0].name };
    },

    async createKey({ projectId, name, hash, scopes }) {
      const r = await q(
        `INSERT INTO api_keys (project_id, name, key_hash, scopes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [projectId, name, hash, scopes]
      );
      return { id: r.rows[0].id };
    },

    async findKeyByHash(hash) {
      const r = await q(
        `SELECT id, project_id, name, scopes, revoked_at FROM api_keys WHERE key_hash = $1`,
        [hash]
      );
      const k = r.rows[0];
      if (!k) return null;
      return { id: k.id, projectId: k.project_id, name: k.name, scopes: k.scopes, revokedAt: k.revoked_at };
    },

    async insertSnapshot(s) {
      const r = await q(
        `INSERT INTO snapshots
          (id, project_id, page_key, label, source, url, viewport_w, viewport_h, image_key,
           width, height, meta, prev_id, baseline_id, vs_prev, vs_baseline, verdict)
         VALUES (COALESCE($17::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          s.projectId, s.pageKey, s.label, s.source, s.url || null,
          s.viewport?.width ?? null, s.viewport?.height ?? null, s.imageKey,
          s.width, s.height, JSON.stringify(s.meta || {}),
          s.prevId || null, s.baselineId || null,
          s.vsPrev ? JSON.stringify(s.vsPrev) : null,
          s.vsBaseline ? JSON.stringify(s.vsBaseline) : null,
          s.verdict,
          s.id || null
        ]
      );
      return snap(r.rows[0]);
    },

    async getSnapshot(projectId, id) {
      const r = await q(`SELECT * FROM snapshots WHERE project_id = $1 AND id = $2`, [projectId, id]);
      return snap(r.rows[0]);
    },

    async latestSnapshot(projectId, pageKey, label) {
      const r = await q(
        `SELECT * FROM snapshots WHERE project_id=$1 AND page_key=$2 AND label=$3
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, pageKey, label]
      );
      return snap(r.rows[0]);
    },

    async timeline(projectId, pageKey, label, limit = 50) {
      const params = [projectId, pageKey, limit];
      let sql = `SELECT * FROM snapshots WHERE project_id=$1 AND page_key=$2`;
      if (label) {
        params.push(label);
        sql += ` AND label=$4`;
      }
      sql += ` ORDER BY created_at DESC LIMIT $3`;
      const r = await q(sql, params);
      return r.rows.map(snap);
    },

    async listPages(projectId) {
      const r = await q(
        `SELECT DISTINCT ON (page_key, label) page_key, label, created_at AS last_at, verdict AS last_verdict,
                (SELECT count(*) FROM snapshots s2 WHERE s2.project_id = s.project_id
                   AND s2.page_key = s.page_key AND s2.label = s.label)::int AS count
         FROM snapshots s WHERE project_id = $1
         ORDER BY page_key, label, created_at DESC`,
        [projectId]
      );
      return r.rows
        .map((x) => ({
          pageKey: x.page_key,
          label: x.label,
          count: x.count,
          lastAt: x.last_at instanceof Date ? x.last_at.toISOString() : x.last_at,
          lastVerdict: x.last_verdict
        }))
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    },

    async getBaseline(projectId, pageKey, label) {
      const r = await q(
        `SELECT * FROM baselines WHERE project_id=$1 AND page_key=$2 AND label=$3`,
        [projectId, pageKey, label]
      );
      const b = r.rows[0];
      if (!b) return null;
      return {
        projectId: b.project_id, pageKey: b.page_key, label: b.label,
        snapshotId: b.snapshot_id, approvedBy: b.approved_by,
        approvedAt: b.approved_at instanceof Date ? b.approved_at.toISOString() : b.approved_at
      };
    },

    async setBaseline({ projectId, pageKey, label, snapshotId, approvedBy }) {
      await q(
        `INSERT INTO baselines (project_id, page_key, label, snapshot_id, approved_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, page_key, label)
         DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id, approved_by = EXCLUDED.approved_by, approved_at = now()`,
        [projectId, pageKey, label, snapshotId, approvedBy || null]
      );
      return this.getBaseline(projectId, pageKey, label);
    },

    async updateSnapshotNote(projectId, id, note) {
      const r = await q(
        `UPDATE snapshots SET note = $3 WHERE project_id = $1 AND id = $2 RETURNING *`,
        [projectId, id, note]
      );
      return snap(r.rows[0]);
    },

    async runSql(sql) {
      await pool.query(sql);
    },

    async close() {
      await pool.end();
    }
  };
}
