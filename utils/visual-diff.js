/**
 * UI Regression Detector - Visual Diff Engine
 * Pixel-by-pixel regression comparison, heatmaps, ignore regions and difference masks.
 */

/** Single source of truth for verdict thresholds (percent of pixels changed). */
export const REGRESSION_THRESHOLD_PERCENT = 0.2;

export function verdictFor(diffPercentage) {
  if (diffPercentage === 0) return 'PASS';
  return diffPercentage < REGRESSION_THRESHOLD_PERCENT ? 'MINOR_DIFF' : 'REGRESSION';
}

/**
 * @param {string} imageSrcA baseline data URL
 * @param {string} imageSrcB current data URL
 * @param {Object} options
 *   threshold      per-pixel color tolerance, 0..1 (default 0.1)
 *   ignoreRegions  [{x,y,w,h}] in original image pixel coordinates; excluded from the diff
 *   maxPixels      downscale so width*height <= maxPixels (fast quick-compare)
 */
export async function compareImages(imageSrcA, imageSrcB, options = {}) {
  const {
    threshold = 0.1,
    diffColor = [255, 0, 110, 255],
    includeBackground = true,
    ignoreRegions = [],
    maxPixels = Infinity
  } = options;

  const [imgA, imgB] = await Promise.all([loadImage(imageSrcA), loadImage(imageSrcB)]);

  const wA = imgA.naturalWidth || imgA.width;
  const hA = imgA.naturalHeight || imgA.height;
  const wB = imgB.naturalWidth || imgB.width;
  const hB = imgB.naturalHeight || imgB.height;

  const fullWidth = Math.max(wA, wB);
  const fullHeight = Math.max(hA, hB);
  const sizeMismatch = wA !== wB || hA !== hB;

  if (fullWidth === 0 || fullHeight === 0) {
    return {
      width: 0, height: 0, scale: 1,
      diffPercentage: 0, diffPixels: 0, totalPixels: 0,
      diffDataUrl: null, verdict: 'PASS',
      sizeMismatch: false, sizeA: { width: wA, height: hA }, sizeB: { width: wB, height: hB },
      bounds: null
    };
  }

  const scale = Math.min(1, Math.sqrt(maxPixels / (fullWidth * fullHeight)));
  const width = Math.max(1, Math.round(fullWidth * scale));
  const height = Math.max(1, Math.round(fullHeight * scale));

  const dataA = drawToData(imgA, wA, hA, width, height, scale);
  const dataB = drawToData(imgB, wB, hB, width, height, scale);

  // Ignore mask
  const ignored = new Uint8Array(width * height);
  const scaledRegions = [];
  for (const r of ignoreRegions) {
    const x0 = Math.max(0, Math.floor(r.x * scale));
    const y0 = Math.max(0, Math.floor(r.y * scale));
    const x1 = Math.min(width, Math.ceil((r.x + r.w) * scale));
    const y1 = Math.min(height, Math.ceil((r.y + r.h) * scale));
    scaledRegions.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    for (let yy = y0; yy < y1; yy++) {
      ignored.fill(1, yy * width + x0, yy * width + x1);
    }
  }

  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = width;
  diffCanvas.height = height;
  const diffCtx = diffCanvas.getContext('2d');
  const diffImageData = diffCtx.createImageData(width, height);
  const diffData = diffImageData.data;

  let diffPixels = 0;
  let comparedPixels = 0;
  const colorThreshold = threshold * 255;

  let minX = width, minY = height, maxX = 0, maxY = 0;

  for (let i = 0; i < dataA.length; i += 4) {
    const pixelIndex = i / 4;

    if (ignored[pixelIndex]) {
      diffData[i] = 120;
      diffData[i + 1] = 120;
      diffData[i + 2] = 120;
      diffData[i + 3] = 90;
      continue;
    }
    comparedPixels++;

    const delta =
      Math.abs(dataA[i] - dataB[i]) * 0.299 +
      Math.abs(dataA[i + 1] - dataB[i + 1]) * 0.587 +
      Math.abs(dataA[i + 2] - dataB[i + 2]) * 0.114 +
      Math.abs(dataA[i + 3] - dataB[i + 3]) * 0.1;

    if (delta > colorThreshold) {
      diffPixels++;

      const x = pixelIndex % width;
      const y = (pixelIndex / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      diffData[i] = diffColor[0];
      diffData[i + 1] = diffColor[1];
      diffData[i + 2] = diffColor[2];
      diffData[i + 3] = diffColor[3];
    } else if (includeBackground) {
      const gray = Math.round((dataB[i] * 0.299 + dataB[i + 1] * 0.587 + dataB[i + 2] * 0.114) * 0.25 + 190 * 0.75);
      diffData[i] = gray;
      diffData[i + 1] = gray;
      diffData[i + 2] = gray;
      diffData[i + 3] = 200;
    }
  }

  diffCtx.putImageData(diffImageData, 0, 0);

  if (diffPixels > 0 && maxX >= minX && maxY >= minY) {
    diffCtx.strokeStyle = 'rgba(255, 0, 110, 0.7)';
    diffCtx.lineWidth = 2;
    diffCtx.setLineDash([6, 4]);
    diffCtx.strokeRect(
      Math.max(0, minX - 4),
      Math.max(0, minY - 4),
      Math.min(width - minX, maxX - minX + 8),
      Math.min(height - minY, maxY - minY + 8)
    );
  }

  // Outline ignored regions
  diffCtx.setLineDash([3, 3]);
  diffCtx.strokeStyle = 'rgba(6, 182, 212, 0.9)';
  diffCtx.lineWidth = 1;
  for (const r of scaledRegions) diffCtx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);

  const diffPercentage = comparedPixels > 0 ? (diffPixels / comparedPixels) * 100 : 0;
  const rounded = Number(diffPercentage.toFixed(2));

  return {
    width: fullWidth,
    height: fullHeight,
    scale,
    totalPixels: comparedPixels,
    diffPixels,
    diffPercentage: rounded,
    // verdict from the unrounded value so tiny diffs are not reported as PASS
    verdict: verdictFor(diffPixels === 0 ? 0 : Math.max(diffPercentage, 0.0001)),
    sizeMismatch,
    sizeA: { width: wA, height: hA },
    sizeB: { width: wB, height: hB },
    diffDataUrl: diffCanvas.toDataURL('image/png'),
    bounds: diffPixels > 0 ? { minX, minY, maxX, maxY } : null
  };
}

function drawToData(img, srcW, srcH, width, height, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (srcW && srcH) ctx.drawImage(img, 0, 0, Math.round(srcW * scale), Math.round(srcH * scale));
  return ctx.getImageData(0, 0, width, height).data;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      resolve(new Image());
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for visual comparison.'));
    img.src = src;
  });
}
