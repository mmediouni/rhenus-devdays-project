import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeGroups, findGroup, groupKeyFor, siblingUrls, envLabel, suggestGroups, pickDefaultPair
} from '../utils/environments.js';
import { normalizeHtmlForDiff } from '../utils/text-diff.js';

const TEST = 'shop-test.dev.example.com';
const QA = 'shop-qa.dev.example.com';
const groups = [{ name: 'shop', domains: [TEST, QA] }];

test('sanitizeGroups keeps only groups with 2+ unique domains and lowercases hosts', () => {
  const clean = sanitizeGroups([
    { name: ' app ', domains: ['A.example.com', 'a.example.com', 'b.example.com'] },
    { name: 'single', domains: ['only.example.com'] },
    { name: 5, domains: [] },
    null
  ]);
  assert.deepEqual(clean, [{ name: 'app', domains: ['a.example.com', 'b.example.com'] }]);
  assert.deepEqual(sanitizeGroups('nope'), []);
});

test('same page on different environments gets the same group key', () => {
  const a = groupKeyFor(`https://${TEST}/app/page/?x=1#top`, groups);
  const b = groupKeyFor(`https://${QA}/app/page?x=1`, groups);
  assert.equal(a, b);
  assert.equal(a, 'env:shop|/app/page?x=1');
});

test('different paths or queries stay separate inside a group', () => {
  assert.notEqual(
    groupKeyFor(`https://${TEST}/a`, groups),
    groupKeyFor(`https://${QA}/b`, groups)
  );
  assert.notEqual(
    groupKeyFor(`https://${TEST}/a?x=1`, groups),
    groupKeyFor(`https://${QA}/a?x=2`, groups)
  );
});

test('ungrouped hosts keep host-specific keys', () => {
  assert.notEqual(
    groupKeyFor('https://one.example.com/p', groups),
    groupKeyFor('https://two.example.com/p', groups)
  );
});

test('findGroup is case-insensitive', () => {
  assert.equal(findGroup(TEST.toUpperCase(), groups).name, 'shop');
  assert.equal(findGroup('nope.example.com', groups), null);
});

test('siblingUrls maps the URL onto every domain of the group', () => {
  const urls = siblingUrls(`https://${TEST}/a?b=1`, groups);
  assert.deepEqual(urls, [`https://${TEST}/a?b=1`, `https://${QA}/a?b=1`]);
  assert.deepEqual(siblingUrls('https://x.example.com/a', groups), ['https://x.example.com/a']);
});

test('envLabel strips the shared prefix inside a group', () => {
  assert.equal(envLabel(TEST, groups), 'test');
  assert.equal(envLabel(QA, groups), 'qa');
});

test('envLabel falls back to a heuristic for ungrouped hosts', () => {
  assert.equal(envLabel('shop-uat.dev.example.com'), 'uat');
  assert.equal(envLabel('localhost'), 'localhost');
  assert.equal(envLabel('staging.example.com'), 'staging');
});

test('suggestGroups proposes hosts that differ only by environment suffix', () => {
  const suggestions = suggestGroups([TEST, QA, 'other.dev.example.com', 'foo-test.b.example.com']);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].name, 'shop');
  assert.deepEqual(suggestions[0].domains, [QA, TEST]);
});

test('suggestGroups skips groups that already exist', () => {
  assert.deepEqual(suggestGroups([TEST, QA], groups), []);
});

test('pickDefaultPair prefers another environment in auto mode', () => {
  const snaps = [
    { id: 'q1', domain: QA },
    { id: 'q0', domain: QA },
    { id: 't0', domain: TEST }
  ];
  assert.equal(pickDefaultPair(snaps, 'auto').baseline.id, 't0');
  assert.equal(pickDefaultPair(snaps, 'previous').baseline.id, 'q0');
  assert.equal(pickDefaultPair(snaps, 'auto').current.id, 'q1');
});

test('pickDefaultPair falls back to the previous snapshot with a single environment', () => {
  const snaps = [{ id: 'a', domain: TEST }, { id: 'b', domain: TEST }];
  assert.equal(pickDefaultPair(snaps, 'auto').baseline.id, 'b');
  assert.deepEqual(pickDefaultPair([], 'auto'), { current: null, baseline: null });
});

test('normalizeHtmlForDiff masks environment hosts', () => {
  const a = normalizeHtmlForDiff(`<a href="https://${TEST}/x">l</a>`, [TEST, QA]);
  const b = normalizeHtmlForDiff(`<a href="https://${QA}/x">l</a>`, [TEST, QA]);
  assert.equal(a, b);
  assert.ok(a.includes('{env-host}'));
});
