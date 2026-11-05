// All deployment differences live in environment variables, so moving from the
// staging setup (Vercel + Supabase) to an internal server is a config change.

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 8787),
    // memory | postgres
    db: env.URD_DB || (env.DATABASE_URL ? 'postgres' : 'memory'),
    databaseUrl: env.DATABASE_URL || '',
    // set URD_PG_SSL=disable for a local Postgres without TLS
    pgSsl: env.URD_PG_SSL || 'auto',
    // local | supabase
    storage: env.URD_STORAGE || (env.SUPABASE_URL ? 'supabase' : 'local'),
    storageDir: env.URD_STORAGE_DIR || './data',
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY || '',
    supabaseBucket: env.SUPABASE_BUCKET || 'snapshots',
    // Comma separated origins, or * . Auth is by bearer key (no cookies), so * is safe.
    corsOrigin: env.URD_CORS_ORIGIN || '*',
    maxBodyBytes: int(env.URD_MAX_BODY_BYTES, 12 * 1024 * 1024),
    // Pixel diff defaults (same meaning as the extension)
    diffThreshold: Number(env.URD_DIFF_THRESHOLD ?? 0.1),
    regressionPercent: Number(env.URD_REGRESSION_PERCENT ?? 0.2)
  };
}
