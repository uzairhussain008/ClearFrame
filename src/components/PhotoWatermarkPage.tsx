import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Brush,
  ImagePlus,
  Info,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PhotoHeader } from './PhotoHeader';
import { PhotoComparisonView } from './PhotoComparisonView';
import { Footer, PhotoPageSeoSections } from './PhotoPageLayout';
import { PHOTO_PAGES } from '../seo/photoPages';
import {
  MAX_PHOTO_SIZE_MB,
  formatPhotoBytes,
  inpaintPhotoPatchBased,
  validatePhotoFile,
} from '../utils/photoInpaint';
import type { InpaintWorkerMessage, InpaintWorkerRequest } from '../utils/photoInpaint.worker';
import {
  LAMA_MODEL_SIZE_LABEL,
  isLamaModelCached,
  runLamaHdInpaintRgba,
} from '../utils/lamaInpaint';

interface LoadedPhoto {
  name: string;
  size: number;
  width: number;
  height: number;
  url: string;
  rgba: Uint8ClampedArray;
}

type MaskTool = 'brush' | 'rect';

const PAGE_DATA = PHOTO_PAGES['/remove-photo-watermark'];

export const PhotoWatermarkPage: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<Uint8Array[]>([]);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewRectRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [tool, setTool] = useState<MaskTool>('brush');
  const [brushSize, setBrushSize] = useState(28);
  const [zoom, setZoom] = useState(1);
  const [undoCount, setUndoCount] = useState(0);
  const [hasMaskPixels, setHasMaskPixels] = useState(false);
  const [hdMode, setHdMode] = useState(false);
  const [hdCached, setHdCached] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [engineLabel, setEngineLabel] = useState('PatchMatch Texture Fill');

  useEffect(() => {
    isLamaModelCached()
      .then((cached) => setHdCached(cached))
      .catch(() => setHdCached(false));
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (photo?.url) URL.revokeObjectURL(photo.url);
    };
  }, [photo]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    const img = baseImageRef.current;
    const mask = maskRef.current;
    if (!canvas || !img || !photo || !mask) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, photo.width, photo.height);
    ctx.drawImage(img, 0, 0, photo.width, photo.height);

    // Overlay mask pixels in semi-transparent sky-blue/coral highlight
    const overlay = ctx.createImageData(photo.width, photo.height);
    const data = overlay.data;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0) {
        const off = i * 4;
        data[off] = 56;
        data[off + 1] = 189;
        data[off + 2] = 248;
        data[off + 3] = 155;
      }
    }
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = photo.width;
    tempCanvas.height = photo.height;
    const tCtx = tempCanvas.getContext('2d');
    if (tCtx) {
      tCtx.putImageData(overlay, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0);
    }

    const preview = previewRectRef.current;
    if (preview) {
      const rx = Math.min(preview.x0, preview.x1);
      const ry = Math.min(preview.y0, preview.y1);
      const rw = Math.abs(preview.x1 - preview.x0);
      const rh = Math.abs(preview.y1 - preview.y0);
      ctx.save();
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = Math.max(2, Math.round(Math.max(photo.width, photo.height) / 400));
      ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }
  };

  useEffect(() => {
    if (photo && !resultUrl) {
      redrawCanvas();
    }
  }, [photo, resultUrl]);

  const checkMaskHasPixels = (mask: Uint8Array): boolean => {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0) return true;
    }
    return false;
  };

  const handleFileSelected = async (file: File) => {
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

      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        setError('Canvas 2D context is unavailable in this browser.');
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);

      baseImageRef.current = img;
      maskRef.current = new Uint8Array(w * h);
      historyRef.current = [];
      setUndoCount(0);
      setHasMaskPixels(false);
      setZoom(1);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
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

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(canvas.width - 1, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(canvas.height - 1, (e.clientY - rect.top) * scaleY)),
    };
  };

  const paintBrushLine = (x0: number, y0: number, x1: number, y1: number) => {
    const mask = maskRef.current;
    if (!mask || !photo) return;
    const radius = Math.max(2, brushSize / 2);
    const rSq = radius * radius;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const minX = Math.max(0, Math.floor(cx - radius));
      const maxX = Math.min(photo.width - 1, Math.ceil(cx + radius));
      const minY = Math.max(0, Math.floor(cy - radius));
      const maxY = Math.min(photo.height - 1, Math.ceil(cy + radius));

      for (let py = minY; py <= maxY; py++) {
        const dy = py - cy;
        const row = py * photo.width;
        for (let px = minX; px <= maxX; px++) {
          const dx = px - cx;
          if (dx * dx + dy * dy <= rSq) {
            mask[row + px] = 1;
          }
        }
      }
    }
  };

  const pushHistorySnapshot = () => {
    if (!maskRef.current) return;
    const snap = new Uint8Array(maskRef.current);
    historyRef.current = [...historyRef.current.slice(-19), snap];
    setUndoCount(historyRef.current.length);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!photo || !maskRef.current || isProcessing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getCanvasPoint(e);
    pushHistorySnapshot();
    isDrawingRef.current = true;
    if (tool === 'brush') {
      lastPointRef.current = pt;
      paintBrushLine(pt.x, pt.y, pt.x, pt.y);
      setHasMaskPixels(true);
      redrawCanvas();
    } else {
      rectStartRef.current = pt;
      previewRectRef.current = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      redrawCanvas();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !photo) return;
    const pt = getCanvasPoint(e);
    if (tool === 'brush') {
      const prev = lastPointRef.current ?? pt;
      paintBrushLine(prev.x, prev.y, pt.x, pt.y);
      lastPointRef.current = pt;
      redrawCanvas();
    } else if (rectStartRef.current) {
      previewRectRef.current = {
        x0: rectStartRef.current.x,
        y0: rectStartRef.current.y,
        x1: pt.x,
        y1: pt.y,
      };
      redrawCanvas();
    }
  };

  const handlePointerUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPointRef.current = null;
    if (tool === 'rect' && previewRectRef.current && maskRef.current && photo) {
      const { x0, y0, x1, y1 } = previewRectRef.current;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1)));
      const maxX = Math.min(photo.width - 1, Math.ceil(Math.max(x0, x1)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1)));
      const maxY = Math.min(photo.height - 1, Math.ceil(Math.max(y0, y1)));
      if (maxX - minX >= 2 && maxY - minY >= 2) {
        for (let py = minY; py <= maxY; py++) {
          const row = py * photo.width;
          for (let px = minX; px <= maxX; px++) {
            maskRef.current[row + px] = 1;
          }
        }
        setHasMaskPixels(true);
      } else {
        // Ignore tiny accidental click in rectangle mode
        historyRef.current.pop();
        setUndoCount(historyRef.current.length);
      }
      previewRectRef.current = null;
      rectStartRef.current = null;
      redrawCanvas();
    }
  };

  const handleUndo = () => {
    const prev = historyRef.current.pop();
    if (!prev || !maskRef.current) return;
    maskRef.current = prev;
    setUndoCount(historyRef.current.length);
    setHasMaskPixels(checkMaskHasPixels(prev));
    redrawCanvas();
  };

  const handleClearMask = () => {
    if (!maskRef.current || !hasMaskPixels) return;
    pushHistorySnapshot();
    maskRef.current.fill(0);
    setHasMaskPixels(false);
    redrawCanvas();
  };

  const runPatchWorker = (
    srcRgba: Uint8ClampedArray,
    mask: Uint8Array,
    width: number,
    height: number,
    dilatePx: number,
    signal: AbortSignal
  ): Promise<{ rgba: Uint8ClampedArray; engineUsed: 'patchmatch' | 'telea-fallback' }> => {
    if (typeof Worker === 'undefined') {
      const res = inpaintPhotoPatchBased({
        srcRgba,
        mask,
        width,
        height,
        dilatePx,
        featherPx: 4,
        addGrain: true,
        onProgress: (pct, nextStage) => {
          setProgress(pct);
          setStage(nextStage);
        },
      });
      return Promise.resolve({ rgba: res.rgba, engineUsed: res.engineUsed });
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../utils/photoInpaint.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;

      const onAbort = () => {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        reject(new Error('Cancelled'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (event: MessageEvent<InpaintWorkerMessage>) => {
        const msg = event.data;
        if (msg.type === 'progress') {
          setProgress(msg.percent);
          setStage(msg.stage);
        } else if (msg.type === 'done') {
          signal.removeEventListener('abort', onAbort);
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          resolve({
            rgba: new Uint8ClampedArray(msg.rgbaBuffer),
            engineUsed: msg.engineUsed,
          });
        } else if (msg.type === 'error') {
          signal.removeEventListener('abort', onAbort);
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          reject(new Error(msg.message));
        }
      };

      worker.onerror = (err) => {
        signal.removeEventListener('abort', onAbort);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        reject(new Error(err.message || 'Inpainting worker failed.'));
      };

      const srcCopy = new Uint8ClampedArray(srcRgba);
      const maskCopy = new Uint8Array(mask);
      const reqPayload: InpaintWorkerRequest = {
        srcBuffer: srcCopy.buffer,
        maskBuffer: maskCopy.buffer,
        width,
        height,
        dilatePx,
        featherPx: 4,
        addGrain: true,
      };
      worker.postMessage(reqPayload, [srcCopy.buffer, maskCopy.buffer]);
    });
  };

  const handleCancelProcessing = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setIsProcessing(false);
    setProgress(0);
    setStage('');
  };

  const handleProcessPhoto = async () => {
    if (!photo || !maskRef.current || !hasMaskPixels || isProcessing) return;
    setError(null);
    setNotice(null);
    setIsProcessing(true);
    setProgress(2);
    setStage('Preparing watermark mask...');

    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Slight 2-3 px dilation automatically covers anti-aliased watermark edges
    const dilatePx = Math.max(photo.width, photo.height) >= 1000 ? 3 : 2;

    try {
      let cleanedRgba: Uint8ClampedArray | null = null;
      let resolvedLabel = 'PatchMatch Texture Fill';

      if (hdMode) {
        try {
          const hdRes = await runLamaHdInpaintRgba({
            srcRgba: photo.rgba,
            mask: maskRef.current,
            width: photo.width,
            height: photo.height,
            dilatePx,
            featherPx: 4,
            signal: controller.signal,
            onProgress: (pct, nextStage) => {
              setProgress(pct);
              setStage(nextStage);
            },
          });
          cleanedRgba = hdRes.rgba;
          resolvedLabel = `HD LaMa AI (${hdRes.provider.toUpperCase()})`;
          setHdCached(true);
        } catch (hdErr) {
          if (controller.signal.aborted) {
            throw hdErr;
          }
          const detail = hdErr instanceof Error ? hdErr.message : 'Unable to load HD LaMa model.';
          setNotice(
            `HD mode could not load (${detail}). Automatically fell back to the patch-based texture engine.`
          );
          setProgress(8);
          setStage('Falling back to patch-based texture fill...');
        }
      }

      if (!cleanedRgba) {
        const patchRes = await runPatchWorker(
          photo.rgba,
          maskRef.current,
          photo.width,
          photo.height,
          dilatePx,
          controller.signal
        );
        cleanedRgba = patchRes.rgba;
        resolvedLabel =
          patchRes.engineUsed === 'telea-fallback'
            ? 'Telea Fast Fill (Small Mask Fallback)'
            : 'PatchMatch Texture Fill + Grain Match';
      }

      if (controller.signal.aborted) return;

      const outCanvas = document.createElement('canvas');
      outCanvas.width = photo.width;
      outCanvas.height = photo.height;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) {
        throw new Error('Could not initialize output image canvas.');
      }
      const imageData = outCtx.createImageData(photo.width, photo.height);
      imageData.data.set(cleanedRgba);
      outCtx.putImageData(imageData, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, 'image/png')
      );
      if (!blob) {
        throw new Error('Failed to export PNG image.');
      }

      const outUrl = URL.createObjectURL(blob);
      setEngineLabel(resolvedLabel);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return outUrl;
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to remove watermark.');
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsProcessing(false);
    }
  };

  const handleDownloadPng = () => {
    if (!resultUrl || !photo) return;
    const baseName = photo.name.replace(/\.[^.]+$/, '') || 'photo';
    const link = document.createElement('a');
    link.href = resultUrl;
    link.download = `${baseName}-clean.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    handleCancelProcessing();
    setError(null);
    setNotice(null);
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPhoto((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    maskRef.current = null;
    historyRef.current = [];
    baseImageRef.current = null;
    setUndoCount(0);
    setHasMaskPixels(false);
    setZoom(1);
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <PhotoHeader
        activePath="/remove-photo-watermark"
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
            100% Free · Up to {MAX_PHOTO_SIZE_MB} MB · JPG / PNG / WebP · Processed locally in browser
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

          {notice && (
            <div
              role="status"
              className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-950/50 px-4 py-3 text-sm text-amber-200"
            >
              <div className="flex items-center gap-2.5">
                <Info className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                <span>{notice}</span>
              </div>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notice"
                className="rounded p-1 text-amber-300 hover:bg-amber-900/50 cursor-pointer"
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
                  Drop your photo to clean
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">
                  Select JPG, PNG, or WebP files up to <span className="font-medium text-slate-200">{MAX_PHOTO_SIZE_MB} MB</span>. Nothing is uploaded.
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

          {photo && !resultUrl && (
            <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 sm:p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="font-display text-lg font-semibold text-slate-50">
                    Paint or box over the watermark
                  </h2>
                  <p className="text-xs text-slate-400">
                    {photo.name} · {photo.width}×{photo.height} px · {formatPhotoBytes(photo.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Change Photo
                </button>
              </div>

              {/* Editor Controls */}
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-3">
                  <div className="flex items-center rounded-md bg-slate-900 p-1">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => setTool('brush')}
                      className={`inline-flex min-h-[34px] items-center gap-1.5 rounded px-3 py-1 text-xs font-medium cursor-pointer ${
                        tool === 'brush'
                          ? 'bg-sky-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-slate-50'
                      }`}
                    >
                      <Brush className="h-3.5 w-3.5" aria-hidden="true" />
                      Brush
                    </button>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => setTool('rect')}
                      className={`inline-flex min-h-[34px] items-center gap-1.5 rounded px-3 py-1 text-xs font-medium cursor-pointer ${
                        tool === 'rect'
                          ? 'bg-sky-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-slate-50'
                      }`}
                    >
                      <Square className="h-3.5 w-3.5" aria-hidden="true" />
                      Rectangle
                    </button>
                  </div>

                  {tool === 'brush' && (
                    <label className="flex items-center gap-2 text-xs text-slate-300 px-2">
                      <span>Brush: {brushSize}px</span>
                      <input
                        type="range"
                        min={6}
                        max={80}
                        disabled={isProcessing}
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-24 accent-sky-400 cursor-pointer"
                      />
                    </label>
                  )}

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleUndo}
                      disabled={undoCount === 0 || isProcessing}
                      className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Undo
                    </button>
                    <button
                      type="button"
                      onClick={handleClearMask}
                      disabled={!hasMaskPixels || isProcessing}
                      className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Clear
                    </button>
                  </div>

                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label="Zoom out"
                      onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
                      disabled={zoom <= 1}
                      className="inline-flex min-h-[34px] items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                    >
                      <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-[44px] text-center font-mono text-xs text-slate-300 tabular-nums">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      aria-label="Zoom in"
                      onClick={() => setZoom((z) => Math.min(3, Number((z + 0.5).toFixed(1))))}
                      disabled={zoom >= 3}
                      className="inline-flex min-h-[34px] items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                    >
                      <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <p className="px-1 text-xs text-slate-400">
                  Paint tightly over the watermark only. For big watermarks, paint and remove in several small passes.
                </p>
              </div>

              {/* Interactive Canvas Viewport */}
              <div className="max-h-[540px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 flex justify-center items-start">
                <canvas
                  ref={canvasRef}
                  width={photo.width}
                  height={photo.height}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  className="touch-none select-none cursor-crosshair rounded block"
                  style={{
                    width:
                      zoom === 1
                        ? `min(100%, ${Math.max(120, Math.round((480 * photo.width) / Math.max(1, photo.height)))}px)`
                        : `${Math.round(zoom * 100)}%`,
                    maxWidth: zoom === 1 ? '100%' : 'none',
                    height: 'auto',
                    aspectRatio: `${photo.width} / ${photo.height}`,
                  }}
                />
              </div>

              {/* HD Mode Toggle & Progress */}
              <div className="space-y-4 border-t border-slate-800 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B1120] px-4 py-3">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-slate-100">
                      HD Mode (LaMa AI Inpainting · {LAMA_MODEL_SIZE_LABEL})
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {hdCached
                        ? 'Model cached in your browser. Runs on a 512×512 crop around the mask via WebGPU/WASM.'
                        : `Optional neural inpainting (${LAMA_MODEL_SIZE_LABEL} one-time download & browser cache). Default uses fast PatchMatch texture synthesis.`}
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2.5 text-xs font-medium text-slate-200 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hdMode}
                      disabled={isProcessing}
                      onChange={(e) => setHdMode(e.target.checked)}
                      aria-label="Enable HD mode (LaMa AI)"
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-400 cursor-pointer"
                    />
                    <span>{hdMode ? 'HD Mode On' : 'Use HD Mode'}</span>
                  </label>
                </div>

                {isProcessing && (
                  <div className="space-y-2 rounded-lg border border-slate-800 bg-[#0B1120] p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-200">{stage || 'Processing...'}</span>
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

                <div className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-xs text-slate-400">
                    {hasMaskPixels
                      ? 'Mask ready (2–3 px edge padding applied automatically). Only pixels inside the masked region are altered.'
                      : 'Paint over or draw a rectangle around the watermark to enable removal.'}
                  </p>
                  <div className="flex items-center gap-2.5">
                    {isProcessing && (
                      <button
                        type="button"
                        onClick={handleCancelProcessing}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!hasMaskPixels || isProcessing}
                      onClick={handleProcessPhoto}
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-500 px-6 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          Removing Watermark...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                          {hdMode ? 'Remove Watermark (HD)' : 'Remove Watermark'}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {photo && resultUrl && (
            <PhotoComparisonView
              title="Watermark removed in browser"
              subtitle={`${photo.name} · ${photo.width}×${photo.height} px · ${engineLabel} · PNG export`}
              beforeUrl={photo.url}
              afterUrl={resultUrl}
              beforeWidth={photo.width}
              beforeHeight={photo.height}
              afterWidth={photo.width}
              afterHeight={photo.height}
              downloadLabel="Download PNG"
              onDownload={handleDownloadPng}
              editLabel="Edit Mask"
              onEdit={() => {
                setResultUrl((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
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
