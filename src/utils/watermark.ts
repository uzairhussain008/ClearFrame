export const MAX_VIDEO_SIZE_MB = 300;
export const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;

export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.m4v',
] as const;

export type RemovalMode = 'delogo' | 'blur' | 'pixelate';
export type UpscalePreset = 'original' | '1080p' | '2k' | '4k';

export interface WatermarkRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  startTime?: number | null;
  endTime?: number | null;
}

export interface VideoMetadata {
  videoId: string;
  originalName: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  previewUrl: string;
  isSample?: boolean;
  suggestedRegion?: Omit<WatermarkRegion, 'id' | 'label'>;
}

export interface ProcessingJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  queuePosition?: number;
  error?: string;
  outputUrl?: string;
  downloadUrl?: string;
  outputSize?: number;
  outputWidth?: number;
  outputHeight?: number;
  upscale?: UpscalePreset;
  regionsCount?: number;
  processingMs?: number;
}

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

export interface UpscaleDimensions {
  width: number;
  height: number;
  upscaled: boolean;
  label: string;
}

const UPSCALE_TARGETS: Record<Exclude<UpscalePreset, 'original'>, { long: number; short: number; label: string }> = {
  '1080p': { long: 1920, short: 1080, label: '1080p Full HD' },
  '2k': { long: 2560, short: 1440, label: '2K QHD' },
  '4k': { long: 3840, short: 2160, label: '4K UHD' },
};

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export interface DisplayDimensions {
  width: number;
  height: number;
  rotation: number;
  sarNum: number;
  sarDen: number;
  needsSarNormalize: boolean;
}

export function parseSampleAspectRatio(sar?: string | null): { sarNum: number; sarDen: number } {
  if (!sar || typeof sar !== 'string') return { sarNum: 1, sarDen: 1 };
  const match = sar.trim().match(/^(\d+)\s*[:/]\s*(\d+)$/);
  if (!match) return { sarNum: 1, sarDen: 1 };
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    return { sarNum: 1, sarDen: 1 };
  }
  return { sarNum: num, sarDen: den };
}

export function resolveDisplayDimensions(
  codedWidth: number,
  codedHeight: number,
  sampleAspectRatio?: string | null,
  rawRotationDeg?: number | string | null
): DisplayDimensions {
  const rawW = Math.max(2, Math.round(codedWidth));
  const rawH = Math.max(2, Math.round(codedHeight));
  const { sarNum, sarDen } = parseSampleAspectRatio(sampleAspectRatio);
  const needsSarNormalize = sarNum !== sarDen;

  // Apply pixel aspect ratio in coded space before display rotation
  const parW = needsSarNormalize ? toEven((rawW * sarNum) / sarDen) : toEven(rawW);
  const parH = toEven(rawH);

  const parsedRot = Number(rawRotationDeg ?? 0);
  const normalizedRot = Number.isFinite(parsedRot)
    ? ((Math.round(parsedRot) % 360) + 360) % 360
    : 0;
  const quarterTurns = Math.round(normalizedRot / 90) % 4;
  const swapAxes = quarterTurns === 1 || quarterTurns === 3;

  return {
    width: swapAxes ? parH : parW,
    height: swapAxes ? parW : parH,
    rotation: normalizedRot,
    sarNum,
    sarDen,
    needsSarNormalize,
  };
}

export function computeUpscaleDimensions(
  sourceWidth: number,
  sourceHeight: number,
  preset: UpscalePreset
): UpscaleDimensions {
  const safeW = toEven(Math.max(2, sourceWidth));
  const safeH = toEven(Math.max(2, sourceHeight));

  if (preset === 'original') {
    return { width: safeW, height: safeH, upscaled: false, label: 'Original' };
  }

  const target = UPSCALE_TARGETS[preset];
  const longSide = Math.max(safeW, safeH);
  const shortSide = Math.min(safeW, safeH);
  const scale = Math.min(target.long / longSide, target.short / shortSide);

  // Never downscale if source already meets or exceeds the target resolution
  if (!Number.isFinite(scale) || scale <= 1.01) {
    return {
      width: safeW,
      height: safeH,
      upscaled: false,
      label: 'Original (Already ≥ Target)',
    };
  }

  let outW = toEven(safeW * scale);
  let outH = toEven(safeH * scale);

  // Strictly guarantee orientation preservation (portrait, landscape, or square)
  if (safeW === safeH) {
    outH = outW;
  } else if (safeW < safeH && outW >= outH) {
    outW = Math.max(2, outH - 2);
  } else if (safeW > safeH && outH >= outW) {
    outH = Math.max(2, outW - 2);
  }

  return {
    width: outW,
    height: outH,
    upscaled: true,
    label: target.label,
  };
}

export function getFileExtension(filename: string): string {
  const trimmed = filename.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf('.');
  return dotIndex >= 0 ? trimmed.slice(dotIndex) : '';
}

export function validateVideoFile(file: {
  name: string;
  size: number;
  type?: string;
}): FileValidationResult {
  if (!file || typeof file.name !== 'string' || !file.name.trim()) {
    return { valid: false, error: 'Please choose a valid video file.' };
  }

  if (file.size <= 0) {
    return { valid: false, error: 'The selected file is empty (0 bytes).' };
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return {
      valid: false,
      error: `File is ${formatBytes(file.size)}, which exceeds the ${MAX_VIDEO_SIZE_MB} MB free limit.`,
    };
  }

  const ext = getFileExtension(file.name);
  const hasSupportedExt = (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
  const isVideoMime = Boolean(file.type && file.type.startsWith('video/'));

  if (!hasSupportedExt && !isVideoMime) {
    return {
      valid: false,
      error: `Unsupported file format (${ext || 'unknown'}). Upload MP4, MOV, WebM, MKV, AVI, or M4V.`,
    };
  }

  return { valid: true };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.max(1, Math.round(kb))} KB`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) {
    return `${mb.toFixed(0)} MB`;
  }
  return `${mb.toFixed(1)} MB`;
}

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0';
  const totalTenths = Math.round(seconds * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return `${mm}:${ss}.${tenths}`;
}

export function clampRegion(
  region: WatermarkRegion,
  videoWidth: number,
  videoHeight: number
): WatermarkRegion {
  const safeWidth = Math.max(32, Math.round(videoWidth));
  const safeHeight = Math.max(32, Math.round(videoHeight));
  const minSize = 12;

  const maxBoxW = Math.max(minSize, safeWidth - 2);
  const maxBoxH = Math.max(minSize, safeHeight - 2);

  let w = Math.min(maxBoxW, Math.max(minSize, Math.round(region.w)));
  let h = Math.min(maxBoxH, Math.max(minSize, Math.round(region.h)));

  // FFmpeg delogo requires at least 1px margin from all frame borders
  let x = Math.round(region.x);
  let y = Math.round(region.y);

  if (x < 1) x = 1;
  if (y < 1) y = 1;

  if (x + w > safeWidth - 1) {
    x = Math.max(1, safeWidth - 1 - w);
  }
  if (y + h > safeHeight - 1) {
    y = Math.max(1, safeHeight - 1 - h);
  }

  w = Math.min(w, safeWidth - 1 - x);
  h = Math.min(h, safeHeight - 1 - y);

  return {
    ...region,
    x,
    y,
    w: Math.max(minSize, w),
    h: Math.max(minSize, h),
  };
}

function buildEnableClause(
  startTime?: number | null,
  endTime?: number | null,
  duration?: number
): string {
  const hasStart = typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0.05;
  const hasEnd =
    typeof endTime === 'number' &&
    Number.isFinite(endTime) &&
    (!duration || endTime < duration - 0.05);

  if (!hasStart && !hasEnd) return '';

  const start = hasStart ? Math.max(0, Number(startTime!.toFixed(2))) : 0;
  const end = hasEnd
    ? Math.max(start + 0.1, Number(endTime!.toFixed(2)))
    : Number(((duration ?? 86400) + 1).toFixed(2));

  return `enable='between(t,${start},${end})'`;
}

export interface BuildFilterOptions {
  upscale?: UpscalePreset;
  detailEnhance?: boolean;
  sarNormalize?: boolean;
  nnediWeightsPath?: string;
  useNnedi?: boolean;
}

function escapeFfmpegPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function buildFfmpegFilterGraph(
  regions: WatermarkRegion[],
  mode: RemovalMode,
  videoWidth: number,
  videoHeight: number,
  duration?: number,
  options?: BuildFilterOptions
): { filterComplex: string; outputLabel: string; outputWidth: number; outputHeight: number; upscaled: boolean } {
  const safeW = toEven(Math.max(2, videoWidth));
  const safeH = toEven(Math.max(2, videoHeight));
  const upscalePreset: UpscalePreset = options?.upscale ?? 'original';
  const detailEnhance = options?.detailEnhance ?? true;
  const targetDims = computeUpscaleDimensions(safeW, safeH, upscalePreset);

  if ((!regions || regions.length === 0) && !targetDims.upscaled) {
    throw new Error('Select at least one watermark region or choose an upscale resolution.');
  }

  const clamped = (regions ?? []).map((r) => clampRegion(r, safeW, safeH));
  const steps: string[] = [];
  let currentLabel = '0:v';

  // Normalize device pixel formats (e.g. 10-bit HDR, yuvj420p, rgba, yuva420p) before filter stages
  if (options?.sarNormalize) {
    steps.push(`[${currentLabel}]format=yuv420p,scale=${safeW}:${safeH}:flags=lanczos,setsar=1[v_norm]`);
    currentLabel = 'v_norm';
  } else {
    steps.push(`[${currentLabel}]format=yuv420p[v_norm]`);
    currentLabel = 'v_norm';
  }

  clamped.forEach((region, idx) => {
    const nextLabel = `v_${idx + 1}`;
    const enableClause = buildEnableClause(region.startTime, region.endTime, duration);

    if (mode === 'delogo') {
      const params = [
        `x=${region.x}`,
        `y=${region.y}`,
        `w=${region.w}`,
        `h=${region.h}`,
        'show=0',
      ];
      if (enableClause) params.push(enableClause);
      steps.push(`[${currentLabel}]delogo=${params.join(':')}[${nextLabel}]`);
    } else if (mode === 'blur') {
      const baseLabel = `base_${idx}`;
      const srcLabel = `psrc_${idx}`;
      const patchLabel = `patch_${idx}`;
      const blurRadius = Math.max(6, Math.min(24, Math.round(Math.min(region.w, region.h) / 5)));
      const overlayParams = [`x=${region.x}`, `y=${region.y}`];
      if (enableClause) overlayParams.push(enableClause);

      steps.push(`[${currentLabel}]split=2[${baseLabel}][${srcLabel}]`);
      steps.push(
        `[${srcLabel}]crop=${region.w}:${region.h}:${region.x}:${region.y},boxblur=luma_radius=${blurRadius}:luma_power=2:chroma_radius=${blurRadius}:chroma_power=2[${patchLabel}]`
      );
      steps.push(`[${baseLabel}][${patchLabel}]overlay=${overlayParams.join(':')}[${nextLabel}]`);
    } else {
      const baseLabel = `base_${idx}`;
      const srcLabel = `psrc_${idx}`;
      const patchLabel = `patch_${idx}`;
      const blockW = Math.max(2, Math.round(region.w / 10));
      const blockH = Math.max(2, Math.round(region.h / 10));
      const overlayParams = [`x=${region.x}`, `y=${region.y}`];
      if (enableClause) overlayParams.push(enableClause);

      steps.push(`[${currentLabel}]split=2[${baseLabel}][${srcLabel}]`);
      steps.push(
        `[${srcLabel}]crop=${region.w}:${region.h}:${region.x}:${region.y},scale=${blockW}:${blockH}:flags=neighbor,scale=${region.w}:${region.h}:flags=neighbor[${patchLabel}]`
      );
      steps.push(`[${baseLabel}][${patchLabel}]overlay=${overlayParams.join(':')}[${nextLabel}]`);
    }

    currentLabel = nextLabel;
  });

  const finalLabel = 'vout';
  if (targetDims.upscaled) {
    const scaleRatio = Math.max(targetDims.width / safeW, targetDims.height / safeH);
    const sourcePixels = safeW * safeH;
    const filterStages: string[] = [];

    if (detailEnhance) {
      // Stage 1: Remove block/compression artifacts before any enlargement
      filterStages.push('deblock=filter=weak:block=4');
      // Stage 2: Gentle spatio-temporal denoising to reduce compression grain without smearing text or textures
      filterStages.push(
        scaleRatio >= 1.8 || sourcePixels <= 640 * 640
          ? 'hqdn3d=1.1:0.8:1.6:1.2'
          : 'hqdn3d=0.6:0.4:0.9:0.7'
      );

      // Stage 3: 2D NNEDI3 Neural Edge-Directed Super-Resolution (2x vertical + 2x horizontal)
      const useNnedi = options?.useNnedi !== false;
      if (useNnedi && options?.nnediWeightsPath && sourcePixels <= 1920 * 1080 * 1.05) {
        const weights = escapeFfmpegPath(options.nnediWeightsPath);
        const isSmallSource = sourcePixels <= 640 * 640;
        const nns = isSmallSource ? 'n32' : 'n16';
        const nsize = isSmallSource ? 's16x4' : 's8x4';
        const nnediOpt = `weights='${weights}':field=t:deint=all:nsize=${nsize}:nns=${nns}:qual=fast:pscrn=new2`;
        filterStages.push(
          `scale=iw:ih*2:flags=neighbor`,
          `nnedi=${nnediOpt}`,
          `transpose=1`,
          `scale=iw:ih*2:flags=neighbor`,
          `nnedi=${nnediOpt}`,
          `transpose=2`
        );
      }

      // Stage 4: Exact aspect-safe Lanczos target sizing, square SAR=1, and natural balanced sharpening without halos
      filterStages.push(`scale=${targetDims.width}:${targetDims.height}:flags=lanczos`);
      filterStages.push('setsar=1');
      filterStages.push(
        scaleRatio >= 1.8
          ? 'unsharp=5:5:0.38:3:3:0.10,cas=strength=0.28'
          : 'unsharp=5:5:0.30:3:3:0.08,cas=strength=0.24'
      );
    } else {
      filterStages.push(`scale=${targetDims.width}:${targetDims.height}:flags=lanczos`);
      filterStages.push('setsar=1');
    }

    steps.push(`[${currentLabel}]${filterStages.join(',')}[${finalLabel}]`);
    return {
      filterComplex: steps.join(';'),
      outputLabel: `[${finalLabel}]`,
      outputWidth: targetDims.width,
      outputHeight: targetDims.height,
      upscaled: true,
    };
  }

  const needsEvenCrop = videoWidth % 2 !== 0 || videoHeight % 2 !== 0;
  if (needsEvenCrop) {
    steps.push(`[${currentLabel}]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[${finalLabel}]`);
    return {
      filterComplex: steps.join(';'),
      outputLabel: `[${finalLabel}]`,
      outputWidth: targetDims.width,
      outputHeight: targetDims.height,
      upscaled: false,
    };
  }

  steps.push(`[${currentLabel}]setsar=1[${finalLabel}]`);
  return {
    filterComplex: steps.join(';'),
    outputLabel: `[${finalLabel}]`,
    outputWidth: targetDims.width,
    outputHeight: targetDims.height,
    upscaled: false,
  };
}
