import { randomUUID } from 'node:crypto';

// In-memory database: zero setup for tests and quick demos. Data is lost on restart.
export function createMemoryDb() {
  const projects = new Map();
  const keys = new Map();
  const snapshots = [];
  const baselines = new Map();

  const bKey = (p, page, label) => `${p}|${page}|${label}`;

  return {
    kind: 'memory',

    async createProject(name) {
      for (const p of projects.values()) if (p.name === name) return p;
      const p = { id: randomUUID(), name, createdAt: new Date().toISOString() };
      projects.set(p.id, p);
      return p;
    },

    async createKey({ projectId, name, hash, scopes }) {
      const k = { id: randomUUID(), projectId, name, hash, scopes, revokedAt: null };
      keys.set(hash, k);
      return k;
    },

    async findKeyByHash(hash) {
      return keys.get(hash) || null;
    },

    async insertSnapshot(s) {
      const row = { id: randomUUID(), createdAt: new Date().toISOString(), note: null, ...s };
      snapshots.push(row);
      return row;
    },

    async getSnapshot(projectId, id) {
      return snapshots.find((s) => s.projectId === projectId && s.id === id) || null;
    },

    async latestSnapshot(projectId, pageKey, label) {
      for (let i = snapshots.length - 1; i >= 0; i--) {
        const s = snapshots[i];
        if (s.projectId === projectId && s.pageKey === pageKey && s.label === label) return s;
      }
      return null;
    },

    async timeline(projectId, pageKey, label, limit = 50) {
      return snapshots
        .filter((s) => s.projectId === projectId && s.pageKey === pageKey && (!label || s.label === label))
        .slice(-limit)
        .reverse();
    },

    async listPages(projectId) {
      const map = new Map();
      for (const s of snapshots) {
        if (s.projectId !== projectId) continue;
        const k = `${s.pageKey}|${s.label}`;
        const cur = map.get(k) || { pageKey: s.pageKey, label: s.label, count: 0, lastAt: s.createdAt, lastVerdict: s.verdict };
        cur.count++;
        cur.lastAt = s.createdAt;
        cur.lastVerdict = s.verdict;
        map.set(k, cur);
      }
      return [...map.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    },

    async getBaseline(projectId, pageKey, label) {
      return baselines.get(bKey(projectId, pageKey, label)) || null;
    },

    async setBaseline({ projectId, pageKey, label, snapshotId, approvedBy }) {
      const row = { projectId, pageKey, label, snapshotId, approvedBy: approvedBy || null, approvedAt: new Date().toISOString() };
      baselines.set(bKey(projectId, pageKey, label), row);
      return row;
    },

    async updateSnapshotNote(projectId, id, note) {
      const s = await this.getSnapshot(projectId, id);
      if (!s) return null;
      s.note = note;
      return s;
    },

    async close() {}
  };
}
