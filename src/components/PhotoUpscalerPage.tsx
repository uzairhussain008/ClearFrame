import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Cpu,
  ImagePlus,
  Loader2,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { PhotoHeader } from './PhotoHeader';
import { PhotoComparisonView } from './PhotoComparisonView';
import { Footer, PhotoPageSeoSections } from './PhotoPageLayout';
import { PHOTO_PAGES } from '../seo/photoPages';
import { MAX_PHOTO_SIZE_MB, formatPhotoBytes, validatePhotoFile } from '../utils/photoInpaint';
import {
  MAX_PHOTO_OUTPUT_DIM,
  checkPhotoUpscaleDimensions,
  detectPhotoWebGpuSupport,
  upscalePhotoRgba,
  type PhotoUpscaleScale,
} from '../utils/photoUpscaler';

interface LoadedPhoto {
  name: string;
  size: number;
  width: number;
  height: number;
  url: string;
  rgba: Uint8ClampedArray;
}

type ExportFormat = 'png' | 'jpg';

const PAGE_DATA = PHOTO_PAGES['/photo-upscaler'];

export const PhotoUpscalerPage: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [scale, setScale] = useState<PhotoUpscaleScale>(2);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('png');
  const [preferAi, setPreferAi] = useState(true);
  const [webGpuInfo, setWebGpuInfo] = useState<{ supported: boolean; reason?: string }>({
    supported: false,
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');

  const [result, setResult] = useState<{
    url: string;
    width: number;
    height: number;
    format: ExportFormat;
    providerLabel: string;
  } | null>(null);

  useEffect(() => {
    detectPhotoWebGpuSupport()
      .then((res) => setWebGpuInfo(res))
      .catch(() => setWebGpuInfo({ supported: false }));
  }, []);

  useEffect(() => {
    return () => {
      if (photo?.url) URL.revokeObjectURL(photo.url);
    };
  }, [photo]);

  useEffect(() => {
    return () => {
      if (result?.url) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  const handleFileSelected = (file: File) => {
    setError(null);
    const check = validatePhotoFile({ name: file.name, size: file.size, type: file.type });
    if (!check.valid) {
      setError(check.error || 'Invalid photo file.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        URL.revokeObjectURL(objectUrl);
        setError('Could not read image dimensions.');
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        setError('Canvas 2D context is unavailable in this browser.');
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);

      setResult((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return null;
      });
      setPhoto({
        name: file.name,
        size: file.size,
        width: w,
        height: h,
        url: objectUrl,
        rgba: new Uint8ClampedArray(imgData.data),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setError('Failed to decode this image file. Please try JPG, PNG, or WebP.');
    };
    img.src = objectUrl;
  };

  const dimCheck = photo ? checkPhotoUpscaleDimensions(photo.width, photo.height, scale) : null;

  const handleStartUpscale = async () => {
    if (!photo || !dimCheck || !dimCheck.allowed || isProcessing) return;
    setError(null);
    setIsProcessing(true);
    setProgress(2);
    setStage('Preparing image...');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const upscaled = await upscalePhotoRgba({
        srcRgba: photo.rgba,
        width: photo.width,
        height: photo.height,
        scale,
        preferAi: preferAi && webGpuInfo.supported,
        signal: controller.signal,
        onProgress: ({ percent, stage: nextStage }) => {
          setProgress(percent);
          setStage(nextStage);
        },
      });

      const outCanvas = document.createElement('canvas');
      outCanvas.width = upscaled.outputWidth;
      outCanvas.height = upscaled.outputHeight;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) {
        throw new Error('Could not initialize output image canvas.');
      }
      const imageData = outCtx.createImageData(upscaled.outputWidth, upscaled.outputHeight);
      imageData.data.set(upscaled.rgba);
      outCtx.putImageData(imageData, 0, 0);

      const mime = exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, mime, exportFormat === 'jpg' ? 0.94 : undefined)
      );
      if (!blob) {
        throw new Error('Failed to encode upscaled image.');
      }

      const outUrl = URL.createObjectURL(blob);
      setResult((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return {
          url: outUrl,
          width: upscaled.outputWidth,
          height: upscaled.outputHeight,
          format: exportFormat,
          providerLabel: upscaled.providerLabel,
        };
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Photo upscaling failed.');
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsProcessing(false);
    setProgress(0);
    setStage('');
  };

  const handleDownload = () => {
    if (!result || !photo) return;
    const baseName = photo.name.replace(/\.[^.]+$/, '') || 'photo';
    const ext = result.format === 'jpg' ? 'jpg' : 'png';
    const link = document.createElement('a');
    link.href = result.url;
    link.download = `${baseName}-${scale}x.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    handleCancel();
    setError(null);
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    setPhoto((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <PhotoHeader
        activePath="/photo-upscaler"
        actionLabel="Upload Photo"
        onActionClick={() => fileInputRef.current?.click()}
      />

      <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 py-10 sm:px-6 sm:py-12">
        <section className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-sky-400">
            {PAGE_DATA.eyebrow}
          </p>
          <h1
            className="mt-2 font-display font-bold tracking-tight text-slate-50 text-center"
            style={{ fontSize: 'clamp(2.2rem, 4.2vw, 3.25rem)', lineHeight: 1.1, textWrap: 'balance' }}
          >
            {PAGE_DATA.h1}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base sm:text-lg leading-relaxed text-slate-300">
            {PAGE_DATA.intro}
          </p>
          <p className="mt-3 text-xs sm:text-sm font-medium text-slate-400">
            100% Free · Up to {MAX_PHOTO_SIZE_MB} MB · 2x &amp; 4x Scaling · Max {MAX_PHOTO_OUTPUT_DIM.toLocaleString()} px
          </p>
        </section>

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Choose photo file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileSelected(file);
            e.target.value = '';
          }}
        />

        <div className="mt-8">
          {error && (
            <div
              role="alert"
              className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/60 px-4 py-3 text-sm text-rose-200"
            >
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="rounded p-1 text-rose-300 hover:bg-rose-900/50 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {!photo && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFileSelected(file);
              }}
              className={`rounded-xl border transition-colors ${
                isDragging
                  ? 'border-sky-400 bg-sky-950/20'
                  : 'border-slate-800 bg-[#111A2E] hover:border-slate-700'
              } p-6 sm:p-10`}
            >
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-700/80 px-4 py-10 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-400">
                  <ImagePlus className="h-6 w-6" aria-hidden="true" />
                </div>
                <h2 className="mt-4 font-display text-lg font-semibold text-slate-50">
                  Drop your photo to upscale
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">
                  Select JPG, PNG, or WebP files up to <span className="font-medium text-slate-200">{MAX_PHOTO_SIZE_MB} MB</span>. Processed locally in your browser.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 cursor-pointer"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  Choose Photo File
                </button>
              </div>
            </div>
          )}

          {photo && !result && (
            <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 sm:p-6 space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="font-display text-lg font-semibold text-slate-50">
                    Configure photo upscale
                  </h2>
                  <p className="text-xs text-slate-400">
                    {photo.name} · {photo.width}×{photo.height} px · {formatPhotoBytes(photo.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={isProcessing}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Change Photo
                </button>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
                <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950 flex items-center justify-center p-3">
                  <img
                    src={photo.url}
                    alt={photo.name}
                    className="max-h-[380px] w-full object-contain"
                  />
                </div>

                <div className="space-y-5">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Upscale Factor
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      {([2, 4] as const).map((factor) => (
                        <button
                          key={factor}
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setScale(factor)}
                          className={`rounded-lg border px-4 py-3 text-left transition-colors cursor-pointer ${
                            scale === factor
                              ? 'border-sky-400 bg-sky-500/10 text-sky-300'
                              : 'border-slate-700 bg-[#0B1120] text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <div className="font-display text-base font-bold">{factor}x</div>
                          <div className="text-xs text-slate-400 tabular-nums">
                            {photo.width * factor}×{photo.height * factor} px
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Output Format
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      {(['png', 'jpg'] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setExportFormat(fmt)}
                          className={`rounded-lg border px-4 py-2.5 text-sm font-semibold uppercase cursor-pointer ${
                            exportFormat === fmt
                              ? 'border-sky-400 bg-sky-500/10 text-sky-300'
                              : 'border-slate-700 bg-[#0B1120] text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Processing Engine
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        disabled={!webGpuInfo.supported || isProcessing}
                        title={!webGpuInfo.supported ? webGpuInfo.reason : undefined}
                        onClick={() => setPreferAi(true)}
                        className={`rounded-lg border px-3 py-2.5 text-left text-xs transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          preferAi && webGpuInfo.supported
                            ? 'border-sky-400 bg-sky-500/10 text-sky-300'
                            : 'border-slate-700 bg-[#0B1120] text-slate-300'
                        }`}
                      >
                        <div className="font-semibold flex items-center gap-1.5">
                          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                          AI Upscaler
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {webGpuInfo.supported ? 'WebGPU available' : 'WebGPU unavailable'}
                        </div>
                      </button>
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => setPreferAi(false)}
                        className={`rounded-lg border px-3 py-2.5 text-left text-xs transition-colors cursor-pointer ${
                          !preferAi || !webGpuInfo.supported
                            ? 'border-sky-400 bg-sky-500/10 text-sky-300'
                            : 'border-slate-700 bg-[#0B1120] text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        <div className="font-semibold flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                          Lanczos-3
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Fast CPU fallback
                        </div>
                      </button>
                    </div>
                  </div>

                  {dimCheck && !dimCheck.allowed && (
                    <div
                      role="alert"
                      className="rounded-lg border border-amber-500/40 bg-amber-950/50 px-3.5 py-2.5 text-xs text-amber-200"
                    >
                      {dimCheck.reason}
                    </div>
                  )}

                  {isProcessing && (
                    <div className="space-y-2 rounded-lg border border-slate-800 bg-[#0B1120] p-3.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-200">{stage || 'Upscaling...'}</span>
                        <span className="font-mono text-sky-400 tabular-nums">{progress}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-sky-500 transition-all duration-150"
                          style={{ width: `${Math.max(3, progress)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2.5 pt-1">
                    <button
                      type="button"
                      disabled={!dimCheck?.allowed || isProcessing}
                      onClick={handleStartUpscale}
                      className="flex-1 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          Upscaling...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                          Upscale Photo {scale}x
                        </>
                      )}
                    </button>
                    {isProcessing && (
                      <button
                        type="button"
                        onClick={handleCancel}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {photo && result && (
            <PhotoComparisonView
              title={`Photo upscaled ${scale}x (${result.width}×${result.height} px)`}
              subtitle={`${photo.name} · ${result.providerLabel} · ${result.format.toUpperCase()} export`}
              beforeUrl={photo.url}
              afterUrl={result.url}
              beforeWidth={photo.width}
              beforeHeight={photo.height}
              afterWidth={result.width}
              afterHeight={result.height}
              downloadLabel={`Download ${result.format.toUpperCase()}`}
              onDownload={handleDownload}
              editLabel="Change Scale"
              onEdit={() => {
                setResult((prev) => {
                  if (prev?.url) URL.revokeObjectURL(prev.url);
                  return null;
                });
              }}
              onReset={handleReset}
            />
          )}
        </div>

        <PhotoPageSeoSections page={PAGE_DATA} />
      </main>

      <Footer />
    </div>
  );
};
