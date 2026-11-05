import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, normalizeUrl, safeImageSrc, safeHttpUrl } from '../utils/common.js';

test('escapeHtml escapes quotes and angle brackets', () => {
  assert.equal(escapeHtml('<a href="x" onclick=\'y\'>&'), '&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
});

test('normalizeUrl drops hash and trailing slash but keeps query', () => {
  assert.equal(normalizeUrl('https://a.com/p/#top'), 'https://a.com/p');
  assert.equal(normalizeUrl('https://a.com/p?id=1'), 'https://a.com/p?id=1');
  assert.notEqual(normalizeUrl('https://a.com/p?id=1'), normalizeUrl('https://a.com/p?id=2'));
});

test('safeImageSrc only allows raster data URLs', () => {
  assert.equal(safeImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeImageSrc('data:image/svg+xml;base64,AAAA'), '');
  assert.equal(safeImageSrc('" onerror="x'), '');
  assert.equal(safeImageSrc('https://evil.com/x.png'), '');
});

test('safeHttpUrl rejects javascript: and data: URLs', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '#');
  assert.equal(safeHttpUrl('data:text/html,hi'), '#');
  assert.equal(safeHttpUrl('https://a.com/x'), 'https://a.com/x');
});
