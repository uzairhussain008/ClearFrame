import {
  ORT_CDN_BASE,
  ORT_CDN_VERSION,
  ORT_WEBGPU_CDN_URL,
  type AiProvider,
} from './webgpuUpscaler';
import {
  applyMatchedSurroundingGrain,
  compositeFeatheredRegion,
  computeMaskBoundingBox,
  dilateBinaryMask,
  extractMaskRegion,
  extractRgbaRegion,
  type MaskBoundingBox,
} from './photoInpaint';
import { lanczosUpscaleRgba } from './photoUpscaler';

export const LAMA_MODEL_NAME = 'lama_int4_int8_r4.onnx';
export const LAMA_MODEL_URL =
  'https://huggingface.co/othytenk/lama-int4-int8/resolve/main/lama_int4_int8_r4.onnx';
export const LAMA_MODEL_SIZE_BYTES = 36_931_151;
export const LAMA_MODEL_SIZE_TOLERANCE_BYTES = 512_000;
export const LAMA_MODEL_SIZE_LABEL = '35.2 MB';
export const LAMA_MODEL_CACHE = 'clearframe-ai-models-v2';
export const LAMA_INPUT_SIZE = 512;

function isExpectedModelSize(byteLength: number): boolean {
  return (
    byteLength >= LAMA_MODEL_SIZE_BYTES - LAMA_MODEL_SIZE_TOLERANCE_BYTES &&
    byteLength <= LAMA_MODEL_SIZE_BYTES + LAMA_MODEL_SIZE_TOLERANCE_BYTES
  );
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.byteLength && shift <= 49) {
    const byte = bytes[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7;
  }
  return null;
}

/**
 * Validates that downloaded bytes match the expected LaMa ONNX file size (~36.93 MB)
 * and begin with a valid ONNX ModelProto protobuf header rather than HTML/JSON/corrupt data.
 */
export function validateLamaModelBytes(
  bytes: Uint8Array,
  contentType?: string | null
): { valid: boolean; reason?: string } {
  if (contentType) {
    const lower = contentType.toLowerCase();
    if (
      lower.startsWith('text/') ||
      lower.includes('html') ||
      lower.includes('json') ||
      lower.includes('xml')
    ) {
      return {
        valid: false,
        reason: 'The server returned an unexpected non-binary response instead of the ONNX model file.',
      };
    }
  }

  if (!bytes || bytes.byteLength === 0) {
    return {
      valid: false,
      reason: 'The downloaded HD AI model file was empty.',
    };
  }

  if (!isExpectedModelSize(bytes.byteLength)) {
    const gotMb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      reason: `Downloaded HD AI model size mismatch (${gotMb} MB received; expected ~${LAMA_MODEL_SIZE_LABEL}).`,
    };
  }

  // Reject common non-ONNX signatures (HTML, JSON, ZIP, GZIP, Git-LFS pointer, PDF, PNG)
  const b0 = bytes[0];
  const b1 = bytes[1];
  const headAscii = String.fromCharCode(...bytes.slice(0, Math.min(32, bytes.byteLength))).trimStart();
  if (
    headAscii.startsWith('<') ||
    headAscii.startsWith('{') ||
    headAscii.startsWith('[') ||
    headAscii.startsWith('version https://git-lfs') ||
    (b0 === 0x50 && b1 === 0x4b) ||
    (b0 === 0x1f && b1 === 0x8b) ||
    headAscii.startsWith('%PDF')
  ) {
    return {
      valid: false,
      reason: 'The downloaded file is not a valid ONNX model.',
    };
  }

  // Inspect top-level ONNX ModelProto protobuf tags
  let offset = 0;
  let sawValidIrVersion = false;
  let sawGraph = false;
  const maxInspect = Math.min(bytes.byteLength, 4096);

  for (let fields = 0; fields < 16 && offset < maxInspect; fields++) {
    const key = readVarint(bytes, offset);
    if (!key || key.value <= 0) break;
    offset = key.nextOffset;

    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value & 0x07;
    if (fieldNumber < 1 || fieldNumber > 20) {
      return { valid: false, reason: 'The downloaded file is not a valid ONNX model.' };
    }

    if (wireType === 0) {
      const val = readVarint(bytes, offset);
      if (!val) {
        return { valid: false, reason: 'The downloaded file is not a valid ONNX model.' };
      }
      if (fieldNumber === 1 && val.value >= 1 && val.value <= 32) {
        sawValidIrVersion = true;
      }
      offset = val.nextOffset;
    } else if (wireType === 2) {
      const len = readVarint(bytes, offset);
      if (!len || len.value < 0 || len.nextOffset + len.value > bytes.byteLength) {
        return { valid: false, reason: 'The downloaded ONNX model appears truncated or corrupted.' };
      }
      if (fieldNumber === 7 && len.value > 64) {
        sawGraph = true;
        break;
      }
      offset = len.nextOffset + len.value;
    } else {
      return { valid: false, reason: 'The downloaded file is not a valid ONNX model.' };
    }
  }

  if (!sawValidIrVersion && !sawGraph) {
    return {
      valid: false,
      reason: 'The downloaded file is not a valid ONNX model.',
    };
  }

  return { valid: true };
}

interface LamaOrtTensor {
  dims: ReadonlyArray<number>;
  data: Float32Array;
  dispose: () => void;
}

interface LamaOrtSession {
  inputNames: ReadonlyArray<string>;
  outputNames: ReadonlyArray<string>;
  run: (feeds: Record<string, LamaOrtTensor>) => Promise<Record<string, LamaOrtTensor>>;
}

interface LamaOrtModule {
  env: {
    wasm: {
      wasmPaths?: string;
      numThreads?: number;
      proxy?: boolean;
    };
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: ReadonlyArray<number>) => LamaOrtTensor;
  InferenceSession: {
    create: (modelBytes: Uint8Array, options?: Record<string, unknown>) => Promise<LamaOrtSession>;
  };
}

let cachedOrt: LamaOrtModule | null = null;
let cachedLamaBytes: Uint8Array | null = null;
let cachedLamaSession: { ort: LamaOrtModule; session: LamaOrtSession; provider: AiProvider } | null = null;

async function deleteCachedLamaModel(): Promise<void> {
  cachedLamaBytes = null;
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(LAMA_MODEL_CACHE);
    await cache.delete(LAMA_MODEL_URL);
  } catch {
    // Ignore cache deletion failure
  }
}

export async function isLamaModelCached(): Promise<boolean> {
  if (cachedLamaSession || (cachedLamaBytes && validateLamaModelBytes(cachedLamaBytes).valid)) {
    return true;
  }
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(LAMA_MODEL_CACHE);
    const match = await cache.match(LAMA_MODEL_URL);
    if (!match || !match.ok) return false;
    const len = Number(match.headers.get('content-length') || 0);
    return len === 0 || isExpectedModelSize(len);
  } catch {
    return false;
  }
}

async function loadLamaOrtFromCdn(): Promise<LamaOrtModule> {
  if (cachedOrt) return cachedOrt;
  const imported = (await import(/* @vite-ignore */ ORT_WEBGPU_CDN_URL)) as
    | LamaOrtModule
    | { default?: LamaOrtModule };
  const ort = ('InferenceSession' in imported ? imported : imported.default) as LamaOrtModule | undefined;
  if (!ort || !ort.InferenceSession || !ort.Tensor || !ort.env?.wasm) {
    throw new Error(`ONNX Runtime Web ${ORT_CDN_VERSION} module failed to initialize.`);
  }
  ort.env.wasm.wasmPaths = ORT_CDN_BASE;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  cachedOrt = ort;
  return ort;
}

async function downloadLamaModelBytes(
  onDownloadProgress: (percent: number, loadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (cachedLamaBytes && validateLamaModelBytes(cachedLamaBytes).valid) {
    onDownloadProgress(100, cachedLamaBytes.byteLength, cachedLamaBytes.byteLength);
    return cachedLamaBytes;
  }
  cachedLamaBytes = null;

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(LAMA_MODEL_CACHE);
      const cached = await cache.match(LAMA_MODEL_URL);
      if (cached && cached.ok) {
        const buf = new Uint8Array(await cached.arrayBuffer());
        if (validateLamaModelBytes(buf, cached.headers.get('content-type')).valid) {
          cachedLamaBytes = buf;
          onDownloadProgress(100, buf.byteLength, buf.byteLength);
          return buf;
        }
        await cache.delete(LAMA_MODEL_URL);
      }
    } catch {
      // Cache lookup failed; fall back to network fetch
    }
  }

  let response: Response;
  try {
    response = await fetch(LAMA_MODEL_URL, { mode: 'cors', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Could not download the HD AI model (network error).');
  }

  if (!response.ok) {
    throw new Error(`Could not download the HD AI model (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType) {
    const lower = contentType.toLowerCase();
    if (lower.startsWith('text/') || lower.includes('html') || lower.includes('json')) {
      throw new Error('The download did not return a valid ONNX model file.');
    }
  }

  const headerLen = Number(response.headers.get('content-length') || 0);
  if (headerLen > 0 && !isExpectedModelSize(headerLen)) {
    const gotMb = (headerLen / (1024 * 1024)).toFixed(1);
    throw new Error(
      `HD AI model file size mismatch (${gotMb} MB reported; expected ~${LAMA_MODEL_SIZE_LABEL}).`
    );
  }

  const totalBytes = headerLen > 0 ? headerLen : LAMA_MODEL_SIZE_BYTES;
  const reader = response.body?.getReader();

  let bytes: Uint8Array;
  if (!reader) {
    const ab = await response.arrayBuffer();
    bytes = new Uint8Array(ab);
    onDownloadProgress(100, bytes.byteLength, bytes.byteLength);
  } else {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        loaded += value.byteLength;
        if (loaded > LAMA_MODEL_SIZE_BYTES + LAMA_MODEL_SIZE_TOLERANCE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`Downloaded HD AI model exceeded expected ${LAMA_MODEL_SIZE_LABEL} size.`);
        }
        chunks.push(value);
        const pct = Math.min(99, Math.round((loaded / totalBytes) * 100));
        onDownloadProgress(pct, loaded, totalBytes);
      }
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    onDownloadProgress(100, loaded, Math.max(loaded, totalBytes));
  }

  const validation = validateLamaModelBytes(bytes, contentType);
  if (!validation.valid) {
    throw new Error(validation.reason || 'Downloaded file is not a valid ONNX model.');
  }

  cachedLamaBytes = bytes;

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(LAMA_MODEL_CACHE);
      const existing = await cache.match(LAMA_MODEL_URL);
      const existingLen = existing ? Number(existing.headers.get('content-length') || 0) : 0;
      if (!existing || !isExpectedModelSize(existingLen)) {
        const copyForCache = new Uint8Array(bytes.byteLength);
        copyForCache.set(bytes);
        await cache.put(
          LAMA_MODEL_URL,
          new Response(copyForCache.buffer, {
            status: 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.byteLength),
            },
          })
        );
      }
    } catch {
      // Non-fatal if browser storage quota blocks caching
    }
  }

  return bytes;
}

async function ensureLamaSession(
  onProgress: (percent: number, stage: string) => void,
  signal?: AbortSignal
): Promise<{ ort: LamaOrtModule; session: LamaOrtSession; provider: AiProvider }> {
  if (cachedLamaSession) {
    return cachedLamaSession;
  }

  onProgress(5, 'Loading ONNX Runtime Web...');
  const ort = await loadLamaOrtFromCdn();

  const bytes = await downloadLamaModelBytes(
    (pct, loaded, total) => {
      const loadedMb = (loaded / (1024 * 1024)).toFixed(1);
      const totalMb = (total / (1024 * 1024)).toFixed(1);
      onProgress(
        Math.min(70, 8 + Math.round(pct * 0.62)),
        `Downloading HD LaMa model (${loadedMb} / ${totalMb} MB · ${pct}%)...`
      );
    },
    signal
  );

  if (signal?.aborted) {
    throw new Error('Cancelled');
  }

  onProgress(74, 'Compiling HD LaMa model in browser...');

  let hasWebGpu = false;
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      hasWebGpu = Boolean(adapter);
    } catch {
      hasWebGpu = false;
    }
  }

  const extraOpts = { session: { disable_quant_qdq: '1' } };
  if (hasWebGpu) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        extra: extraOpts,
      });
      cachedLamaSession = { ort, session, provider: 'webgpu' };
      return cachedLamaSession;
    } catch {
      // Fall through to WASM execution provider
    }
  }

  try {
    const wasmSession = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      extra: extraOpts,
    });
    cachedLamaSession = { ort, session: wasmSession, provider: 'wasm' };
    return cachedLamaSession;
  } catch {
    await deleteCachedLamaModel();
    throw new Error('The downloaded file could not be loaded as a valid ONNX model.');
  }
}

function resizeMaskNearest(
  srcMask: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) * srcH) / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) * srcW) / dstW));
      out[dy * dstW + dx] = srcMask[sy * srcW + sx] > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Computes a square padded crop around the mask bounding box, at least 512px if image permits,
 * clamped to image dimensions.
 */
function computeSquareCropBox(
  mask: Uint8Array,
  imgW: number,
  imgH: number
): MaskBoundingBox | null {
  const tight = computeMaskBoundingBox(mask, imgW, imgH, 0);
  if (!tight) return null;

  const maskMax = Math.max(tight.width, tight.height);
  const desiredSide = Math.max(LAMA_INPUT_SIZE, Math.round(maskMax * 1.85));
  const cropW = Math.min(imgW, desiredSide);
  const cropH = Math.min(imgH, desiredSide);

  const cx = Math.round((tight.x0 + tight.x1) * 0.5);
  const cy = Math.round((tight.y0 + tight.y1) * 0.5);

  const x0 = Math.max(0, Math.min(imgW - cropW, cx - Math.floor(cropW / 2)));
  const y0 = Math.max(0, Math.min(imgH - cropH, cy - Math.floor(cropH / 2)));

  return {
    x0,
    y0,
    x1: x0 + cropW - 1,
    y1: y0 + cropH - 1,
    width: cropW,
    height: cropH,
    maskCount: tight.maskCount,
  };
}

export interface LamaInpaintOptions {
  srcRgba: Uint8ClampedArray;
  mask: Uint8Array;
  width: number;
  height: number;
  dilatePx?: number;
  featherPx?: number;
  signal?: AbortSignal;
  onProgress: (percent: number, stage: string) => void;
}

export async function runLamaHdInpaintRgba(opts: LamaInpaintOptions): Promise<{
  rgba: Uint8ClampedArray;
  provider: AiProvider;
}> {
  const {
    srcRgba,
    mask,
    width,
    height,
    dilatePx = 2,
    featherPx = 4,
    signal,
    onProgress,
  } = opts;

  const workingMask =
    dilatePx > 0 ? dilateBinaryMask(mask, width, height, Math.min(5, Math.round(dilatePx))) : new Uint8Array(mask);

  const cropBox = computeSquareCropBox(workingMask, width, height);
  if (!cropBox) {
    return { rgba: new Uint8ClampedArray(srcRgba), provider: 'wasm' };
  }

  const { ort, session, provider } = await ensureLamaSession(onProgress, signal);
  if (signal?.aborted) {
    throw new Error('Cancelled');
  }

  onProgress(80, `Running HD LaMa (${provider.toUpperCase()}) on 512×512 crop...`);

  const cropRgba = extractRgbaRegion(srcRgba, width, cropBox);
  const cropMask = extractMaskRegion(workingMask, width, cropBox);

  // Resize or pad crop into exact 512x512 LaMa input tensors
  let inputRgba512: Uint8ClampedArray;
  let inputMask512: Uint8Array;
  const needResize = cropBox.width !== LAMA_INPUT_SIZE || cropBox.height !== LAMA_INPUT_SIZE;

  if (!needResize) {
    inputRgba512 = cropRgba;
    inputMask512 = cropMask;
  } else {
    inputRgba512 = lanczosUpscaleRgba(cropRgba, cropBox.width, cropBox.height, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE);
    inputMask512 = resizeMaskNearest(cropMask, cropBox.width, cropBox.height, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE);
  }

  const plane = LAMA_INPUT_SIZE * LAMA_INPUT_SIZE;
  const imageTensorData = new Float32Array(3 * plane);
  const maskTensorData = new Float32Array(plane);

  for (let i = 0; i < plane; i++) {
    const off = i * 4;
    imageTensorData[i] = inputRgba512[off] / 255;
    imageTensorData[plane + i] = inputRgba512[off + 1] / 255;
    imageTensorData[plane * 2 + i] = inputRgba512[off + 2] / 255;
    maskTensorData[i] = inputMask512[i] > 0 ? 1 : 0;
  }

  const imageInputName = session.inputNames.find((n) => n.toLowerCase().includes('image')) || session.inputNames[0];
  const maskInputName = session.inputNames.find((n) => n.toLowerCase().includes('mask')) || session.inputNames[1];
  const outputName = session.outputNames[0];

  const imageTensor = new ort.Tensor('float32', imageTensorData, [1, 3, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE]);
  const maskTensor = new ort.Tensor('float32', maskTensorData, [1, 1, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE]);

  let results: Record<string, LamaOrtTensor>;
  try {
    results = await session.run({
      [imageInputName]: imageTensor,
      [maskInputName]: maskTensor,
    });
  } finally {
    imageTensor.dispose();
    maskTensor.dispose();
  }

  const outTensor = results[outputName];
  const outFloat = outTensor.data;
  const outRgba512 = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i++) {
    const off = i * 4;
    // Per othytenk/lama-int4-int8 contract, output is already in [0, 255]
    outRgba512[off] = Math.max(0, Math.min(255, Math.round(outFloat[i])));
    outRgba512[off + 1] = Math.max(0, Math.min(255, Math.round(outFloat[plane + i])));
    outRgba512[off + 2] = Math.max(0, Math.min(255, Math.round(outFloat[plane * 2 + i])));
    outRgba512[off + 3] = 255;
  }

  for (const t of Object.values(results)) {
    try {
      t.dispose();
    } catch {
      // Ignore disposal errors
    }
  }

  onProgress(92, 'Matching grain and blending back at full resolution...');

  let restoredCropRgba: Uint8ClampedArray = needResize
    ? lanczosUpscaleRgba(outRgba512, LAMA_INPUT_SIZE, LAMA_INPUT_SIZE, cropBox.width, cropBox.height)
    : outRgba512;

  // Re-inject surrounding high-frequency grain & blend cleanly with feathered mask edge
  restoredCropRgba = applyMatchedSurroundingGrain(restoredCropRgba, cropMask, cropBox.width, cropBox.height);
  const blended = compositeFeatheredRegion(
    srcRgba,
    restoredCropRgba,
    cropMask,
    width,
    cropBox,
    featherPx
  );

  onProgress(100, 'HD watermark removal complete');
  return { rgba: blended, provider };
}
