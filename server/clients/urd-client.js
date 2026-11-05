// Tiny dependency-free client for the hub. Works from Playwright, Cypress tasks,
// CI scripts or any Node >= 18 code.
//
//   import { createClient } from './urd-client.js';
//   const urd = createClient({ baseUrl: process.env.URD_URL, apiKey: process.env.URD_KEY, label: 'main' });
//
//   // Playwright
//   const result = await urd.snapshotPage(page, 'checkout-step-2');
//   expect(result.verdict).not.toBe('REGRESSION');

export function createClient({ baseUrl, apiKey, label = 'default', source = 'playwright', failOn = 'REGRESSION' }) {
  if (!baseUrl || !apiKey) throw new Error('urd-client: baseUrl and apiKey are required');
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    const res = await fetch(root + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`urd ${method} ${path} -> ${res.status}: ${data.error || 'request failed'}`);
    return data;
  }

  return {
    /** Send a PNG buffer (or base64 / data URL string). */
    async snapshot({ step, url, image, meta, viewport, label: l }) {
      const b64 = Buffer.isBuffer(image) ? image.toString('base64') : image;
      return request('POST', '/v1/snapshots', {
        step,
        url,
        image: b64,
        meta,
        viewport,
        label: l || label,
        source
      });
    },

    /** Playwright: screenshot the page and send it. Throws when the verdict matches failOn. */
    async snapshotPage(page, step, { fullPage = true, throwOnFail = true } = {}) {
      const image = await page.screenshot({ fullPage, type: 'png' });
      const result = await this.snapshot({
        step,
        url: page.url(),
        image,
        viewport: page.viewportSize() || undefined
      });
      if (throwOnFail && failOn && result.verdict === failOn) {
        const pct = result.vsBaseline?.diffPercentage ?? result.vsPrevious?.diffPercentage;
        throw new Error(`UI regression on "${step}": ${pct}% of pixels changed (snapshot ${result.id})`);
      }
      return result;
    },

    timeline: (pageKey, l) =>
      request('GET', `/v1/timeline?pageKey=${encodeURIComponent(pageKey)}${l ? `&label=${encodeURIComponent(l)}` : ''}`),
    approve: (snapshotId) => request('POST', '/v1/baselines', { snapshotId })
  };
}
