import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export const ORT_CDN_VERSION = '1.31.1';
export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_CDN_VERSION}/dist/`;
export const ORT_WEBGPU_CDN_URL = `${ORT_CDN_BASE}ort.webgpu.bundle.min.mjs`;

export const AI_MODEL_NAME = 'realesr-general-x4v3.onnx';
export const AI_MODEL_URL =
  'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx';
export const AI_MODEL_MIRROR_URL =
  'https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/realesr-general-x4v3.onnx';
export const AI_MODEL_CACHE = 'clearframe-ai-models-v2';
export const AI_MODEL_MIN_BYTES = 1_000_000;
export const AI_MODEL_SCALE = 4;
export const AI_FIXED_TILE_SIZE = 192;
export const AI_TILE_OVERLAP = 16;

export type AiProvider = 'webgpu' | 'wasm';
export type TensorLayout = 'NCHW' | 'NHWC';

export interface AiClientLimits {
  maxDurationSec: number;
  maxHeight: number;
  maxSizeMb: number;
}

export const DEFAULT_AI_CLIENT_LIMITS: AiClientLimits = {
  maxDurationSec: 30,
  maxHeight: 720,
  maxSizeMb: 100,
};

export interface AiLimitCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkAiVideoLimits(
  video: { width: number; height: number; duration: number; size: number },
  limits: AiClientLimits = DEFAULT_AI_CLIENT_LIMITS
): AiLimitCheckResult {
  const maxBytes = limits.maxSizeMb * 1024 * 1024;
  if (video.size > maxBytes) {
    return {
      allowed: false,
      reason: `AI Upscaler supports files up to ${limits.maxSizeMb} MB. Use CPU mode for larger videos.`,
    };
  }
  if (video.duration > limits.maxDurationSec) {
    return {
      allowed: false,
      reason: `AI Upscaler supports clips up to ${limits.maxDurationSec}s. Use CPU mode for longer videos.`,
    };
  }
  const shortSide = Math.min(video.width, video.height);
  const longSide = Math.max(video.width, video.height);
  const maxLongSide = Math.round((limits.maxHeight * 16) / 9);
  if (shortSide > limits.maxHeight || longSide > maxLongSide) {
    return {
      allowed: false,
      reason: `AI Upscaler supports up to ${limits.maxHeight}p source videos. Use CPU mode for ${video.width}×${video.height}.`,
    };
  }
  return { allowed: true };
}

export interface FrameScheduleItem {
  index: number;
  timestampSec: number;
  timestampUs: number;
  durationUs: number;
}

export function computeFrameSchedule(
  durationSec: number,
  fps: number,
  rawPtsSec?: number[]
): FrameScheduleItem[] {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  const safeFps = Number.isFinite(fps) && fps > 0.5 ? Math.min(120, fps) : 30;

  if (Array.isArray(rawPtsSec) && rawPtsSec.length >= 2) {
    const cleaned = rawPtsSec
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);

    if (cleaned.length >= 2) {
      const t0 = cleaned[0];
      const normalized: number[] = [];
      let prev = -1;
      for (const raw of cleaned) {
        const rel = Math.max(0, raw - t0);
        if (rel > safeDuration + 0.25) break;
        const clamped = Math.min(Math.max(0, safeDuration - 0.002), rel);
        if (normalized.length === 0 || clamped > prev + 0.0005) {
          normalized.push(clamped);
          prev = clamped;
        }
      }

      if (normalized.length >= 2) {
        const fallbackStepUs = Math.max(1000, Math.round(1_000_000 / safeFps));
        return normalized.map((ts, index) => {
          const timestampUs = Math.round(ts * 1_000_000);
          const nextSec = index + 1 < normalized.length ? normalized[index + 1] : Math.max(ts + 1 / safeFps, safeDuration);
          const nextUs = Math.round(nextSec * 1_000_000);
          const durationUs = Math.max(1000, index + 1 < normalized.length ? nextUs - timestampUs : fallbackStepUs);
          return {
            index,
            timestampSec: ts,
            timestampUs,
            durationUs,
          };
        });
      }
    }
  }

  const totalFrames = Math.max(1, Math.round(safeDuration * safeFps));
  const items: FrameScheduleItem[] = [];
  for (let i = 0; i < totalFrames; i++) {
    const rawSec = i / safeFps;
    const timestampSec = Math.min(Math.max(0, safeDuration - 0.002), rawSec);
    const timestampUs = Math.round(rawSec * 1_000_000);
    const nextUs = Math.round(((i + 1) / safeFps) * 1_000_000);
    items.push({
      index: i,
      timestampSec,
      timestampUs,
      durationUs: Math.max(1000, nextUs - timestampUs),
    });
  }
  return items;
}

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function computeTileGrid(
  width: number,
  height: number,
  tileSize = AI_FIXED_TILE_SIZE,
  overlap = AI_TILE_OVERLAP
): TileRect[] {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const safeTile = Math.max(32, Math.round(tileSize));
  const safeOverlap = Math.min(Math.floor(safeTile / 3), Math.max(0, Math.round(overlap)));
  const stride = Math.max(16, safeTile - safeOverlap * 2);

  const xs: number[] = [];
  if (safeW <= safeTile) {
    xs.push(0);
  } else {
    for (let x = 0; x < safeW; x += stride) {
      const clampedX = Math.min(x, safeW - safeTile);
      if (xs.length === 0 || xs[xs.length - 1] !== clampedX) {
        xs.push(clampedX);
      }
      if (clampedX + safeTile >= safeW) break;
    }
  }

  const ys: number[] = [];
  if (safeH <= safeTile) {
    ys.push(0);
  } else {
    for (let y = 0; y < safeH; y += stride) {
      const clampedY = Math.min(y, safeH - safeTile);
      if (ys.length === 0 || ys[ys.length - 1] !== clampedY) {
        ys.push(clampedY);
      }
      if (clampedY + safeTile >= safeH) break;
    }
  }

  const tiles: TileRect[] = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({
        x,
        y,
        w: Math.min(safeTile, safeW - x),
        h: Math.min(safeTile, safeH - y),
      });
    }
  }
  return tiles;
}

export function detectTensorLayoutFromShape(shape: ReadonlyArray<number | string> | undefined): TensorLayout {
  if (Array.isArray(shape) && shape.length === 4) {
    if (shape[1] === 3) return 'NCHW';
    if (shape[3] === 3) return 'NHWC';
  }
  return 'NCHW';
}

export function extractFixedRgbaTileToTensor(
  rgba: Uint8ClampedArray,
  fullW: number,
  tileX: number,
  tileY: number,
  tileW: number,
  tileH: number,
  fixedSize = AI_FIXED_TILE_SIZE,
  layout: TensorLayout = 'NCHW'
): Float32Array {
  const plane = fixedSize * fixedSize;
  const out = new Float32Array(3 * plane);
  const inv255 = 1 / 255;
  const validW = Math.max(1, tileW);
  const validH = Math.max(1, tileH);

  if (layout === 'NCHW') {
    const gOffset = plane;
    const bOffset = plane * 2;
    for (let row = 0; row < fixedSize; row++) {
      const clampedRow = Math.min(row, validH - 1);
      const srcRowStart = ((tileY + clampedRow) * fullW + tileX) * 4;
      const dstRowStart = row * fixedSize;
      for (let col = 0; col < fixedSize; col++) {
        const clampedCol = Math.min(col, validW - 1);
        const s = srcRowStart + clampedCol * 4;
        const d = dstRowStart + col;
        out[d] = rgba[s] * inv255;
        out[gOffset + d] = rgba[s + 1] * inv255;
        out[bOffset + d] = rgba[s + 2] * inv255;
      }
    }
  } else {
    for (let row = 0; row < fixedSize; row++) {
      const clampedRow = Math.min(row, validH - 1);
      const srcRowStart = ((tileY + clampedRow) * fullW + tileX) * 4;
      const dstRowStart = row * fixedSize * 3;
      for (let col = 0; col < fixedSize; col++) {
        const clampedCol = Math.min(col, validW - 1);
        const s = srcRowStart + clampedCol * 4;
        const d = dstRowStart + col * 3;
        out[d] = rgba[s] * inv255;
        out[d + 1] = rgba[s + 1] * inv255;
        out[d + 2] = rgba[s + 2] * inv255;
      }
    }
  }

  return out;
}

export function blendFixedUpscaledTileIntoAccum(
  tileData: Float32Array,
  tileX: number,
  tileY: number,
  tileW: number,
  tileH: number,
  fullInW: number,
  fullInH: number,
  fixedInSize: number,
  scale: number,
  overlap: number,
  layout: TensorLayout,
  accumRgb: Float32Array,
  accumWeight: Float32Array
): void {
  const fixedOutSize = fixedInSize * scale;
  const outTileW = tileW * scale;
  const outTileH = tileH * scale;
  const fullOutW = fullInW * scale;
  const outX0 = tileX * scale;
  const outY0 = tileY * scale;
  const feather = overlap * scale;
  const fixedPlane = fixedOutSize * fixedOutSize;
  const gOffset = fixedPlane;
  const bOffset = fixedPlane * 2;

  const hasLeftNeighbor = tileX > 0 && feather > 0;
  const hasRightNeighbor = tileX + tileW < fullInW && feather > 0;
  const hasTopNeighbor = tileY > 0 && feather > 0;
  const hasBottomNeighbor = tileY + tileH < fullInH && feather > 0;

  for (let row = 0; row < outTileH; row++) {
    let wy = 1;
    if (hasTopNeighbor && row < feather) {
      wy = Math.min(wy, (row + 0.5) / feather);
    }
    if (hasBottomNeighbor && outTileH - 1 - row < feather) {
      wy = Math.min(wy, (outTileH - row - 0.5) / feather);
    }

    const globalRowOffset = (outY0 + row) * fullOutW + outX0;
    const tileRowOffset = row * fixedOutSize;

    for (let col = 0; col < outTileW; col++) {
      let wx = 1;
      if (hasLeftNeighbor && col < feather) {
        wx = Math.min(wx, (col + 0.5) / feather);
      }
      if (hasRightNeighbor && outTileW - 1 - col < feather) {
        wx = Math.min(wx, (outTileW - col - 0.5) / feather);
      }

      const w = wx * wy;
      const tIdx = tileRowOffset + col;
      const gIdx = globalRowOffset + col;
      const rgbBase = gIdx * 3;

      if (layout === 'NCHW') {
        accumRgb[rgbBase] += tileData[tIdx] * w;
        accumRgb[rgbBase + 1] += tileData[gOffset + tIdx] * w;
        accumRgb[rgbBase + 2] += tileData[bOffset + tIdx] * w;
      } else {
        const nhwcIdx = tIdx * 3;
        accumRgb[rgbBase] += tileData[nhwcIdx] * w;
        accumRgb[rgbBase + 1] += tileData[nhwcIdx + 1] * w;
        accumRgb[rgbBase + 2] += tileData[nhwcIdx + 2] * w;
      }
      accumWeight[gIdx] += w;
    }
  }
}

export function finalizeAccumToRgba(
  accumRgb: Float32Array,
  accumWeight: Float32Array,
  outRgba: Uint8ClampedArray
): void {
  const totalPixels = accumWeight.length;
  for (let i = 0; i < totalPixels; i++) {
    const w = accumWeight[i] > 0 ? accumWeight[i] : 1;
    const rgbIdx = i * 3;
    const rgbaIdx = i * 4;
    outRgba[rgbaIdx] = Math.min(255, Math.max(0, Math.round((accumRgb[rgbIdx] / w) * 255)));
    outRgba[rgbaIdx + 1] = Math.min(255, Math.max(0, Math.round((accumRgb[rgbIdx + 1] / w) * 255)));
    outRgba[rgbaIdx + 2] = Math.min(255, Math.max(0, Math.round((accumRgb[rgbIdx + 2] / w) * 255)));
    outRgba[rgbaIdx + 3] = 255;
  }
}

export interface WebGpuSupportResult {
  supported: boolean;
  reason?: string;
}

export async function detectWebGpuSupport(): Promise<WebGpuSupportResult> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return {
      supported: false,
      reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
    };
  }

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return {
      supported: false,
      reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
      };
    }

    return { supported: true };
  } catch {
    return {
      supported: false,
      reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
    };
  }
}

interface OrtTensor {
  dims: ReadonlyArray<number>;
  data: Float32Array | Uint8Array | Int32Array;
  dispose: () => void;
}

interface OrtSessionMetadataEntry {
  name?: string;
  shape?: ReadonlyArray<number | string>;
  type?: string;
}

interface OrtSession {
  inputNames: ReadonlyArray<string>;
  outputNames: ReadonlyArray<string>;
  inputMetadata?: ReadonlyArray<OrtSessionMetadataEntry>;
  outputMetadata?: ReadonlyArray<OrtSessionMetadataEntry>;
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
  release: () => Promise<void>;
}

interface OrtModule {
  env: {
    wasm: {
      wasmPaths?: string;
      numThreads?: number;
      proxy?: boolean;
    };
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: ReadonlyArray<number>) => OrtTensor;
  InferenceSession: {
    create: (modelBytes: Uint8Array, options?: Record<string, unknown>) => Promise<OrtSession>;
  };
}

export interface SessionIoMeta {
  inputName: string;
  outputName: string;
  inputLayout: TensorLayout;
  outputLayout: TensorLayout;
  inputDtype: 'float32';
  symbolicOverrides: Record<string, number>;
}

export interface CachedAiSessionInfo {
  ort: OrtModule;
  session: OrtSession;
  provider: AiProvider;
  modelName: string;
  io: SessionIoMeta;
}

let cachedOrtModule: OrtModule | null = null;
let cachedModelBytes: Uint8Array | null = null;
let cachedSessionInfo: CachedAiSessionInfo | null = null;

async function loadOrtRuntimeFromCdn(): Promise<OrtModule> {
  if (cachedOrtModule) {
    return cachedOrtModule;
  }

  try {
    const imported = (await import(/* @vite-ignore */ ORT_WEBGPU_CDN_URL)) as
      | OrtModule
      | { default?: OrtModule };
    const ort = ('InferenceSession' in imported ? imported : imported.default) as OrtModule | undefined;
    if (!ort || !ort.InferenceSession || !ort.Tensor || !ort.env?.wasm) {
      throw new Error('Loaded ONNX Runtime module is incomplete.');
    }
    ort.env.wasm.wasmPaths = ORT_CDN_BASE;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    cachedOrtModule = ort;
    return ort;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load AI runtime from CDN (onnxruntime-web@${ORT_CDN_VERSION}): ${detail}. Continue with CPU Upscaler.`
    );
  }
}

function inspectSessionIo(session: OrtSession, fixedTileSize = AI_FIXED_TILE_SIZE): SessionIoMeta {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const inMeta = session.inputMetadata?.[0];
  const outMeta = session.outputMetadata?.[0];

  const inputLayout = detectTensorLayoutFromShape(inMeta?.shape);
  const outputLayout = detectTensorLayoutFromShape(outMeta?.shape);

  const overrides: Record<string, number> = {
    batch_size: 1,
    height: fixedTileSize,
    width: fixedTileSize,
  };
  if (Array.isArray(inMeta?.shape) && inMeta.shape.length === 4) {
    const s = inMeta.shape;
    if (typeof s[0] === 'string') overrides[s[0]] = 1;
    if (inputLayout === 'NCHW') {
      if (typeof s[2] === 'string') overrides[s[2]] = fixedTileSize;
      if (typeof s[3] === 'string') overrides[s[3]] = fixedTileSize;
    } else {
      if (typeof s[1] === 'string') overrides[s[1]] = fixedTileSize;
      if (typeof s[2] === 'string') overrides[s[2]] = fixedTileSize;
    }
  }

  return {
    inputName,
    outputName,
    inputLayout,
    outputLayout,
    inputDtype: 'float32',
    symbolicOverrides: overrides,
  };
}

function buildInputTensorDims(layout: TensorLayout, fixedTileSize: number): [number, number, number, number] {
  return layout === 'NCHW'
    ? [1, 3, fixedTileSize, fixedTileSize]
    : [1, fixedTileSize, fixedTileSize, 3];
}

async function warmupVerifySession(
  ort: OrtModule,
  session: OrtSession,
  io: SessionIoMeta,
  fixedTileSize = AI_FIXED_TILE_SIZE
): Promise<void> {
  const dims = buildInputTensorDims(io.inputLayout, fixedTileSize);
  const dummy = new Float32Array(3 * fixedTileSize * fixedTileSize);
  const inputTensor = new ort.Tensor(io.inputDtype, dummy, dims);
  let results: Record<string, OrtTensor> | null = null;
  try {
    results = await session.run({ [io.inputName]: inputTensor });
    const out = results[io.outputName];
    if (!out || !out.dims || out.dims.length !== 4) {
      throw new Error('AI model returned an unexpected output tensor.');
    }
  } finally {
    inputTensor.dispose();
    if (results) {
      for (const tensor of Object.values(results)) {
        try {
          tensor.dispose();
        } catch {
          // Ignore disposal warning
        }
      }
    }
  }
}

async function streamDownloadModelFromUrl(
  url: string,
  onProgress: (pct: number | null) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetch(url, { signal, mode: 'cors' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  const totalBytes = Number(response.headers.get('content-length') || 0);
  if (!response.body) {
    onProgress(null);
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength < AI_MODEL_MIN_BYTES) {
      throw new Error('Downloaded AI model payload is incomplete.');
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  if (totalBytes <= 0) {
    onProgress(null);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      if (totalBytes > 0) {
        onProgress(Math.min(99, Math.round((loaded / totalBytes) * 100)));
      } else {
        onProgress(null);
      }
    }
  }

  if (loaded < AI_MODEL_MIN_BYTES) {
    throw new Error('Downloaded AI model payload is incomplete.');
  }

  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function fetchModelWithCacheAndProgress(
  onProgress: (pct: number | null) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (cachedModelBytes) {
    onProgress(100);
    return cachedModelBytes;
  }

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(AI_MODEL_CACHE);
      const hit = await cache.match(AI_MODEL_URL);
      if (hit && hit.ok) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.byteLength >= AI_MODEL_MIN_BYTES) {
          cachedModelBytes = bytes;
          onProgress(100);
          return bytes;
        }
      }
    } catch {
      // Cache API unavailable; fall through to network fetch
    }
  }

  let combined: Uint8Array | null = null;
  let lastError: unknown = null;
  for (const candidateUrl of [AI_MODEL_URL, AI_MODEL_MIRROR_URL]) {
    if (signal?.aborted) {
      throw new Error('Cancelled');
    }
    try {
      combined = await streamDownloadModelFromUrl(candidateUrl, onProgress, signal);
      break;
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      lastError = err;
      console.warn(`[AI Upscaler] Failed to download model from ${candidateUrl}:`, err);
    }
  }

  if (!combined) {
    const detail = lastError instanceof Error ? lastError.message : 'Network or CORS error';
    throw new Error(
      `Failed to download AI model from external CDN (${detail}). Check your connection or continue with CPU mode.`
    );
  }

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(AI_MODEL_CACHE);
      await cache.put(
        AI_MODEL_URL,
        new Response(new Blob([combined.slice()], { type: 'application/octet-stream' }), {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      );
    } catch {
      // Ignore cache write errors in private/restricted browsing
    }
  }

  cachedModelBytes = combined;
  onProgress(100);
  return combined;
}

async function createAndVerifySession(
  ort: OrtModule,
  modelBytes: Uint8Array,
  signal?: AbortSignal,
  preferWasmOnly = false
): Promise<CachedAiSessionInfo> {
  type SessionAttempt = {
    label: string;
    provider: AiProvider;
    options: Record<string, unknown>;
  };

  const symbolicOverrides = {
    batch_size: 1,
    height: AI_FIXED_TILE_SIZE,
    width: AI_FIXED_TILE_SIZE,
  };

  const webgpuAttempts: SessionAttempt[] = [
    {
      label: 'webgpu(basic, no-mem-pattern)',
      provider: 'webgpu',
      options: {
        executionProviders: ['webgpu'],
        enableMemPattern: false,
        enableCpuMemArena: false,
        graphOptimizationLevel: 'basic',
      },
    },
    {
      label: 'webgpu(disabled, no-mem-pattern)',
      provider: 'webgpu',
      options: {
        executionProviders: ['webgpu'],
        enableMemPattern: false,
        enableCpuMemArena: false,
        graphOptimizationLevel: 'disabled',
      },
    },
    {
      label: 'webgpu(freeDimensionOverrides)',
      provider: 'webgpu',
      options: {
        executionProviders: ['webgpu'],
        enableMemPattern: false,
        enableCpuMemArena: false,
        graphOptimizationLevel: 'disabled',
        freeDimensionOverrides: symbolicOverrides,
      },
    },
  ];

  const wasmAttempt: SessionAttempt = {
    label: 'wasm(basic, no-mem-pattern)',
    provider: 'wasm',
    options: {
      executionProviders: ['wasm'],
      enableMemPattern: false,
      enableCpuMemArena: false,
      graphOptimizationLevel: 'basic',
    },
  };

  const attempts = preferWasmOnly ? [wasmAttempt] : [...webgpuAttempts, wasmAttempt];
  let lastError: unknown = null;

  for (const attempt of attempts) {
    if (signal?.aborted) {
      throw new Error('Cancelled');
    }
    let session: OrtSession | null = null;
    try {
      session = await ort.InferenceSession.create(modelBytes, attempt.options);
      const io = inspectSessionIo(session, AI_FIXED_TILE_SIZE);
      await warmupVerifySession(ort, session, io, AI_FIXED_TILE_SIZE);
      return {
        ort,
        session,
        provider: attempt.provider,
        modelName: AI_MODEL_NAME,
        io,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[AI Upscaler] Session attempt ${attempt.label} failed:`, err);
      if (session) {
        try {
          await session.release();
        } catch {
          // Ignore release failure
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Could not start AI inference session on WebGPU or WASM.');
}

export async function ensureWebGpuAiSession(
  onModelProgress: (pct: number | null) => void,
  signal?: AbortSignal,
  forceWasm = false
): Promise<CachedAiSessionInfo> {
  const ort = await loadOrtRuntimeFromCdn();

  if (cachedSessionInfo && (!forceWasm || cachedSessionInfo.provider === 'wasm')) {
    onModelProgress(100);
    return cachedSessionInfo;
  }

  if (cachedSessionInfo && forceWasm && cachedSessionInfo.provider !== 'wasm') {
    await disposeWebGpuAiSession();
  }

  const adapter = !forceWasm && navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  const gpuDevice = adapter ? await adapter.requestDevice().catch(() => null) : null;
  if (!forceWasm && !gpuDevice) {
    console.warn('[AI Upscaler] WebGPU device unavailable; falling back to WASM provider.');
  }

  const modelBytes = await fetchModelWithCacheAndProgress(onModelProgress, signal);
  if (signal?.aborted) {
    throw new Error('Cancelled');
  }

  const sessionInfo = await createAndVerifySession(
    ort,
    modelBytes,
    signal,
    forceWasm || !gpuDevice
  );
  cachedSessionInfo = sessionInfo;
  return sessionInfo;
}

export async function disposeWebGpuAiSession(): Promise<void> {
  const s = cachedSessionInfo?.session;
  cachedSessionInfo = null;
  if (s) {
    try {
      await s.release();
    } catch {
      // Ignore release errors
    }
  }
}

async function pickSupportedVideoCodec(
  width: number,
  height: number,
  framerate: number,
  bitrate: number
): Promise<{ webCodecsCodec: string; muxerCodec: 'avc' | 'vp9'; encoderFramerate: number }> {
  const candidates: Array<{ webCodecsCodec: string; muxerCodec: 'avc' | 'vp9' }> = [
    { webCodecsCodec: 'avc1.640033', muxerCodec: 'avc' },
    { webCodecsCodec: 'avc1.64002a', muxerCodec: 'avc' },
    { webCodecsCodec: 'avc1.4d0032', muxerCodec: 'avc' },
    { webCodecsCodec: 'avc1.420028', muxerCodec: 'avc' },
    { webCodecsCodec: 'vp09.00.41.08', muxerCodec: 'vp9' },
  ];

  const fpsRates = Number.isInteger(framerate)
    ? [framerate]
    : [framerate, Math.max(1, Math.round(framerate))];

  for (const rate of fpsRates) {
    for (const cand of candidates) {
      try {
        const check = await VideoEncoder.isConfigSupported({
          codec: cand.webCodecsCodec,
          width,
          height,
          bitrate,
          framerate: rate,
        });
        if (check.supported) {
          return { ...cand, encoderFramerate: rate };
        }
      } catch {
        // Try next codec candidate
      }
    }
  }

  throw new Error('Browser VideoEncoder does not support MP4/H.264/VP9 at target resolution.');
}

function seekVideoElement(video: HTMLVideoElement, timeSec: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'));
      return;
    }

    if (Math.abs(video.currentTime - timeSec) < 0.002 && video.readyState >= 2) {
      resolve();
      return;
    }

    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to decode source video frame.'));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Cancelled'));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Video frame seek timed out.'));
    }, 10_000);

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      video.currentTime = timeSec;
    } catch {
      cleanup();
      reject(new Error('Could not seek video frame.'));
    }
  });
}

export interface BrowserAiUpscaleParams {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  fps: number;
  duration: number;
  frameTimestampsSec?: number[];
  signal: AbortSignal;
  onModelProgress: (pct: number | null) => void;
  onFrameProgress: (info: {
    doneFrames: number;
    totalFrames: number;
    percent: number;
    etaSeconds: number | null;
    msPerFrame: number | null;
    provider: AiProvider;
    modelName: string;
  }) => void;
}

export async function runBrowserWebGpuUpscale(
  params: BrowserAiUpscaleParams
): Promise<{ blob: Blob; muxerCodec: 'avc' | 'vp9'; frameCount: number; provider: AiProvider }> {
  let sessionInfo = await ensureWebGpuAiSession(params.onModelProgress, params.signal);

  const gpuDevicePromise = navigator.gpu?.requestAdapter().then((a) => a?.requestDevice()).catch(() => null);
  let deviceLost = false;
  const watchedDevice = await gpuDevicePromise;
  if (watchedDevice) {
    watchedDevice.lost.then(() => {
      deviceLost = true;
    });
  }

  const videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';
  videoEl.crossOrigin = 'anonymous';
  videoEl.src = params.sourceUrl;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = params.sourceWidth;
  srcCanvas.height = params.sourceHeight;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });

  const upW = params.sourceWidth * AI_MODEL_SCALE;
  const upH = params.sourceHeight * AI_MODEL_SCALE;
  const upCanvas = document.createElement('canvas');
  upCanvas.width = upW;
  upCanvas.height = upH;
  const upCtx = upCanvas.getContext('2d');

  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = params.targetWidth;
  targetCanvas.height = params.targetHeight;
  const targetCtx = targetCanvas.getContext('2d');

  if (!srcCtx || !upCtx || !targetCtx) {
    throw new Error('Could not allocate canvas contexts for AI upscaling.');
  }

  const accumRgb = new Float32Array(upW * upH * 3);
  const accumWeight = new Float32Array(upW * upH);
  const upImageData = upCtx.createImageData(upW, upH);

  let encoder: VideoEncoder | null = null;
  let encoderError: Error | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      if (params.signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error('Could not load source video frames in browser.'));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Cancelled'));
      };
      const cleanup = () => {
        videoEl.removeEventListener('loadeddata', onReady);
        videoEl.removeEventListener('error', onErr);
        params.signal.removeEventListener('abort', onAbort);
      };
      videoEl.addEventListener('loadeddata', onReady, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
      params.signal.addEventListener('abort', onAbort, { once: true });
    });

    const realDuration =
      Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : params.duration;
    const safeFps = Number.isFinite(params.fps) && params.fps > 0.5 ? Math.min(120, params.fps) : 30;
    const schedule = computeFrameSchedule(realDuration, safeFps, params.frameTimestampsSec);
    const totalFrames = schedule.length;

    const bitrate =
      params.targetWidth * params.targetHeight >= 3840 * 2000
        ? 22_000_000
        : params.targetWidth * params.targetHeight >= 2560 * 1400
          ? 14_000_000
          : 8_000_000;

    const codecChoice = await pickSupportedVideoCodec(
      params.targetWidth,
      params.targetHeight,
      safeFps,
      bitrate
    );

    const target = new ArrayBufferTarget();
    // Omit frameRate so mp4-muxer uses 57600Hz timescale & preserves fractional/VFR frame timestamps
    const muxer = new Muxer({
      target,
      video: {
        codec: codecChoice.muxerCodec,
        width: params.targetWidth,
        height: params.targetHeight,
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
      },
      error: (err) => {
        encoderError = err instanceof Error ? err : new Error(String(err));
      },
    });

    encoder.configure({
      codec: codecChoice.webCodecsCodec,
      width: params.targetWidth,
      height: params.targetHeight,
      bitrate,
      framerate: codecChoice.encoderFramerate,
      latencyMode: 'quality',
    });

    const tiles = computeTileGrid(params.sourceWidth, params.sourceHeight, AI_FIXED_TILE_SIZE, AI_TILE_OVERLAP);
    const keyFrameInterval = Math.max(1, Math.round(safeFps * 2));
    const startedAt = performance.now();
    let loggedFirstTile = false;

    params.onFrameProgress({
      doneFrames: 0,
      totalFrames,
      percent: 3,
      etaSeconds: null,
      msPerFrame: null,
      provider: sessionInfo.provider,
      modelName: sessionInfo.modelName,
    });

    for (let i = 0; i < totalFrames; i++) {
      if (params.signal.aborted) {
        throw new Error('Cancelled');
      }
      if (deviceLost && sessionInfo.provider === 'webgpu') {
        sessionInfo = await ensureWebGpuAiSession(params.onModelProgress, params.signal, true);
        deviceLost = false;
      }
      if (encoderError) {
        throw encoderError;
      }

      const frameItem = schedule[i];
      await seekVideoElement(videoEl, frameItem.timestampSec, params.signal);

      srcCtx.drawImage(videoEl, 0, 0, params.sourceWidth, params.sourceHeight);
      const srcPixels = srcCtx.getImageData(0, 0, params.sourceWidth, params.sourceHeight).data;

      accumRgb.fill(0);
      accumWeight.fill(0);

      for (const tile of tiles) {
        if (params.signal.aborted) {
          throw new Error('Cancelled');
        }

        const runTileInference = async (info: CachedAiSessionInfo) => {
          const inputBuf = extractFixedRgbaTileToTensor(
            srcPixels,
            params.sourceWidth,
            tile.x,
            tile.y,
            tile.w,
            tile.h,
            AI_FIXED_TILE_SIZE,
            info.io.inputLayout
          );
          const inDims = buildInputTensorDims(info.io.inputLayout, AI_FIXED_TILE_SIZE);
          const inputTensor = new info.ort.Tensor(info.io.inputDtype, inputBuf, inDims);
          let results: Record<string, OrtTensor> | null = null;
          try {
            results = await info.session.run({ [info.io.inputName]: inputTensor });
            const outTensor = results[info.io.outputName];
            if (!loggedFirstTile) {
              loggedFirstTile = true;
              console.info('[AI Upscaler] First tile inference:', {
                provider: info.provider,
                model: info.modelName,
                inputShape: inDims,
                outputShape: Array.from(outTensor.dims),
              });
            }
            const outData = outTensor.data as Float32Array;
            blendFixedUpscaledTileIntoAccum(
              outData,
              tile.x,
              tile.y,
              tile.w,
              tile.h,
              params.sourceWidth,
              params.sourceHeight,
              AI_FIXED_TILE_SIZE,
              AI_MODEL_SCALE,
              AI_TILE_OVERLAP,
              info.io.outputLayout,
              accumRgb,
              accumWeight
            );
          } finally {
            inputTensor.dispose();
            if (results) {
              for (const tensor of Object.values(results)) {
                try {
                  tensor.dispose();
                } catch {
                  // Ignore tensor disposal warning
                }
              }
            }
          }
        };

        try {
          await runTileInference(sessionInfo);
        } catch (tileErr) {
          if (sessionInfo.provider === 'webgpu') {
            console.warn('[AI Upscaler] WebGPU tile failed; switching to WASM provider:', tileErr);
            sessionInfo = await ensureWebGpuAiSession(params.onModelProgress, params.signal, true);
            await runTileInference(sessionInfo);
          } else {
            throw tileErr;
          }
        }
      }

      finalizeAccumToRgba(accumRgb, accumWeight, upImageData.data);
      upCtx.putImageData(upImageData, 0, 0);

      targetCtx.imageSmoothingEnabled = true;
      targetCtx.imageSmoothingQuality = 'high';
      targetCtx.drawImage(upCanvas, 0, 0, params.targetWidth, params.targetHeight);

      const videoFrame = new VideoFrame(targetCanvas, {
        timestamp: frameItem.timestampUs,
        duration: frameItem.durationUs,
      });
      try {
        encoder.encode(videoFrame, { keyFrame: i % keyFrameInterval === 0 });
      } finally {
        videoFrame.close();
      }

      while (encoder.encodeQueueSize > 4) {
        if (params.signal.aborted) throw new Error('Cancelled');
        await new Promise((r) => setTimeout(r, 8));
      }

      const elapsedMs = performance.now() - startedAt;
      const doneFrames = i + 1;
      const msPerFrame = Math.round(elapsedMs / doneFrames);
      const remainingFrames = totalFrames - doneFrames;
      const etaSeconds =
        doneFrames >= 2 && elapsedMs > 200
          ? Math.max(1, Math.round(((elapsedMs / 1000) / doneFrames) * remainingFrames))
          : null;

      params.onFrameProgress({
        doneFrames,
        totalFrames,
        percent: Math.min(92, Math.max(3, Math.round((doneFrames / totalFrames) * 90))),
        etaSeconds,
        msPerFrame,
        provider: sessionInfo.provider,
        modelName: sessionInfo.modelName,
      });

      await new Promise((r) => setTimeout(r, 0));
    }

    await encoder.flush();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return {
      blob,
      muxerCodec: codecChoice.muxerCodec,
      frameCount: totalFrames,
      provider: sessionInfo.provider,
    };
  } catch (err) {
    if (err instanceof Error && err.message !== 'Cancelled') {
      await disposeWebGpuAiSession();
    }
    throw err;
  } finally {
    if (encoder && encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch {
        // Ignore close error
      }
    }
    videoEl.removeAttribute('src');
    videoEl.load();
    srcCanvas.width = 0;
    srcCanvas.height = 0;
    upCanvas.width = 0;
    upCanvas.height = 0;
    targetCanvas.width = 0;
    targetCanvas.height = 0;
  }
}
