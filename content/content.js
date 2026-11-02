/**
 * UI Regression Detector - Content Script
 * Extracts comprehensive DOM structure, styles, stylesheets,
 * computed landmark properties, and viewport metrics.
 */

(() => {
  if (window.__UI_REGRESSION_DETECTOR_LOADED__) return;
  window.__UI_REGRESSION_DETECTOR_LOADED__ = true;

  let hiddenFixedElements = [];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EXTRACT_PAGE_SNAPSHOT') {
      try {
        const snapshotData = collectSnapshotData();
        sendResponse({ success: true, data: snapshotData });
      } catch (err) {
        console.error('[UI Regression Detector] Error collecting snapshot:', err);
        sendResponse({ success: false, error: err.message });
      }
      return true; // asynchronous response keep-alive
    }

    if (message.action === 'SCROLL_FOR_FULLPAGE_SLICE') {
      try {
        const { x, y, hideFixed = false } = message.payload || {};

        if (hideFixed && hiddenFixedElements.length === 0) {
          hideStickyAndFixedElements();
        }

        window.scrollTo({ left: x || 0, top: y || 0, behavior: 'instant' });

        // Allow layout/paint to settle
        requestAnimationFrame(() => {
          setTimeout(() => {
            sendResponse({
              success: true,
              actualY: window.scrollY,
              actualX: window.scrollX
            });
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
        window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });

  function hideStickyAndFixedElements() {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        hiddenFixedElements.push({
          el,
          originalVisibility: el.style.visibility
        });
        el.style.visibility = 'hidden';
      }
    }
  }

  function restoreStickyAndFixedElements() {
    for (const item of hiddenFixedElements) {
      if (item.el) {
        item.el.style.visibility = item.originalVisibility || '';
      }
    }
    hiddenFixedElements = [];
  }

  function collectSnapshotData() {
    const title = document.title || 'Untitled Page';
    const url = window.location.href;
    const origin = window.location.origin;
    const pathname = window.location.pathname;

    // Viewport and scroll
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    };

    // Metadata
    const meta = {
      title,
      url,
      origin,
      pathname,
      charset: document.characterSet || 'UTF-8',
      description: getMetaContent('description'),
      favicon: getFavicon()
    };

    // DOM statistics
    const stats = {
      elementsTotal: document.getElementsByTagName('*').length,
      scriptsCount: document.getElementsByTagName('script').length,
      stylesCount: document.getElementsByTagName('style').length + document.querySelectorAll('link[rel="stylesheet"]').length,
      buttonsCount: document.getElementsByTagName('button').length,
      linksCount: document.getElementsByTagName('a').length,
      imagesCount: document.getElementsByTagName('img').length,
      inputsCount: document.getElementsByTagName('input').length
    };

    // Formatted Outer HTML (Cleaned)
    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
    const html = doctype + '\n' + document.documentElement.outerHTML;

    // CSS Collection
    const cssData = collectStylesheetsAndLandmarks();

    return {
      meta,
      viewport,
      dom: {
        html,
        stats
      },
      css: cssData
    };
  }

  function collectStylesheetsAndLandmarks() {
    const inlineStyles = [];
    const styleTags = document.querySelectorAll('style');
    styleTags.forEach((st, idx) => {
      inlineStyles.push({
        id: st.id || `inline-style-${idx + 1}`,
        cssText: st.textContent.trim()
      });
    });

    const externalSheets = [];
    const linkTags = document.querySelectorAll('link[rel="stylesheet"]');
    linkTags.forEach((link, idx) => {
      let rulesText = '';
      try {
        if (link.sheet && link.sheet.cssRules) {
          rulesText = Array.from(link.sheet.cssRules).map(r => r.cssText).join('\n');
        }
      } catch (e) {
        // Cross-origin stylesheet access restriction
        rulesText = `/* Cross-origin stylesheet: ${link.href} */`;
      }
      externalSheets.push({
        href: link.href,
        rulesText
      });
    });

    // Key Landmark Computed Styles
    const landmarkSelectors = [
      'body',
      'header',
      'nav',
      'main',
      'footer',
      'h1',
      'h2',
      'button',
      'a',
      'input',
      '.header',
      '.navbar',
      '#app',
      '#root'
    ];

    const landmarkProperties = [
      'color',
      'background-color',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'display',
      'position',
      'margin',
      'padding',
      'border-width',
      'border-color',
      'border-radius',
      'box-shadow',
      'opacity'
    ];

    const computedLandmarks = {};

    for (const sel of landmarkSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const computed = window.getComputedStyle(el);
        const props = {};
        for (const p of landmarkProperties) {
          props[p] = computed.getPropertyValue(p);
        }
        computedLandmarks[sel] = props;
      }
    }

    return {
      inlineStyles,
      externalSheets,
      computedLandmarks
    };
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

