/**
 * UI Regression Detector - Environment groups
 *
 * Lets several domains (e.g. rhex-test.* and rhex-qaint.*) be treated as the
 * same application, so the same page on different environments can be compared.
 * Grouping is applied when snapshots are READ, so it works retroactively and
 * nothing stored in IndexedDB is rewritten.
 *
 * Everything except loadGroups/saveGroups is pure (no chrome.* / DOM).
 */

import { normalizeUrl } from './common.js';

const STORAGE_KEY = 'environmentGroups';

/** Validate / clean groups: [{ name, domains: [host, ...] }] with >= 2 unique domains */
export function sanitizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(g => g && typeof g.name === 'string' && Array.isArray(g.domains))
    .map(g => ({
      name: g.name.trim().slice(0, 60) || 'Group',
      domains: [...new Set(
        g.domains
          .filter(d => typeof d === 'string')
          .map(d => d.trim().toLowerCase())
          .filter(Boolean)
      )]
    }))
    .filter(g => g.domains.length >= 2);
}

export async function loadGroups() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return sanitizeGroups(result[STORAGE_KEY]);
  } catch (e) {
    return [];
  }
}

export async function saveGroups(groups) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sanitizeGroups(groups) });
}

export function findGroup(host, groups = []) {
  const h = String(host || '').toLowerCase();
  return groups.find(g => g.domains.includes(h)) || null;
}

/**
 * Key used to group snapshots of "the same page".
 * Hosts in a group share a key (group name + path + query); others use origin + path + query.
 */
export function groupKeyFor(url, groups = []) {
  try {
    const u = new URL(url);
    const group = findGroup(u.hostname, groups);
    if (!group) return normalizeUrl(url);
    return `env:${group.name.toLowerCase()}|${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch (e) {
    return normalizeUrl(url);
  }
}

/** The same URL on every domain of the URL's group (or just [url] when ungrouped). */
export function siblingUrls(url, groups = []) {
  try {
    const u = new URL(url);
    const group = findGroup(u.hostname, groups);
    if (!group) return [url];
    return group.domains.map(d => {
      const copy = new URL(url);
      copy.hostname = d;
      return copy.href;
    });
  } catch (e) {
    return [url];
  }
}

/**
 * Short environment label for a host, e.g. rhex-test.appdev... -> "test".
 * Within a group, the first-label tokens shared by every domain are stripped.
 */
export function envLabel(host, groups = []) {
  const h = String(host || '').toLowerCase();
  const firstLabel = (d) => d.split('.')[0];
  const group = findGroup(h, groups);

  if (group) {
    const tokenLists = group.domains.map(d => firstLabel(d).split('-'));
    let common = 0;
    const minLen = Math.min(...tokenLists.map(t => t.length));
    while (common < minLen - 1 && tokenLists.every(t => t[common] === tokenLists[0][common])) common++;
    const own = firstLabel(h).split('-').slice(common).join('-');
    // Domains that differ beyond the first label: fall back to the full host
    const labels = group.domains.map(d => firstLabel(d).split('-').slice(common).join('-'));
    if (own && new Set(labels).size === labels.length) return own;
    return h;
  }

  const first = firstLabel(h);
  const idx = first.lastIndexOf('-');
  return idx > 0 ? first.slice(idx + 1) : first || h;
}

/**
 * Suggest groups from detected domains: hosts whose first label shares a prefix
 * before the last "-" and whose remaining labels are identical
 * (rhex-test.appdev.x.zz + rhex-qaint.appdev.x.zz -> "rhex").
 */
export function suggestGroups(domains, existingGroups = []) {
  const buckets = new Map();
  for (const raw of domains) {
    const host = String(raw).toLowerCase();
    const labels = host.split('.');
    const idx = labels[0].lastIndexOf('-');
    if (idx <= 0) continue;
    const key = `${labels[0].slice(0, idx)}|${labels.slice(1).join('.')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(host);
  }

  const suggestions = [];
  for (const [key, hosts] of buckets) {
    const unique = [...new Set(hosts)].sort();
    if (unique.length < 2) continue;
    const alreadyGrouped = existingGroups.some(g => unique.every(h => g.domains.includes(h)));
    if (alreadyGrouped) continue;
    suggestions.push({ name: key.split('|')[0], domains: unique });
  }
  return suggestions;
}

/**
 * Default baseline/current pair for a list of snapshots (newest first).
 * mode 'auto': compare against the newest snapshot from a DIFFERENT domain when one exists
 *              (cross-environment), otherwise against the previous snapshot.
 * mode 'previous': always the previous snapshot.
 */
export function pickDefaultPair(snaps, mode = 'auto') {
  const current = snaps[0] || null;
  if (!current) return { current: null, baseline: null };
  if (mode === 'auto') {
    const other = snaps.find(s => s.domain !== current.domain);
    if (other) return { current, baseline: other };
  }
  return { current, baseline: snaps[1] || snaps[0] };
}
