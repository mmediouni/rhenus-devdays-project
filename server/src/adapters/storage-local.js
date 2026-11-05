import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Stores images as files on disk. Use for local or internal-server deployments.
export function createLocalStorage(config) {
  const root = path.resolve(config.storageDir);

  function resolveSafe(key) {
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  return {
    kind: 'local',
    async put(key, buffer) {
      const full = resolveSafe(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buffer);
    },
    async get(key) {
      try {
        return await readFile(resolveSafe(key));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    }
  };
}

// In-memory storage for tests.
export function createMemoryStorage() {
  const files = new Map();
  return {
    kind: 'memory',
    async put(key, buffer) {
      files.set(key, Buffer.from(buffer));
    },
    async get(key) {
      return files.get(key) || null;
    }
  };
}
