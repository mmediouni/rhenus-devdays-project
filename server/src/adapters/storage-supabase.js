// Stores images in a Supabase Storage bucket through its REST API (no SDK, so the
// server has no hard dependency on Supabase). Needs a private bucket and the
// service role key. To leave Supabase, switch URD_STORAGE to "local" (or add an
// S3 adapter with the same two methods: put / get).
export function createSupabaseStorage(config) {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required when URD_STORAGE=supabase');
  }
  const base = `${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(config.supabaseBucket)}`;
  const headers = {
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    apikey: config.supabaseServiceKey
  };
  const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

  return {
    kind: 'supabase',

    async put(key, buffer, contentType = 'image/png') {
      const res = await fetch(`${base}/${encodeKey(key)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'true' },
        body: buffer
      });
      if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },

    async get(key) {
      const res = await fetch(`${base}/${encodeKey(key)}`, { headers });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`Storage download failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }
  };
}
