import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** Accepts a data URL or raw base64 and returns a Buffer. */
export function decodeImageInput(input) {
  if (typeof input !== 'string' || !input) throw new Error('image is required');
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(input);
  const b64 = m ? m[2] : input;
  return Buffer.from(b64, 'base64');
}

export function readSize(buf) {
  // PNG IHDR: width and height are big-endian at offsets 16 and 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function verdictFor(percent, regressionPercent = 0.2) {
  if (percent === 0) return 'PASS';
  if (percent < regressionPercent) return 'MINOR_DIFF';
  return 'REGRESSION';
}

function pad(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  // Opaque magenta padding so extra area always counts as different.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/**
 * Compare two PNG buffers.
 * Returns the numeric result plus (optionally) the diff image as a PNG buffer.
 */
export function comparePng(bufA, bufB, { threshold = 0.1, regressionPercent = 0.2, withImage = false } = {}) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;

  const pa = pad(a, width, height);
  const pb = pad(b, width, height);
  const diff = withImage ? new PNG({ width, height }) : null;

  const diffPixels = pixelmatch(pa.data, pb.data, diff ? diff.data : null, width, height, {
    threshold,
    includeAA: false
  });
  const totalPixels = width * height;
  const diffPercentage = totalPixels ? (diffPixels / totalPixels) * 100 : 0;

  return {
    width,
    height,
    sizeMismatch,
    sizeA: { width: a.width, height: a.height },
    sizeB: { width: b.width, height: b.height },
    diffPixels,
    totalPixels,
    diffPercentage: Number(diffPercentage.toFixed(4)),
    verdict: verdictFor(diffPercentage, regressionPercent),
    image: diff ? PNG.sync.write(diff) : null
  };
}
