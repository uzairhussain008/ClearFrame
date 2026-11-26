import {
  AI_FIXED_TILE_SIZE,
  AI_MODEL_SCALE,
  AI_TILE_OVERLAP,
  blendFixedUpscaledTileIntoAccum,
  computeTileGrid,
  ensureWebGpuAiSession,
  extractFixedRgbaTileToTensor,
  finalizeAccumToRgba,
  type AiProvider,
} from './webgpuUpscaler';

export const MAX_PHOTO_OUTPUT_DIM = 8000;
export type PhotoUpscaleScale = 2 | 4;
export type PhotoUpscaleEngine = 'webgpu' | 'wasm' | 'lanczos';

export interface PhotoDimensionCheckResult {
  allowed: boolean;
  outputWidth: number;
  outputHeight: number;
  reason?: string;
}

export function checkPhotoUpscaleDimensions(
  width: number,
  height: number,
  scale: PhotoUpscaleScale
): PhotoDimensionCheckResult {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const outputWidth = safeW * scale;
  const outputHeight = safeH * scale;
  const longestSide = Math.max(outputWidth, outputHeight);

  if (longestSide > MAX_PHOTO_OUTPUT_DIM) {
    return {
      allowed: false,
      outputWidth,
      outputHeight,
      reason: `Upscaling ${safeW}×${safeH} by ${scale}x produces ${outputWidth}×${outputHeight}, which exceeds the ${MAX_PHOTO_OUTPUT_DIM.toLocaleString()} px maximum side limit. Choose 2x or use a smaller image.`,
    };
  }

  return {
    allowed: true,
    outputWidth,
    outputHeight,
  };
}

export async function detectPhotoWebGpuSupport(): Promise<{
  supported: boolean;
  reason?: string;
}> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return {
      supported: false,
      reason: 'WebGPU is unavailable in this browser. High-quality Lanczos upscaling will be used.',
    };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        reason: 'No WebGPU adapter detected. High-quality Lanczos upscaling will be used.',
      };
    }
    return { supported: true };
  } catch {
    return {
      supported: false,
      reason: 'WebGPU initialization failed. High-quality Lanczos upscaling will be used.',
    };
  }
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

function lanczosKernel(x: number, lobes = 3): number {
  const ax = Math.abs(x);
  if (ax >= lobes) return 0;
  return sinc(x) * sinc(x / lobes);
}

export function lanczosUpscaleRgba(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  onProgress?: (pct: number) => void
): Uint8ClampedArray {
  const lobes = 3;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return out;

  // Horizontal pass into Float32 buffer (dstW x srcH x 4)
  const temp = new Float32Array(dstW * srcH * 4);
  const scaleX = srcW / dstW;
  const filterScaleX = scaleX > 1 ? scaleX : 1;
  const supportX = lobes * filterScaleX;

  for (let dx = 0; dx < dstW; dx++) {
    const center = (dx + 0.5) * scaleX - 0.5;
    const start = Math.max(0, Math.floor(center - supportX));
    const end = Math.min(srcW - 1, Math.ceil(center + supportX));
    const count = end - start + 1;
    const weights = new Float32Array(count);
    let wSum = 0;
    for (let k = 0; k < count; k++) {
      const w = lanczosKernel((start + k - center) / filterScaleX, lobes);
      weights[k] = w;
      wSum += w;
    }
    const invW = wSum > 0 ? 1 / wSum : 1;
    for (let k = 0; k < count; k++) weights[k] *= invW;

    for (let sy = 0; sy < srcH; sy++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const srcRow = sy * srcW;
      for (let k = 0; k < count; k++) {
        const w = weights[k];
        const sIdx = (srcRow + start + k) * 4;
        r += srcRgba[sIdx] * w;
        g += srcRgba[sIdx + 1] * w;
        b += srcRgba[sIdx + 2] * w;
        a += srcRgba[sIdx + 3] * w;
      }
      const dIdx = (sy * dstW + dx) * 4;
      temp[dIdx] = r;
      temp[dIdx + 1] = g;
      temp[dIdx + 2] = b;
      temp[dIdx + 3] = a;
    }
    if (onProgress && dx % 64 === 0) {
      onProgress(Math.round((dx / dstW) * 45));
    }
  }

  // Vertical pass into Uint8ClampedArray (dstW x dstH x 4)
  const scaleY = srcH / dstH;
  const filterScaleY = scaleY > 1 ? scaleY : 1;
  const supportY = lobes * filterScaleY;

  for (let dy = 0; dy < dstH; dy++) {
    const center = (dy + 0.5) * scaleY - 0.5;
    const start = Math.max(0, Math.floor(center - supportY));
    const end = Math.min(srcH - 1, Math.ceil(center + supportY));
    const count = end - start + 1;
    const weights = new Float32Array(count);
    let wSum = 0;
    for (let k = 0; k < count; k++) {
      const w = lanczosKernel((start + k - center) / filterScaleY, lobes);
      weights[k] = w;
      wSum += w;
    }
    const invW = wSum > 0 ? 1 / wSum : 1;
    for (let k = 0; k < count; k++) weights[k] *= invW;

    const dstRow = dy * dstW;
    for (let dx = 0; dx < dstW; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < count; k++) {
        const w = weights[k];
        const tIdx = ((start + k) * dstW + dx) * 4;
        r += temp[tIdx] * w;
        g += temp[tIdx + 1] * w;
        b += temp[tIdx + 2] * w;
        a += temp[tIdx + 3] * w;
      }
      const oIdx = (dstRow + dx) * 4;
      out[oIdx] = Math.max(0, Math.min(255, Math.round(r)));
      out[oIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[oIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[oIdx + 3] = Math.max(0, Math.min(255, Math.round(a)));
    }
    if (onProgress && dy % 64 === 0) {
      onProgress(45 + Math.round((dy / dstH) * 50));
    }
  }

  onProgress?.(100);
  return out;
}

export interface PhotoUpscaleOptions {
  srcRgba: Uint8ClampedArray;
  width: number;
  height: number;
  scale: PhotoUpscaleScale;
  preferAi: boolean;
  signal?: AbortSignal;
  onProgress: (info: { percent: number; stage: string }) => void;
}

export interface PhotoUpscaleResult {
  rgba: Uint8ClampedArray;
  outputWidth: number;
  outputHeight: number;
  engineUsed: PhotoUpscaleEngine;
  providerLabel: string;
}

export async function upscalePhotoRgba(opts: PhotoUpscaleOptions): Promise<PhotoUpscaleResult> {
  const { srcRgba, width, height, scale, preferAi, signal, onProgress } = opts;
  const dimCheck = checkPhotoUpscaleDimensions(width, height, scale);
  if (!dimCheck.allowed) {
    throw new Error(dimCheck.reason || 'Output image exceeds safe size limits.');
  }

  const targetW = dimCheck.outputWidth;
  const targetH = dimCheck.outputHeight;

  if (preferAi) {
    try {
      onProgress({ percent: 4, stage: 'Initializing browser AI model...' });
      const sessionInfo = await ensureWebGpuAiSession((pct) => {
        if (typeof pct === 'number') {
          onProgress({
            percent: Math.min(22, 4 + Math.round(pct * 0.18)),
            stage: pct < 100 ? `Loading AI model (${pct}%)...` : 'AI model ready',
          });
        }
      }, signal);

      if (signal?.aborted) {
        throw new Error('Cancelled');
      }

      const tiles = computeTileGrid(width, height, AI_FIXED_TILE_SIZE, AI_TILE_OVERLAP);
      const fullAiW = width * AI_MODEL_SCALE;
      const fullAiH = height * AI_MODEL_SCALE;
      const accumRgb = new Float32Array(fullAiW * fullAiH * 3);
      const accumWeight = new Float32Array(fullAiW * fullAiH);
      const { ort, session, io, provider } = sessionInfo;
      const inputDims: [number, number, number, number] =
        io.inputLayout === 'NCHW'
          ? [1, 3, AI_FIXED_TILE_SIZE, AI_FIXED_TILE_SIZE]
          : [1, AI_FIXED_TILE_SIZE, AI_FIXED_TILE_SIZE, 3];

      for (let i = 0; i < tiles.length; i++) {
        if (signal?.aborted) {
          throw new Error('Cancelled');
        }
        const tile = tiles[i];
        const tileData = extractFixedRgbaTileToTensor(
          srcRgba,
          width,
          tile.x,
          tile.y,
          tile.w,
          tile.h,
          AI_FIXED_TILE_SIZE,
          io.inputLayout
        );
        const inputTensor = new ort.Tensor(io.inputDtype, tileData, inputDims);
        const results = await session.run({ [io.inputName]: inputTensor });
        inputTensor.dispose();

        const outTensor = results[io.outputName];
        const outFloat = outTensor.data as Float32Array;
        blendFixedUpscaledTileIntoAccum(
          outFloat,
          tile.x,
          tile.y,
          tile.w,
          tile.h,
          width,
          height,
          AI_FIXED_TILE_SIZE,
          AI_MODEL_SCALE,
          AI_TILE_OVERLAP,
          io.outputLayout,
          accumRgb,
          accumWeight
        );
        for (const t of Object.values(results)) {
          try {
            t.dispose();
          } catch {
            // Ignore disposal warning
          }
        }

        const pct = 24 + Math.round(((i + 1) / tiles.length) * (scale === 2 ? 66 : 74));
        onProgress({
          percent: Math.min(98, pct),
          stage: `AI upscaling tile ${i + 1} of ${tiles.length} (${provider.toUpperCase()})...`,
        });
      }

      const ai4xRgba = new Uint8ClampedArray(fullAiW * fullAiH * 4);
      finalizeAccumToRgba(accumRgb, accumWeight, ai4xRgba);

      let finalRgba: Uint8ClampedArray = ai4xRgba;
      if (scale === 2) {
        onProgress({ percent: 92, stage: 'Resampling 4x AI detail to crisp 2x...' });
        finalRgba = lanczosUpscaleRgba(ai4xRgba, fullAiW, fullAiH, targetW, targetH);
      }

      // Preserve source alpha channel via Lanczos scaling if any non-opaque pixel existed
      const hasAlpha = hasTransparency(srcRgba);
      if (hasAlpha) {
        const alphaScaled = lanczosUpscaleRgba(srcRgba, width, height, targetW, targetH);
        for (let i = 3; i < finalRgba.length; i += 4) {
          finalRgba[i] = alphaScaled[i];
        }
      }

      onProgress({ percent: 100, stage: 'Upscaling complete' });
      const resolvedEngine: AiProvider = provider;
      return {
        rgba: finalRgba,
        outputWidth: targetW,
        outputHeight: targetH,
        engineUsed: resolvedEngine,
        providerLabel:
          resolvedEngine === 'webgpu' ? 'AI Upscaler (WebGPU)' : 'AI Upscaler (WASM)',
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'Cancelled')) {
        throw err;
      }
      console.warn('[Photo Upscaler] AI runtime unavailable, falling back to Lanczos:', err);
    }
  }

  onProgress({ percent: 10, stage: `Upscaling ${scale}x with Lanczos resampling...` });
  const lanczosRgba = lanczosUpscaleRgba(srcRgba, width, height, targetW, targetH, (pct) => {
    onProgress({
      percent: Math.min(99, 10 + Math.round(pct * 0.89)),
      stage: `Upscaling ${scale}x with Lanczos resampling...`,
    });
  });

  onProgress({ percent: 100, stage: 'Upscaling complete' });
  return {
    rgba: lanczosRgba,
    outputWidth: targetW,
    outputHeight: targetH,
    engineUsed: 'lanczos',
    providerLabel: 'Lanczos-3 Resampling (CPU Fallback)',
  };
}

function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  return false;
}
