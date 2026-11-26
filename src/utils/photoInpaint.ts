export const MAX_PHOTO_SIZE_MB = 25;
export const MAX_PHOTO_SIZE_BYTES = MAX_PHOTO_SIZE_MB * 1024 * 1024;
export const SUPPORTED_PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const SUPPORTED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface PhotoValidationResult {
  valid: boolean;
  error?: string;
}

export function getPhotoExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : '';
}

export function validatePhotoFile(file: {
  name: string;
  size: number;
  type?: string;
}): PhotoValidationResult {
  if (!file.name || file.size <= 0) {
    return { valid: false, error: 'Please select a non-empty photo file.' };
  }
  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    return {
      valid: false,
      error: `Photo exceeds the ${MAX_PHOTO_SIZE_MB} MB limit. Please choose a smaller image.`,
    };
  }
  const ext = getPhotoExtension(file.name);
  const extOk = (SUPPORTED_PHOTO_EXTENSIONS as readonly string[]).includes(ext);
  const mimeOk = Boolean(
    file.type && (SUPPORTED_PHOTO_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())
  );
  if (!extOk && !mimeOk) {
    return {
      valid: false,
      error: 'Unsupported image format. Please upload a JPG, PNG, or WebP photo.',
    };
  }
  return { valid: true };
}

export function formatPhotoBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Fast Marching Method (Telea 2004) Inpainting (fast fallback & coarsest-level seed)
const KNOWN = 0;
const BAND = 1;
const INSIDE = 2;
const INF_DIST = 1e6;

class MinHeap {
  private indices: Int32Array;
  private dists: Float32Array;
  public length = 0;

  constructor(capacity: number) {
    this.indices = new Int32Array(Math.max(16, capacity));
    this.dists = new Float32Array(Math.max(16, capacity));
  }

  push(idx: number, dist: number): void {
    if (this.length >= this.indices.length) {
      const nextCap = this.indices.length * 2;
      const nextIdx = new Int32Array(nextCap);
      const nextDist = new Float32Array(nextCap);
      nextIdx.set(this.indices);
      nextDist.set(this.dists);
      this.indices = nextIdx;
      this.dists = nextDist;
    }
    let pos = this.length++;
    this.indices[pos] = idx;
    this.dists[pos] = dist;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (this.dists[parent] <= dist) break;
      this.indices[pos] = this.indices[parent];
      this.dists[pos] = this.dists[parent];
      pos = parent;
    }
    this.indices[pos] = idx;
    this.dists[pos] = dist;
  }

  pop(): number {
    const top = this.indices[0];
    this.length--;
    if (this.length > 0) {
      const idx = this.indices[this.length];
      const dist = this.dists[this.length];
      let pos = 0;
      const half = this.length >> 1;
      while (pos < half) {
        let child = (pos << 1) + 1;
        const right = child + 1;
        if (right < this.length && this.dists[right] < this.dists[child]) {
          child = right;
        }
        if (dist <= this.dists[child]) break;
        this.indices[pos] = this.indices[child];
        this.dists[pos] = this.dists[child];
        pos = child;
      }
      this.indices[pos] = idx;
      this.dists[pos] = dist;
    }
    return top;
  }
}

function solveEikonal(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number,
  h: number,
  flags: Uint8Array,
  dist: Float32Array
): number {
  const valid1 = x1 >= 0 && x1 < w && y1 >= 0 && y1 < h && flags[y1 * w + x1] === KNOWN;
  const valid2 = x2 >= 0 && x2 < w && y2 >= 0 && y2 < h && flags[y2 * w + x2] === KNOWN;
  if (!valid1 && !valid2) return INF_DIST;
  const d1 = valid1 ? dist[y1 * w + x1] : INF_DIST;
  const d2 = valid2 ? dist[y2 * w + x2] : INF_DIST;
  if (valid1 && valid2) {
    const d = Math.abs(d1 - d2);
    if (d >= 1) {
      return Math.min(d1, d2) + 1;
    }
    return 0.5 * (d1 + d2 + Math.sqrt(Math.max(0, 2 - d * d)));
  }
  return Math.min(d1, d2) + 1;
}

export function dilateBinaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
  iterations = 1
): Uint8Array {
  let current = new Uint8Array(mask);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Uint8Array(current);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (current[row + x]) continue;
        if (
          (x > 0 && current[row + x - 1]) ||
          (x + 1 < width && current[row + x + 1]) ||
          (y > 0 && current[row - width + x]) ||
          (y + 1 < height && current[row + width + x])
        ) {
          next[row + x] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

export function teleaInpaintRgba(
  srcRgba: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  radius = 5
): Uint8ClampedArray {
  const total = width * height;
  const out = new Uint8ClampedArray(srcRgba);
  if (total === 0 || srcRgba.length < total * 4 || mask.length < total) {
    return out;
  }

  let hasMasked = false;
  for (let i = 0; i < total; i++) {
    if (mask[i] > 0) {
      hasMasked = true;
      break;
    }
  }
  if (!hasMasked) return out;

  const r = Math.max(2, Math.min(12, Math.round(radius)));
  const rSq = r * r;
  const flags = new Uint8Array(total);
  const dist = new Float32Array(total);

  for (let i = 0; i < total; i++) {
    if (mask[i] > 0) {
      flags[i] = INSIDE;
      dist[i] = INF_DIST;
    } else {
      flags[i] = KNOWN;
      dist[i] = 0;
    }
  }

  const heap = new MinHeap(Math.min(total, 16384));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (flags[idx] !== INSIDE) continue;
      const hasKnownNeighbor =
        (x > 0 && flags[idx - 1] === KNOWN) ||
        (x + 1 < width && flags[idx + 1] === KNOWN) ||
        (y > 0 && flags[idx - width] === KNOWN) ||
        (y + 1 < height && flags[idx + width] === KNOWN);
      if (hasKnownNeighbor) {
        flags[idx] = BAND;
        dist[idx] = 1;
        heap.push(idx, 1);
      }
    }
  }

  if (heap.length === 0) {
    return out;
  }

  const dxNeighbors = [-1, 1, 0, 0];
  const dyNeighbors = [0, 0, -1, 1];

  while (heap.length > 0) {
    const idx = heap.pop();
    if (flags[idx] === KNOWN) continue;

    const x = idx % width;
    const y = (idx - x) / width;

    const dLeft = x > 0 && flags[idx - 1] !== INSIDE ? dist[idx - 1] : dist[idx];
    const dRight = x + 1 < width && flags[idx + 1] !== INSIDE ? dist[idx + 1] : dist[idx];
    const dUp = y > 0 && flags[idx - width] !== INSIDE ? dist[idx - width] : dist[idx];
    const dDown = y + 1 < height && flags[idx + width] !== INSIDE ? dist[idx + width] : dist[idx];
    const gradX = 0.5 * (dRight - dLeft);
    const gradY = 0.5 * (dDown - dUp);

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    let sumGradRx = 0;
    let sumGradRy = 0;
    let sumGradGx = 0;
    let sumGradGy = 0;
    let sumGradBx = 0;
    let sumGradBy = 0;
    let weightSum = 0;

    const xStart = Math.max(0, x - r);
    const xEnd = Math.min(width - 1, x + r);
    const yStart = Math.max(0, y - r);
    const yEnd = Math.min(height - 1, y + r);

    for (let ny = yStart; ny <= yEnd; ny++) {
      const dy = y - ny;
      const nyRow = ny * width;
      for (let nx = xStart; nx <= xEnd; nx++) {
        const dx = x - nx;
        const dSq = dx * dx + dy * dy;
        if (dSq === 0 || dSq > rSq) continue;
        const nIdx = nyRow + nx;
        if (flags[nIdx] !== KNOWN) continue;

        const length = Math.sqrt(dSq);
        const dir = Math.abs((dx * gradX + dy * gradY) / length);
        const dirWeight = dir > 1e-4 ? dir : 1e-4;
        const dstWeight = 1 / (dSq * length);
        const levWeight = 1 / (1 + Math.abs(dist[nIdx] - dist[idx]));
        const w = dirWeight * dstWeight * levWeight;

        const rgbaOffset = nIdx * 4;
        sumR += w * out[rgbaOffset];
        sumG += w * out[rgbaOffset + 1];
        sumB += w * out[rgbaOffset + 2];
        sumA += w * out[rgbaOffset + 3];
        weightSum += w;

        if (nx > 0 && nx + 1 < width && flags[nIdx - 1] === KNOWN && flags[nIdx + 1] === KNOWN) {
          const lOff = (nIdx - 1) * 4;
          const rOff = (nIdx + 1) * 4;
          sumGradRx += w * 0.5 * (out[rOff] - out[lOff]) * dx;
          sumGradGx += w * 0.5 * (out[rOff + 1] - out[lOff + 1]) * dx;
          sumGradBx += w * 0.5 * (out[rOff + 2] - out[lOff + 2]) * dx;
        }
        if (ny > 0 && ny + 1 < height && flags[nIdx - width] === KNOWN && flags[nIdx + width] === KNOWN) {
          const uOff = (nIdx - width) * 4;
          const bOff = (nIdx + width) * 4;
          sumGradRy += w * 0.5 * (out[bOff] - out[uOff]) * dy;
          sumGradGy += w * 0.5 * (out[bOff + 1] - out[uOff + 1]) * dy;
          sumGradBy += w * 0.5 * (out[bOff + 2] - out[uOff + 2]) * dy;
        }
      }
    }

    if (weightSum > 0) {
      const outOffset = idx * 4;
      const invW = 1 / weightSum;
      const rVal = sumR * invW + Math.max(-24, Math.min(24, (sumGradRx + sumGradRy) * invW * 0.5));
      const gVal = sumG * invW + Math.max(-24, Math.min(24, (sumGradGx + sumGradGy) * invW * 0.5));
      const bVal = sumB * invW + Math.max(-24, Math.min(24, (sumGradBx + sumGradBy) * invW * 0.5));
      out[outOffset] = Math.max(0, Math.min(255, Math.round(rVal)));
      out[outOffset + 1] = Math.max(0, Math.min(255, Math.round(gVal)));
      out[outOffset + 2] = Math.max(0, Math.min(255, Math.round(bVal)));
      out[outOffset + 3] = Math.max(0, Math.min(255, Math.round(sumA * invW)));
    }

    flags[idx] = KNOWN;

    for (let k = 0; k < 4; k++) {
      const nx = x + dxNeighbors[k];
      const ny = y + dyNeighbors[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (flags[nIdx] !== KNOWN) {
        const d1 = solveEikonal(nx - 1, ny, nx, ny - 1, width, height, flags, dist);
        const d2 = solveEikonal(nx + 1, ny, nx, ny - 1, width, height, flags, dist);
        const d3 = solveEikonal(nx - 1, ny, nx, ny + 1, width, height, flags, dist);
        const d4 = solveEikonal(nx + 1, ny, nx, ny + 1, width, height, flags, dist);
        const nextDist = Math.min(d1, d2, d3, d4);
        if (nextDist < dist[nIdx]) {
          dist[nIdx] = nextDist;
          flags[nIdx] = BAND;
          heap.push(nIdx, nextDist);
        }
      }
    }
  }

  return out;
}

export interface MaskBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
  maskCount: number;
}

export function computeMaskBoundingBox(
  mask: Uint8Array,
  width: number,
  height: number,
  padding = 0
): MaskBoundingBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let maskCount = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] > 0) {
        maskCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maskCount === 0 || maxX < minX || maxY < minY) {
    return null;
  }

  const pad = Math.max(0, Math.round(padding));
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(width - 1, maxX + pad);
  const y1 = Math.min(height - 1, maxY + pad);

  return {
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    maskCount,
  };
}

export function extractRgbaRegion(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  box: MaskBoundingBox
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let ry = 0; ry < box.height; ry++) {
    const srcStart = ((box.y0 + ry) * srcW + box.x0) * 4;
    const dstStart = ry * box.width * 4;
    out.set(srcRgba.subarray(srcStart, srcStart + box.width * 4), dstStart);
  }
  return out;
}

export function extractMaskRegion(
  mask: Uint8Array,
  srcW: number,
  box: MaskBoundingBox
): Uint8Array {
  const out = new Uint8Array(box.width * box.height);
  for (let ry = 0; ry < box.height; ry++) {
    const srcStart = (box.y0 + ry) * srcW + box.x0;
    const dstStart = ry * box.width;
    out.set(mask.subarray(srcStart, srcStart + box.width), dstStart);
  }
  return out;
}

/**
 * Computes inward distance-based feather alpha in [0, 1] for blending a filled ROI back
 * into the original image. Pixels outside the mask (`mask === 0`) strictly get alpha 0.
 */
export function computeFeatheredMaskAlpha(
  mask: Uint8Array,
  width: number,
  height: number,
  featherPx = 4
): Float32Array {
  const total = width * height;
  const alpha = new Float32Array(total);
  const fPx = Math.max(1, Math.min(8, featherPx));
  const dist = new Float32Array(total);
  const INF = 1e6;

  for (let i = 0; i < total; i++) {
    dist[i] = mask[i] > 0 ? INF : 0;
  }

  // Two-pass chamfer distance transform (3-4 approximate Euclidean)
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      let d = dist[idx];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[idx - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[idx - width] + 1);
        if (x > 0) d = Math.min(d, dist[idx - width - 1] + 1.4142);
        if (x + 1 < width) d = Math.min(d, dist[idx - width + 1] + 1.4142);
      }
      dist[idx] = d;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const idx = row + x;
      let d = dist[idx];
      if (d === 0) continue;
      if (x + 1 < width) d = Math.min(d, dist[idx + 1] + 1);
      if (y + 1 < height) {
        d = Math.min(d, dist[idx + width] + 1);
        if (x > 0) d = Math.min(d, dist[idx + width - 1] + 1.4142);
        if (x + 1 < width) d = Math.min(d, dist[idx + width + 1] + 1.4142);
      }
      dist[idx] = d;
      const t = Math.max(0, Math.min(1, d / fPx));
      // Smoothstep for natural feather falloff
      alpha[idx] = t * t * (3 - 2 * t);
    }
  }

  return alpha;
}

/**
 * Estimates high-frequency grain/noise in the unmasked ring around the mask
 * and injects matching micro-grain into filled pixels so textured areas never look overly smooth.
 */
export function applyMatchedSurroundingGrain(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  seed = 1337
): Uint8ClampedArray {
  const total = width * height;
  const out = new Uint8ClampedArray(rgba);
  if (total < 16) return out;

  // Estimate high-frequency residual in unmasked pixels near the mask (up to 18px away)
  const searchDilated = dilateBinaryMask(mask, width, height, 14);
  let ringSumSqLuma = 0;
  let ringCount = 0;
  let fillSumSqLuma = 0;
  let fillCount = 0;

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      const isRing = mask[idx] === 0 && searchDilated[idx] > 0;
      const isFill = mask[idx] > 0;
      if (!isRing && !isFill) continue;

      if (isRing) {
        if (
          mask[idx - 1] > 0 ||
          mask[idx + 1] > 0 ||
          mask[idx - width] > 0 ||
          mask[idx + width] > 0
        ) {
          continue;
        }
      } else {
        if (
          mask[idx - 1] === 0 ||
          mask[idx + 1] === 0 ||
          mask[idx - width] === 0 ||
          mask[idx + width] === 0
        ) {
          continue;
        }
      }

      const off = idx * 4;
      const lumaCenter = 0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2];

      let avgLuma = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const nRow = (y + dy) * width;
        for (let dx = -1; dx <= 1; dx++) {
          const nOff = (nRow + x + dx) * 4;
          avgLuma += 0.299 * rgba[nOff] + 0.587 * rgba[nOff + 1] + 0.114 * rgba[nOff + 2];
        }
      }
      avgLuma /= 9;
      const hp = lumaCenter - avgLuma;
      if (isRing) {
        ringSumSqLuma += hp * hp;
        ringCount++;
      } else {
        fillSumSqLuma += hp * hp;
        fillCount++;
      }
    }
  }

  if (ringCount < 16) return out;
  const ringStd = Math.sqrt(ringSumSqLuma / ringCount);
  const fillStd = fillCount > 8 ? Math.sqrt(fillSumSqLuma / fillCount) : 0;

  // Only inject grain if surrounding area actually has perceptible grain/texture (> 1.1)
  // and filled region has lower high-frequency energy than the surrounding ring.
  const missingVar = Math.max(0, ringStd * ringStd - fillStd * fillStd * 0.85);
  const addSigma = Math.min(18, Math.sqrt(missingVar));
  if (addSigma < 0.9) return out;

  // Deterministic PRNG (Mulberry32) so tests and repeated runs are reproducible
  let s = seed >>> 0;
  const nextRand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < total; i++) {
    if (mask[i] === 0) continue;
    // Approximate Gaussian via sum of 3 uniforms centered at 0, variance ~ 0.25 -> scale by 2
    const u1 = nextRand() + nextRand() + nextRand() - 1.5;
    const lumaNoise = u1 * 2 * addSigma;
    const chromaR = (nextRand() - 0.5) * addSigma * 0.45;
    const chromaB = (nextRand() - 0.5) * addSigma * 0.45;

    const off = i * 4;
    out[off] = Math.max(0, Math.min(255, Math.round(out[off] + lumaNoise + chromaR)));
    out[off + 1] = Math.max(0, Math.min(255, Math.round(out[off + 1] + lumaNoise)));
    out[off + 2] = Math.max(0, Math.min(255, Math.round(out[off + 2] + lumaNoise + chromaB)));
  }

  return out;
}

export function compositeFeatheredRegion(
  baseRgba: Uint8ClampedArray,
  filledRegionRgba: Uint8ClampedArray,
  regionMask: Uint8Array,
  baseW: number,
  box: MaskBoundingBox,
  featherPx = 4
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(baseRgba);
  const alpha = computeFeatheredMaskAlpha(regionMask, box.width, box.height, featherPx);

  for (let ry = 0; ry < box.height; ry++) {
    const rRow = ry * box.width;
    const bRow = (box.y0 + ry) * baseW + box.x0;
    for (let rx = 0; rx < box.width; rx++) {
      const rIdx = rRow + rx;
      if (regionMask[rIdx] === 0) continue; // Exact pixel preservation outside mask
      const a = alpha[rIdx];
      if (a <= 0) continue;
      const bOff = (bRow + rx) * 4;
      const rOff = rIdx * 4;
      if (a >= 0.999) {
        out[bOff] = filledRegionRgba[rOff];
        out[bOff + 1] = filledRegionRgba[rOff + 1];
        out[bOff + 2] = filledRegionRgba[rOff + 2];
        out[bOff + 3] = filledRegionRgba[rOff + 3];
      } else {
        const inv = 1 - a;
        out[bOff] = Math.round(baseRgba[bOff] * inv + filledRegionRgba[rOff] * a);
        out[bOff + 1] = Math.round(baseRgba[bOff + 1] * inv + filledRegionRgba[rOff + 1] * a);
        out[bOff + 2] = Math.round(baseRgba[bOff + 2] * inv + filledRegionRgba[rOff + 2] * a);
        out[bOff + 3] = Math.round(baseRgba[bOff + 3] * inv + filledRegionRgba[rOff + 3] * a);
      }
    }
  }
  return out;
}

// Multi-scale Exemplar / PatchMatch-style Texture Inpainting
interface PyramidLevel {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  mask: Uint8Array;
}

function downsampleHalf(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): PyramidLevel {
  const dw = Math.max(1, Math.floor(w / 2));
  const dh = Math.max(1, Math.floor(h / 2));
  const dRgba = new Uint8ClampedArray(dw * dh * 4);
  const dMask = new Uint8Array(dw * dh);

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.min(h - 1, dy * 2);
    const sy1 = Math.min(h - 1, sy0 + 1);
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.min(w - 1, dx * 2);
      const sx1 = Math.min(w - 1, sx0 + 1);

      const i00 = sy0 * w + sx0;
      const i10 = sy0 * w + sx1;
      const i01 = sy1 * w + sx0;
      const i11 = sy1 * w + sx1;

      const mSum = (mask[i00] > 0 ? 1 : 0) + (mask[i10] > 0 ? 1 : 0) + (mask[i01] > 0 ? 1 : 0) + (mask[i11] > 0 ? 1 : 0);
      const dIdx = dy * dw + dx;
      const dOff = dIdx * 4;

      if (mSum > 0 && mSum < 4) {
        // Average only known samples when straddling boundary so watermark colors don't bleed into coarse levels
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let k = 0;
        for (const idx of [i00, i10, i01, i11]) {
          if (mask[idx] === 0) {
            const off = idx * 4;
            r += rgba[off];
            g += rgba[off + 1];
            b += rgba[off + 2];
            a += rgba[off + 3];
            k++;
          }
        }
        dRgba[dOff] = Math.round(r / k);
        dRgba[dOff + 1] = Math.round(g / k);
        dRgba[dOff + 2] = Math.round(b / k);
        dRgba[dOff + 3] = Math.round(a / k);
        dMask[dIdx] = mSum >= 2 ? 1 : 0;
      } else {
        const o00 = i00 * 4;
        const o10 = i10 * 4;
        const o01 = i01 * 4;
        const o11 = i11 * 4;
        dRgba[dOff] = (rgba[o00] + rgba[o10] + rgba[o01] + rgba[o11] + 2) >> 2;
        dRgba[dOff + 1] = (rgba[o00 + 1] + rgba[o10 + 1] + rgba[o01 + 1] + rgba[o11 + 1] + 2) >> 2;
        dRgba[dOff + 2] = (rgba[o00 + 2] + rgba[o10 + 2] + rgba[o01 + 2] + rgba[o11 + 2] + 2) >> 2;
        dRgba[dOff + 3] = (rgba[o00 + 3] + rgba[o10 + 3] + rgba[o01 + 3] + rgba[o11 + 3] + 2) >> 2;
        dMask[dIdx] = mSum >= 2 ? 1 : 0;
      }
    }
  }

  return { width: dw, height: dh, rgba: dRgba, mask: dMask };
}

function upsampleMaskedPixelsFromCoarse(
  coarseRgba: Uint8ClampedArray,
  coarseW: number,
  coarseH: number,
  fineRgba: Uint8ClampedArray,
  fineMask: Uint8Array,
  fineW: number,
  fineH: number
): void {
  const scaleX = coarseW / fineW;
  const scaleY = coarseH / fineH;
  for (let fy = 0; fy < fineH; fy++) {
    const cy = Math.max(0, Math.min(coarseH - 1, (fy + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(cy);
    const y1 = Math.min(coarseH - 1, y0 + 1);
    const ty = cy - y0;
    const row = fy * fineW;

    for (let fx = 0; fx < fineW; fx++) {
      const idx = row + fx;
      if (fineMask[idx] === 0) continue;

      const cx = Math.max(0, Math.min(coarseW - 1, (fx + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(cx);
      const x1 = Math.min(coarseW - 1, x0 + 1);
      const tx = cx - x0;

      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      const o00 = (y0 * coarseW + x0) * 4;
      const o10 = (y0 * coarseW + x1) * 4;
      const o01 = (y1 * coarseW + x0) * 4;
      const o11 = (y1 * coarseW + x1) * 4;

      const fOff = idx * 4;
      fineRgba[fOff] = Math.round(
        coarseRgba[o00] * w00 + coarseRgba[o10] * w10 + coarseRgba[o01] * w01 + coarseRgba[o11] * w11
      );
      fineRgba[fOff + 1] = Math.round(
        coarseRgba[o00 + 1] * w00 + coarseRgba[o10 + 1] * w10 + coarseRgba[o01 + 1] * w01 + coarseRgba[o11 + 1] * w11
      );
      fineRgba[fOff + 2] = Math.round(
        coarseRgba[o00 + 2] * w00 + coarseRgba[o10 + 2] * w10 + coarseRgba[o01 + 2] * w01 + coarseRgba[o11 + 2] * w11
      );
      fineRgba[fOff + 3] = Math.round(
        coarseRgba[o00 + 3] * w00 + coarseRgba[o10 + 3] * w10 + coarseRgba[o01 + 3] * w01 + coarseRgba[o11 + 3] * w11
      );
    }
  }
}

function runPatchMatchAtLevel(
  rgba: Uint8ClampedArray,
  origMask: Uint8Array,
  w: number,
  h: number,
  patchRad: number,
  iterations: number,
  seedBase: number
): void {
  const total = w * h;
  if (w < patchRad * 2 + 3 || h < patchRad * 2 + 3) return;

  // Build valid source patch table (a source patch is valid only if NONE of its pixels are masked)
  const validSource = new Uint8Array(total);
  const validSourcesList: number[] = [];
  const minX = patchRad;
  const maxX = w - 1 - patchRad;
  const minY = patchRad;
  const maxY = h - 1 - patchRad;

  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      let ok = true;
      for (let py = -patchRad; py <= patchRad && ok; py++) {
        const pRow = (y + py) * w;
        for (let px = -patchRad; px <= patchRad; px++) {
          if (origMask[pRow + x + px] > 0) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const idx = row + x;
        validSource[idx] = 1;
        validSourcesList.push(idx);
      }
    }
  }

  if (validSourcesList.length === 0) {
    return;
  }

  // Build target mask dilated by patchRad so boundary patches also contribute smoothly to masked pixels
  const targetMask = dilateBinaryMask(origMask, w, h, Math.max(1, patchRad - 1));
  const targetCoords: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const idx = row + x;
      if (origMask[idx] > 0 || targetMask[idx] > 0) {
        targetCoords.push(idx);
      }
    }
  }
  if (targetCoords.length === 0) return;

  // Nearest-neighbor field for all pixels inside [0..total-1]
  const nnX = new Int16Array(total);
  const nnY = new Int16Array(total);
  const nnErr = new Float32Array(total);
  nnX.fill(-1);
  nnErr.fill(1e12);

  // For unmasked non-target pixels, identity map
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * w + x;
      if (origMask[idx] === 0 && targetMask[idx] === 0 && validSource[idx]) {
        nnX[idx] = x;
        nnY[idx] = y;
        nnErr[idx] = 0;
      }
    }
  }

  let s = seedBase >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Compute patch SSD between target center (tx, ty) and valid source center (sx, sy)
  const patchSsd = (tx: number, ty: number, sx: number, sy: number, knownWeightBoost: number): number => {
    let err = 0;
    let wSum = 0;
    for (let py = -patchRad; py <= patchRad; py++) {
      const tRow = (ty + py) * w + tx;
      const sRow = (sy + py) * w + sx;
      for (let px = -patchRad; px <= patchRad; px++) {
        const tIdx = tRow + px;
        const sIdx = sRow + px;
        const tOff = tIdx * 4;
        const sOff = sIdx * 4;
        const dr = rgba[tOff] - rgba[sOff];
        const dg = rgba[tOff + 1] - rgba[sOff + 1];
        const db = rgba[tOff + 2] - rgba[sOff + 2];
        const pw = origMask[tIdx] === 0 ? knownWeightBoost : 1;
        err += (dr * dr + dg * dg + db * db) * pw;
        wSum += pw;
      }
    }
    return wSum > 0 ? err / wSum : err;
  };

  // Initialize NNF for target pixels with random valid sources (biased toward nearby valid sources first)
  for (let i = 0; i < targetCoords.length; i++) {
    const idx = targetCoords[i];
    const tx = idx % w;
    const ty = (idx - tx) / w;

    // Try up to 4 samples and pick best initial match
    let bestSx = -1;
    let bestSy = -1;
    let bestE = 1e12;
    for (let attempt = 0; attempt < 4; attempt++) {
      const pick = validSourcesList[Math.floor(rand() * validSourcesList.length)];
      const sx = pick % w;
      const sy = (pick - sx) / w;
      const e = patchSsd(tx, ty, sx, sy, 2.2);
      if (e < bestE) {
        bestE = e;
        bestSx = sx;
        bestSy = sy;
      }
    }
    nnX[idx] = bestSx;
    nnY[idx] = bestSy;
    nnErr[idx] = bestE;
  }

  const maxSearchRad = Math.max(w, h);
  const accumR = new Float32Array(total);
  const accumG = new Float32Array(total);
  const accumB = new Float32Array(total);
  const accumA = new Float32Array(total);
  const accumW = new Float32Array(total);

  for (let iter = 0; iter < iterations; iter++) {
    const reverse = (iter & 1) === 1;
    const step = reverse ? -1 : 1;
    const startIdx = reverse ? targetCoords.length - 1 : 0;
    const endIdx = reverse ? -1 : targetCoords.length;
    const knownBoost = iter === 0 ? 2.5 : 1.5;

    // 1) PatchMatch Propagation + Random Search
    for (let ti = startIdx; ti !== endIdx; ti += step) {
      const idx = targetCoords[ti];
      const tx = idx % w;
      const ty = (idx - tx) / w;
      let bestSx = nnX[idx];
      let bestSy = nnY[idx];
      let bestE = patchSsd(tx, ty, bestSx, bestSy, knownBoost);

      // Spatial neighbor propagation
      const nx1 = tx - step;
      if (nx1 >= minX && nx1 <= maxX) {
        const nIdx = ty * w + nx1;
        const candX = nnX[nIdx] + step;
        const candY = nnY[nIdx];
        if (candX >= minX && candX <= maxX && candY >= minY && candY <= maxY && validSource[candY * w + candX]) {
          const e = patchSsd(tx, ty, candX, candY, knownBoost);
          if (e < bestE) {
            bestE = e;
            bestSx = candX;
            bestSy = candY;
          }
        }
      }

      const ny1 = ty - step;
      if (ny1 >= minY && ny1 <= maxY) {
        const nIdx = ny1 * w + tx;
        const candX = nnX[nIdx];
        const candY = nnY[nIdx] + step;
        if (candX >= minX && candX <= maxX && candY >= minY && candY <= maxY && validSource[candY * w + candX]) {
          const e = patchSsd(tx, ty, candX, candY, knownBoost);
          if (e < bestE) {
            bestE = e;
            bestSx = candX;
            bestSy = candY;
          }
        }
      }

      // Exponentially decreasing random search
      let rad = maxSearchRad;
      while (rad >= 2) {
        const rx = Math.round(bestSx + (rand() * 2 - 1) * rad);
        const ry = Math.round(bestSy + (rand() * 2 - 1) * rad);
        if (rx >= minX && rx <= maxX && ry >= minY && ry <= maxY && validSource[ry * w + rx]) {
          const e = patchSsd(tx, ty, rx, ry, knownBoost);
          if (e < bestE) {
            bestE = e;
            bestSx = rx;
            bestSy = ry;
          }
        }
        rad = Math.floor(rad * 0.5);
      }

      nnX[idx] = bestSx;
      nnY[idx] = bestSy;
      nnErr[idx] = bestE;
    }

    // 2) Patch Voting (EM reconstruction) — only update masked pixels
    accumR.fill(0);
    accumG.fill(0);
    accumB.fill(0);
    accumA.fill(0);
    accumW.fill(0);

    // Sharpness temperature: higher sharpness on later iterations preserves texture details
    const isFinalIter = iter === iterations - 1;
    const temp = isFinalIter ? 40 : 140;

    for (let ti = 0; ti < targetCoords.length; ti++) {
      const idx = targetCoords[ti];
      const tx = idx % w;
      const ty = (idx - tx) / w;
      const sx = nnX[idx];
      const sy = nnY[idx];
      if (sx < minX || sy < minY) continue;

      const patchWeight = Math.exp(-Math.min(10, nnErr[idx] / temp));
      for (let py = -patchRad; py <= patchRad; py++) {
        const tRow = (ty + py) * w + tx;
        const sRow = (sy + py) * w + sx;
        for (let px = -patchRad; px <= patchRad; px++) {
          const tIdx = tRow + px;
          if (origMask[tIdx] === 0) continue;
          const sOff = (sRow + px) * 4;
          // Slight center bias inside patch for sharper texture coherence
          const centerW = 1 / (1 + (px * px + py * py) * 0.15);
          const wTotal = patchWeight * centerW;
          accumR[tIdx] += rgba[sOff] * wTotal;
          accumG[tIdx] += rgba[sOff + 1] * wTotal;
          accumB[tIdx] += rgba[sOff + 2] * wTotal;
          accumA[tIdx] += rgba[sOff + 3] * wTotal;
          accumW[tIdx] += wTotal;
        }
      }
    }

    for (let i = 0; i < total; i++) {
      if (origMask[i] === 0 || accumW[i] <= 0) continue;
      const invW = 1 / accumW[i];
      const off = i * 4;
      rgba[off] = Math.max(0, Math.min(255, Math.round(accumR[i] * invW)));
      rgba[off + 1] = Math.max(0, Math.min(255, Math.round(accumG[i] * invW)));
      rgba[off + 2] = Math.max(0, Math.min(255, Math.round(accumB[i] * invW)));
      rgba[off + 3] = Math.max(0, Math.min(255, Math.round(accumA[i] * invW)));
    }
  }
}

export interface PatchInpaintOptions {
  srcRgba: Uint8ClampedArray;
  mask: Uint8Array;
  width: number;
  height: number;
  dilatePx?: number;
  featherPx?: number;
  addGrain?: boolean;
  onProgress?: (percent: number, stage: string) => void;
}

export interface PatchInpaintResult {
  rgba: Uint8ClampedArray;
  engineUsed: 'patchmatch' | 'telea-fallback';
  boundingBox: MaskBoundingBox | null;
}

/**
 * Full-resolution, bounding-box-scoped multi-scale PatchMatch / exemplar inpainting
 * with Telea fallback for tiny masks, matching film/texture grain, and feathered blending.
 * Pixels outside the dilated mask are guaranteed bit-for-bit identical to srcRgba.
 */
export function inpaintPhotoPatchBased(options: PatchInpaintOptions): PatchInpaintResult {
  const {
    srcRgba,
    mask,
    width,
    height,
    dilatePx = 2,
    featherPx = 4,
    addGrain = true,
    onProgress,
  } = options;

  const total = width * height;
  if (total === 0 || srcRgba.length < total * 4 || mask.length < total) {
    return {
      rgba: new Uint8ClampedArray(srcRgba),
      engineUsed: 'telea-fallback',
      boundingBox: null,
    };
  }

  onProgress?.(4, 'Preparing watermark mask...');
  const workingMask =
    dilatePx > 0 ? dilateBinaryMask(mask, width, height, Math.min(5, Math.round(dilatePx))) : new Uint8Array(mask);

  const tightBox = computeMaskBoundingBox(workingMask, width, height, 0);
  if (!tightBox) {
    return {
      rgba: new Uint8ClampedArray(srcRgba),
      engineUsed: 'telea-fallback',
      boundingBox: null,
    };
  }

  // Context padding around the watermark for patch sampling & texture synthesis
  const maskSpan = Math.max(tightBox.width, tightBox.height);
  const pad = Math.max(48, Math.min(220, Math.round(maskSpan * 0.9)));
  const paddedBox = computeMaskBoundingBox(workingMask, width, height, pad)!;

  const roiRgba = extractRgbaRegion(srcRgba, width, paddedBox);
  const roiMask = extractMaskRegion(workingMask, width, paddedBox);
  const rw = paddedBox.width;
  const rh = paddedBox.height;

  // Fast Telea fallback for tiny masks (< 28 pixels) or insufficient surrounding area
  if (tightBox.maskCount < 28 || rw < 20 || rh < 20) {
    onProgress?.(55, 'Running fast Telea fill for tiny mask...');
    const teleaRoi = teleaInpaintRgba(roiRgba, roiMask, rw, rh, 5);
    const grained = addGrain ? applyMatchedSurroundingGrain(teleaRoi, roiMask, rw, rh) : teleaRoi;
    const blended = compositeFeatheredRegion(srcRgba, grained, roiMask, width, paddedBox, featherPx);
    onProgress?.(100, 'Done');
    return { rgba: blended, engineUsed: 'telea-fallback', boundingBox: paddedBox };
  }

  try {
    onProgress?.(12, 'Building multi-scale texture pyramid...');
    const pyramid: PyramidLevel[] = [
      { width: rw, height: rh, rgba: new Uint8ClampedArray(roiRgba), mask: new Uint8Array(roiMask) },
    ];

    // Build coarse levels while region remains >= 16px and masked pixels remain non-trivial
    while (pyramid.length < 5) {
      const top = pyramid[pyramid.length - 1];
      if (top.width < 28 || top.height < 28) break;
      const next = downsampleHalf(top.rgba, top.mask, top.width, top.height);
      const nextBox = computeMaskBoundingBox(next.mask, next.width, next.height, 0);
      if (!nextBox || nextBox.maskCount < 4) break;
      pyramid.push(next);
    }

    // Seed coarsest level with Telea structural continuation
    const coarsestIdx = pyramid.length - 1;
    const coarsest = pyramid[coarsestIdx];
    onProgress?.(22, 'Initializing coarse structure...');
    coarsest.rgba = teleaInpaintRgba(coarsest.rgba, coarsest.mask, coarsest.width, coarsest.height, 5);

    // Refine from coarsest to finest with PatchMatch NNF + Patch Voting
    for (let lvl = coarsestIdx; lvl >= 0; lvl--) {
      const level = pyramid[lvl];
      if (lvl < coarsestIdx) {
        const prev = pyramid[lvl + 1];
        upsampleMaskedPixelsFromCoarse(
          prev.rgba,
          prev.width,
          prev.height,
          level.rgba,
          level.mask,
          level.width,
          level.height
        );
      }

      const patchRad = lvl === 0 ? 3 : 2;
      const iters = lvl === 0 ? 4 : 3;
      const pct = 25 + Math.round(((coarsestIdx - lvl + 1) / (coarsestIdx + 1)) * 62);
      onProgress?.(
        Math.min(88, pct),
        lvl === 0 ? 'Synthesizing full-resolution texture patches...' : `Matching texture at scale ${lvl + 1}...`
      );
      runPatchMatchAtLevel(
        level.rgba,
        level.mask,
        level.width,
        level.height,
        patchRad,
        iters,
        101 + lvl * 97
      );
    }

    let finalRoi = pyramid[0].rgba;
    if (addGrain) {
      onProgress?.(91, 'Matching surrounding grain and texture noise...');
      finalRoi = applyMatchedSurroundingGrain(finalRoi, roiMask, rw, rh);
    }

    onProgress?.(96, 'Blending feathered mask edges...');
    const out = compositeFeatheredRegion(srcRgba, finalRoi, roiMask, width, paddedBox, featherPx);
    onProgress?.(100, 'Watermark removed');
    return {
      rgba: out,
      engineUsed: 'patchmatch',
      boundingBox: paddedBox,
    };
  } catch {
    onProgress?.(60, 'Falling back to Telea inpainting...');
    const teleaRoi = teleaInpaintRgba(roiRgba, roiMask, rw, rh, 5);
    const grained = addGrain ? applyMatchedSurroundingGrain(teleaRoi, roiMask, rw, rh) : teleaRoi;
    const blended = compositeFeatheredRegion(srcRgba, grained, roiMask, width, paddedBox, featherPx);
    onProgress?.(100, 'Done');
    return {
      rgba: blended,
      engineUsed: 'telea-fallback',
      boundingBox: paddedBox,
    };
  }
}
