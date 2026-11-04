import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTextDiff, normalizeHtmlForDiff, compareLandmarkStyles, compareDomStats } from '../utils/text-diff.js';

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

/** Rebuild A and B from diff items to prove the diff is lossless */
function reconstruct(items) {
  return {
    a: items.filter(i => i.type !== 'add').map(i => i.text),
    b: items.filter(i => i.type !== 'delete').map(i => i.text)
  };
}

test('identical text has no changes', () => {
  const d = computeTextDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(d.stats.hasChanges, false);
  assert.equal(d.stats.unchanged, 3);
});

test('detects single line change', () => {
  const d = computeTextDiff('a\nb\nc', 'a\nX\nc');
  assert.equal(d.stats.added, 1);
  assert.equal(d.stats.deleted, 1);
  const { a, b } = reconstruct(d.diffItems);
  assert.deepEqual(a, ['a', 'b', 'c']);
  assert.deepEqual(b, ['a', 'X', 'c']);
});

test('is correct beyond the old 1500-line limit', () => {
  const a = lines(5000);
  const b = [...a];
  b[4200] = 'CHANGED';
  b.splice(4800, 0, 'INSERTED');
  const d = computeTextDiff(a.join('\n'), b.join('\n'));
  assert.equal(d.stats.added, 2);
  assert.equal(d.stats.deleted, 1);
  const r = reconstruct(d.diffItems);
  assert.deepEqual(r.a, a);
  assert.deepEqual(r.b, b);
});

test('interleaved edits reconstruct both sides exactly', () => {
  const a = lines(300);
  const b = a.filter((_, i) => i % 7 !== 0);
  b.splice(50, 0, 'new-1', 'new-2');
  b.splice(200, 0, 'new-3');
  const d = computeTextDiff(a.join('\n'), b.join('\n'));
  const r = reconstruct(d.diffItems);
  assert.deepEqual(r.a, a);
  assert.deepEqual(r.b, b);
});

test('line numbers are monotonic and consistent', () => {
  const d = computeTextDiff('a\nb\nc\nd', 'a\nc\nd\ne');
  let lastA = 0;
  let lastB = 0;
  for (const item of d.diffItems) {
    if (item.lineA !== null) assert.equal(item.lineA, ++lastA);
    if (item.lineB !== null) assert.equal(item.lineB, ++lastB);
  }
  assert.equal(lastA, 4);
  assert.equal(lastB, 4);
});

test('handles empty inputs', () => {
  assert.equal(computeTextDiff('', 'x').stats.hasChanges, true);
  assert.equal(computeTextDiff('x', '').stats.deleted, 1);
});

test('very different inputs fall back without throwing', () => {
  const d = computeTextDiff(lines(4000, 'a').join('\n'), lines(4000, 'b').join('\n'));
  assert.equal(d.stats.truncated, true);
  const r = reconstruct(d.diffItems);
  assert.equal(r.a.length, 4000);
  assert.equal(r.b.length, 4000);
});

test('rendered HTML escapes content and collapses long unchanged runs', () => {
  const a = [...lines(100), '<script>alert(1)</script>'].join('\n');
  const b = [...lines(100), '<b>x</b>'].join('\n');
  const html = computeTextDiff(a, b).renderUnifiedHtml();
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('unchanged lines'));
});

test('normalizeHtmlForDiff splits tags and drops script bodies / nonces', () => {
  const out = normalizeHtmlForDiff('<div><script nonce="abc">secret()</script><p>x</p></div>');
  assert.ok(!out.includes('secret()'));
  assert.ok(!out.includes('nonce'));
  assert.ok(out.split('\n').length > 3);
});

test('compareLandmarkStyles reports only changed properties', () => {
  const changes = compareLandmarkStyles(
    { body: { color: 'red', margin: '0' } },
    { body: { color: 'blue', margin: '0' } }
  );
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changedProps, [{ property: 'color', baseline: 'red', current: 'blue' }]);
});

test('compareDomStats computes deltas', () => {
  const r = compareDomStats({ stats: { linksCount: 2 } }, { stats: { linksCount: 5 } });
  assert.equal(r.find(x => x.metric === 'links count').delta, 3);
});
