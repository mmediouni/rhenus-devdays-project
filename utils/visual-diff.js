/**
 * UI Regression Detector - Visual Diff Engine
 * Performs fast pixel-by-pixel regression comparison, heatmaps, and difference masks.
 */

export async function compareImages(imageSrcA, imageSrcB, options = {}) {
  const {
    threshold = 0.1, // color difference threshold (0 to 1)
    diffColor = [255, 0, 110, 255], // Fluorescent Magenta
    includeBackground = true
  } = options;

  const [imgA, imgB] = await Promise.all([
    loadImage(imageSrcA),
    loadImage(imageSrcB)
  ]);

  const width = Math.max(imgA.naturalWidth || imgA.width, imgB.naturalWidth || imgB.width);
  const height = Math.max(imgA.naturalHeight || imgA.height, imgB.naturalHeight || imgB.height);

  if (width === 0 || height === 0) {
    return {
      diffPercentage: 0,
      diffPixels: 0,
      totalPixels: 0,
      diffDataUrl: null,
      verdict: 'PASS'
    };
  }

  // Canvas A
  const canvasA = document.createElement('canvas');
  canvasA.width = width;
  canvasA.height = height;
  const ctxA = canvasA.getContext('2d', { willReadFrequently: true });
  ctxA.drawImage(imgA, 0, 0);
  const dataA = ctxA.getImageData(0, 0, width, height).data;

  // Canvas B
  const canvasB = document.createElement('canvas');
  canvasB.width = width;
  canvasB.height = height;
  const ctxB = canvasB.getContext('2d', { willReadFrequently: true });
  ctxB.drawImage(imgB, 0, 0);
  const dataB = ctxB.getImageData(0, 0, width, height).data;

  // Output Diff Canvas
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = width;
  diffCanvas.height = height;
  const diffCtx = diffCanvas.getContext('2d');
  const diffImageData = diffCtx.createImageData(width, height);
  const diffData = diffImageData.data;

  const totalPixels = width * height;
  let diffPixels = 0;
  const colorThreshold = threshold * 255;

  let minX = width, minY = height, maxX = 0, maxY = 0;

  for (let i = 0; i < dataA.length; i += 4) {
    const rA = dataA[i];
    const gA = dataA[i + 1];
    const bA = dataA[i + 2];
    const aA = dataA[i + 3];

    const rB = dataB[i];
    const gB = dataB[i + 1];
    const bB = dataB[i + 2];
    const aB = dataB[i + 3];

    // Compute perceptual / Euclidean color delta
    const deltaR = Math.abs(rA - rB);
    const deltaG = Math.abs(gA - gB);
    const deltaB = Math.abs(bA - bB);
    const deltaA = Math.abs(aA - aB);

    const delta = (deltaR * 0.299 + deltaG * 0.587 + deltaB * 0.114) + (deltaA * 0.1);

    if (delta > colorThreshold) {
      diffPixels++;
      
      const pixelIndex = i / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Draw highlighted diff pixel
      diffData[i] = diffColor[0];
      diffData[i + 1] = diffColor[1];
      diffData[i + 2] = diffColor[2];
      diffData[i + 3] = diffColor[3];
    } else {
      if (includeBackground) {
        // Subtle grayscale background for spatial context
        const gray = Math.round((rB * 0.299 + gB * 0.587 + bB * 0.114) * 0.25 + 190 * 0.75);
        diffData[i] = gray;
        diffData[i + 1] = gray;
        diffData[i + 2] = gray;
        diffData[i + 3] = 200; // soft semi-transparent context
      } else {
        diffData[i] = 0;
        diffData[i + 1] = 0;
        diffData[i + 2] = 0;
        diffData[i + 3] = 0;
      }
    }
  }

  diffCtx.putImageData(diffImageData, 0, 0);

  // If there are diffs, optionally draw a sleek bounding box around the affected region
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

  const diffPercentage = (diffPixels / totalPixels) * 100;
  
  let verdict = 'PASS';
  if (diffPercentage > 0 && diffPercentage < 0.2) {
    verdict = 'MINOR_DIFF';
  } else if (diffPercentage >= 0.2) {
    verdict = 'REGRESSION';
  }

  return {
    width,
    height,
    totalPixels,
    diffPixels,
    diffPercentage: Number(diffPercentage.toFixed(2)),
    verdict,
    diffDataUrl: diffCanvas.toDataURL('image/png'),
    bounds: diffPixels > 0 ? { minX, minY, maxX, maxY } : null
  };
}

/**
 * Load an image URL or Base64 into an HTMLImageElement
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      resolve(new Image());
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error('Failed to load image for visual comparison.'));
    img.src = src;
  });
}

