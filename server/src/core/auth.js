import { createHash, randomBytes } from 'node:crypto';

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/** Returns { key, hash }. The clear key must be shown to the user once. */
export function generateKey() {
  const key = 'urd_' + randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key) };
}

export function bearerFrom(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  // Convenience header for tools that cannot set Authorization
  return request.headers.get('x-api-key') || '';
}

/** Resolve a request to { projectId, scopes, keyId } or null. */
export async function authenticate(request, db) {
  const key = bearerFrom(request);
  if (!key) return null;
  const row = await db.findKeyByHash(hashKey(key));
  if (!row || row.revokedAt) return null;
  return { projectId: row.projectId, scopes: row.scopes, keyId: row.id, keyName: row.name };
}

export function can(auth, scope) {
  return !!auth && (auth.scopes.includes(scope) || auth.scopes.includes('admin'));
}
