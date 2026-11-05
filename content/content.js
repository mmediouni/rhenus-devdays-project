/**
 * UI Regression Detector - Content Script
 * Injected on demand (activeTab + scripting) - not auto-loaded on every page.
 * Extracts DOM structure, styles, landmark computed properties and viewport metrics.
 */

(() => {
  if (window.__UI_REGRESSION_DETECTOR_LOADED__) return;
  window.__UI_REGRESSION_DETECTOR_LOADED__ = true;

  const FREEZE_STYLE_ID = '__urd-freeze-style__';
  let hiddenFixedElements = [];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PREPARE_CAPTURE') {
      prepareForCapture()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'EXTRACT_PAGE_SNAPSHOT') {
      try {
        sendResponse({ success: true, data: collectSnapshotData() });
      } catch (err) {
        console.error('[UI Regression Detector] Error collecting snapshot:', err);
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (message.action === 'SCROLL_FOR_FULLPAGE_SLICE') {
      try {
        const { x, y, hideFixed = false } = message.payload || {};

        if (hideFixed && hiddenFixedElements.length === 0) {
          hideStickyAndFixedElements();
        }

        window.scrollTo({ left: x || 0, top: y || 0, behavior: 'instant' });

        requestAnimationFrame(() => {
          setTimeout(() => {
            sendResponse({ success: true, actualY: window.scrollY, actualX: window.scrollX });
          }, 80);
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (message.action === 'RESTORE_AFTER_FULLPAGE') {
      try {
        const { originalScrollX = 0, originalScrollY = 0 } = message.payload || {};
        restoreStickyAndFixedElements();
        const freeze = document.getElementById(FREEZE_STYLE_ID);
        if (freeze) freeze.remove();
        window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });

  /** Freeze animations and wait for fonts / images so captures are repeatable. */
  async function prepareForCapture() {
    if (!document.getElementById(FREEZE_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = FREEZE_STYLE_ID;
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
      (document.head || document.documentElement).appendChild(style);
    }

    const timeout = (ms) => new Promise(r => setTimeout(r, ms));
    const waits = [];
    if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready);
    for (const img of document.images) {
      if (!img.complete) {
        waits.push(new Promise(res => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }));
      }
    }
    await Promise.race([Promise.all(waits), timeout(2500)]);
    await timeout(50);
  }

  function hideStickyAndFixedElements() {
    // Only elements that can be fixed/sticky matter; walk the tree once.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === 1 && node.id !== FREEZE_STYLE_ID) {
        const pos = window.getComputedStyle(node).position;
        if (pos === 'fixed' || pos === 'sticky') {
          hiddenFixedElements.push({ el: node, originalVisibility: node.style.visibility });
          node.style.visibility = 'hidden';
        }
      }
      node = walker.nextNode();
    }
  }

  function restoreStickyAndFixedElements() {
    for (const item of hiddenFixedElements) {
      if (item.el) item.el.style.visibility = item.originalVisibility || '';
    }
    hiddenFixedElements = [];
  }

  function collectSnapshotData() {
    const title = document.title || 'Untitled Page';

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    };

    const meta = {
      title,
      url: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      charset: document.characterSet || 'UTF-8',
      description: getMetaContent('description'),
      favicon: getFavicon()
    };

    const stats = {
      elementsTotal: document.getElementsByTagName('*').length,
      scriptsCount: document.getElementsByTagName('script').length,
      stylesCount: document.getElementsByTagName('style').length + document.querySelectorAll('link[rel="stylesheet"]').length,
      buttonsCount: document.getElementsByTagName('button').length,
      linksCount: document.getElementsByTagName('a').length,
      imagesCount: document.getElementsByTagName('img').length,
      inputsCount: document.getElementsByTagName('input').length
    };

    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
    const html = doctype + '\n' + serializeRedactedHtml();

    return { meta, viewport, dom: { html, stats }, css: collectStylesheetsAndLandmarks() };
  }

  /** Serialize the document with likely secrets (password / hidden values, CSRF tokens) removed. */
  function serializeRedactedHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('input[type="password"], input[type="hidden"]').forEach(el => {
      if (el.hasAttribute('value')) el.setAttribute('value', '[redacted]');
    });
    clone.querySelectorAll('meta[name*="csrf" i], meta[name*="token" i]').forEach(el => {
      el.setAttribute('content', '[redacted]');
    });
    const freeze = clone.querySelector('#' + FREEZE_STYLE_ID);
    if (freeze) freeze.remove();
    return clone.outerHTML;
  }

  function collectStylesheetsAndLandmarks() {
    const inlineStyles = [];
    document.querySelectorAll('style').forEach((st, idx) => {
      if (st.id === FREEZE_STYLE_ID) return;
      inlineStyles.push({
        id: st.id || `inline-style-${idx + 1}`,
        cssText: st.textContent.trim()
      });
    });

    const externalSheets = [];
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      let rulesText = '';
      try {
        if (link.sheet && link.sheet.cssRules) {
          rulesText = Array.from(link.sheet.cssRules).map(r => r.cssText).join('\n');
        }
      } catch (e) {
        rulesText = `/* Cross-origin stylesheet: ${link.href} */`;
      }
      externalSheets.push({ href: link.href, rulesText });
    });

    const landmarkSelectors = [
      'body', 'header', 'nav', 'main', 'footer', 'aside', 'section', 'article',
      'h1', 'h2', 'h3', 'p', 'label',
      'button', 'a', 'input', 'select', 'textarea', 'img', 'table',
      '[role="button"]', '[role="dialog"]',
      '.header', '.navbar', '#app', '#root'
    ];

    const landmarkProperties = [
      'color', 'background-color', 'font-family', 'font-size', 'font-weight',
      'line-height', 'letter-spacing', 'display', 'position', 'margin', 'padding',
      'border-width', 'border-color', 'border-radius', 'box-shadow', 'opacity',
      'width', 'height'
    ];

    const computedLandmarks = {};
    const capture = (key, el) => {
      const computed = window.getComputedStyle(el);
      const props = {};
      for (const p of landmarkProperties) props[p] = computed.getPropertyValue(p);
      computedLandmarks[key] = props;
    };

    for (const sel of landmarkSelectors) {
      const el = document.querySelector(sel);
      if (el) capture(sel, el);
    }

    // Stable, author-provided hooks: matched across snapshots by test id
    const testIds = document.querySelectorAll('[data-testid]');
    for (let i = 0; i < testIds.length && i < 60; i++) {
      const id = testIds[i].getAttribute('data-testid');
      const key = `[data-testid="${id}"]`;
      if (!(key in computedLandmarks)) capture(key, testIds[i]);
    }

    return { inlineStyles, externalSheets, computedLandmarks };
  }

  function getMetaContent(name) {
    const tag = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return tag ? tag.getAttribute('content') : '';
  }

  function getFavicon() {
    const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    return link ? link.href : '';
  }
})();
