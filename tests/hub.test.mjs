import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHubUrl, sanitizeHubSettings, isHubConfigured, labelFor, buildUploadBody
} from '../utils/hub.js';

test('normalizeHubUrl accepts http(s) only and strips query, hash and trailing slash', () => {
  assert.equal(normalizeHubUrl('https://hub.example.com/'), 'https://hub.example.com');
  assert.equal(normalizeHubUrl('  http://localhost:8787  '), 'http://localhost:8787');
  assert.equal(normalizeHubUrl('https://x.test/api/?a=1#b'), 'https://x.test/api');
  assert.equal(normalizeHubUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHubUrl('ftp://x.test'), '');
  assert.equal(normalizeHubUrl('not a url'), '');
  assert.equal(normalizeHubUrl(null), '');
});

test('sanitizeHubSettings fills defaults and rejects bad values', () => {
  const s = sanitizeHubSettings({ enabled: 'yes', url: 'file:///x', apiKey: '  urd_abc  ', labelMode: 'weird' });
  assert.equal(s.enabled, false);
  assert.equal(s.url, '');
  assert.equal(s.apiKey, 'urd_abc');
  assert.equal(s.labelMode, 'domain');
  assert.equal(s.label, 'extension');
  assert.deepEqual(sanitizeHubSettings(null).enabled, false);
});

test('isHubConfigured needs enabled flag, url and key', () => {
  assert.equal(isHubConfigured({ enabled: true, url: 'https://h', apiKey: 'k' }), true);
  assert.equal(isHubConfigured({ enabled: false, url: 'https://h', apiKey: 'k' }), false);
  assert.equal(isHubConfigured({ enabled: true, url: '', apiKey: 'k' }), false);
  assert.equal(isHubConfigured({ enabled: true, url: 'https://h', apiKey: '' }), false);
});

test('labelFor uses the domain or the fixed text', () => {
  const snap = { domain: 'app.test' };
  assert.equal(labelFor(snap, { labelMode: 'domain', label: 'staging' }), 'app.test');
  assert.equal(labelFor(snap, { labelMode: 'custom', label: 'staging' }), 'staging');
  assert.equal(labelFor({}, { labelMode: 'domain', label: 'x' }), 'default');
});

test('buildUploadBody prefers the full-page image and carries metadata', () => {
  const snap = {
    id: 'snap_1',
    url: 'https://app.test/cart?x=1',
    domain: 'app.test',
    title: 'Cart',
    label: 'after fix',
    timestamp: 123,
    screenshot: 'data:image/png;base64,AAA',
    fullScreenshot: 'data:image/png;base64,BBB',
    viewport: { width: 1280, height: 720 }
  };
  const body = buildUploadBody(snap, { labelMode: 'domain', label: 'ignored' });
  assert.equal(body.image, 'data:image/png;base64,BBB');
  assert.equal(body.url, snap.url);
  assert.equal(body.label, 'app.test');
  assert.equal(body.source, 'extension');
  assert.deepEqual(body.viewport, { width: 1280, height: 720 });
  assert.equal(body.meta.extensionSnapshotId, 'snap_1');
  assert.equal(body.meta.fullPage, true);

  const viewportOnly = buildUploadBody({ ...snap, fullScreenshot: snap.screenshot }, { labelMode: 'domain' });
  assert.equal(viewportOnly.image, snap.screenshot);
  assert.equal(viewportOnly.meta.fullPage, false);
});
