import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Plus,
  Trash2,
  Eraser,
  RotateCcw,
  AlertCircle,
  Loader2,
  Cpu,
  Sparkles,
  Download,
  X,
} from 'lucide-react';
import {
  clampRegion,
  computeUpscaleDimensions,
  formatBytes,
  formatTimecode,
  type RemovalMode,
  type UpscaleEngine,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from '../utils/watermark';
import {
  checkAiVideoLimits,
  type AiClientLimits,
  type WebGpuSupportResult,
} from '../utils/webgpuUpscaler';
import type {
  AiConnectionState,
  AiLimits,
  AiModelState,
  ClientAiProgressState,
} from '../App';

interface WatermarkEditorProps {
  video: VideoMetadata;
  isAdminMode: boolean;
  removeWatermarkEnabled: boolean;
  regions: WatermarkRegion[];
  mode: RemovalMode;
  upscale: UpscalePreset;
  detailEnhance: boolean;
  upscaleEngine: UpscaleEngine;
  webGpuSupport: WebGpuSupportResult & { checked: boolean };
  aiWebGpuLimits: AiClientLimits;
  aiModelState: AiModelState;
  clientAiProgress: ClientAiProgressState;
  comfyUrlInput: string;
  aiConnection: AiConnectionState;
  aiLimits: AiLimits;
  isProcessing: boolean;
  processStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  queuePosition?: number;
  processProgress: number;
  processError: string | null;
  processFallbackAvailable: boolean;
  onRemoveWatermarkToggle: (enabled: boolean) => void;
  onRegionsChange: (regions: WatermarkRegion[]) => void;
  onModeChange: (mode: RemovalMode) => void;
  onUpscaleChange: (upscale: UpscalePreset) => void;
  onDetailEnhanceChange: (enabled: boolean) => void;
  onUpscaleEngineChange: (engine: UpscaleEngine) => void;
  onComfyUrlInputChange: (url: string) => void;
  onConnectColab: () => void;
  onDisconnectColab: () => void;
  onStartProcessing: () => void;
  onCancelProcessing: () => void;
  onContinueWithCpu: () => void;
  onChangeVideo: () => void;
}

type DragAction =
  | { type: 'create'; startX: number; startY: number; regionId: string }
  | { type: 'move'; regionId: string; offsetX: number; offsetY: number }
  | {
      type: 'resize';
      regionId: string;
      handle: 'nw' | 'ne' | 'sw' | 'se';
      anchorX: number;
      anchorY: number;
    };

const MODE_OPTIONS: Array<{ id: RemovalMode; label: string; hint: string }> = [
  {
    id: 'delogo',
    label: 'Smart Inpaint',
    hint: 'Reconstructs watermark pixels smoothly from surrounding edges.',
  },
  {
    id: 'blur',
    label: 'Soft Blur',
    hint: 'Applies a smooth gaussian patch over translucent or moving logos.',
  },
  {
    id: 'pixelate',
    label: 'Mosaic',
    hint: 'Covers text or watermarks with clean mosaic blocks.',
  },
];

const UPSCALE_OPTIONS: Array<{ id: UpscalePreset; label: string }> = [
  { id: 'original', label: 'Original' },
  { id: '1080p', label: '1080p' },
  { id: '2k', label: '2K' },
  { id: '4k', label: '4K' },
];

export const WatermarkEditor: React.FC<WatermarkEditorProps> = ({
  video,
  isAdminMode,
  removeWatermarkEnabled,
  regions,
  mode,
  upscale,
  detailEnhance,
  upscaleEngine,
  webGpuSupport,
  aiWebGpuLimits,
  aiModelState,
  clientAiProgress,
  comfyUrlInput,
  aiConnection,
  aiLimits,
  isProcessing,
  processStatus,
  queuePosition,
  processProgress,
  processError,
  processFallbackAvailable,
  onRemoveWatermarkToggle,
  onRegionsChange,
  onModeChange,
  onUpscaleChange,
  onDetailEnhanceChange,
  onUpscaleEngineChange,
  onComfyUrlInputChange,
  onConnectColab,
  onDisconnectColab,
  onStartProcessing,
  onCancelProcessing,
  onContinueWithCpu,
  onChangeVideo,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(regions[0]?.id ?? null);
  const [dragAction, setDragAction] = useState<DragAction | null>(null);

  useEffect(() => {
    if (regions.length > 0 && (!selectedId || !regions.some((r) => r.id === selectedId))) {
      setSelectedId(regions[0].id);
    }
  }, [regions, selectedId]);

  const toVideoCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      x: Math.round(normX * video.width),
      y: Math.round(normY * video.height),
    };
  };

  useEffect(() => {
    if (!dragAction) return;

    const handlePointerMove = (e: PointerEvent) => {
      const pt = toVideoCoords(e.clientX, e.clientY);

      if (dragAction.type === 'create') {
        const rawX = Math.min(dragAction.startX, pt.x);
        const rawY = Math.min(dragAction.startY, pt.y);
        const rawW = Math.max(16, Math.abs(pt.x - dragAction.startX));
        const rawH = Math.max(16, Math.abs(pt.y - dragAction.startY));

        onRegionsChange(
          regions.map((r) =>
            r.id === dragAction.regionId
              ? clampRegion({ ...r, x: rawX, y: rawY, w: rawW, h: rawH }, video.width, video.height)
              : r
          )
        );
      } else if (dragAction.type === 'move') {
        onRegionsChange(
          regions.map((r) => {
            if (r.id !== dragAction.regionId) return r;
            return clampRegion(
              {
                ...r,
                x: pt.x - dragAction.offsetX,
                y: pt.y - dragAction.offsetY,
              },
              video.width,
              video.height
            );
          })
        );
      } else if (dragAction.type === 'resize') {
        onRegionsChange(
          regions.map((r) => {
            if (r.id !== dragAction.regionId) return r;
            const rawX = Math.min(dragAction.anchorX, pt.x);
            const rawY = Math.min(dragAction.anchorY, pt.y);
            const rawW = Math.max(16, Math.abs(pt.x - dragAction.anchorX));
            const rawH = Math.max(16, Math.abs(pt.y - dragAction.anchorY));
            return clampRegion(
              { ...r, x: rawX, y: rawY, w: rawW, h: rawH },
              video.width,
              video.height
            );
          })
        );
      }
    };

    const handlePointerUp = () => {
      setDragAction(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragAction, regions, video.width, video.height, onRegionsChange]);

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isProcessing || e.button !== 0) return;
    if (e.target !== overlayRef.current) return;
    if (regions.length >= 8) return;

    const pt = toVideoCoords(e.clientX, e.clientY);
    const id = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newRegion = clampRegion(
      {
        id,
        label: `Region ${regions.length + 1}`,
        x: pt.x,
        y: pt.y,
        w: Math.round(video.width * 0.14),
        h: Math.round(video.height * 0.08),
        startTime: null,
        endTime: null,
      },
      video.width,
      video.height
    );
    onRegionsChange([...regions, newRegion]);
    setSelectedId(id);
    setDragAction({ type: 'create', startX: pt.x, startY: pt.y, regionId: id });
  };

  const handleAddRegionButton = () => {
    if (regions.length >= 8) return;
    const id = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const offset = (regions.length % 4) * 32;
    const boxW = Math.max(48, Math.round(video.width * 0.2));
    const boxH = Math.max(32, Math.round(video.height * 0.1));
    const newRegion = clampRegion(
      {
        id,
        label: `Region ${regions.length + 1}`,
        x: Math.round(video.width * 0.1 + offset),
        y: Math.round(video.height * 0.1 + offset),
        w: boxW,
        h: boxH,
        startTime: null,
        endTime: null,
      },
      video.width,
      video.height
    );
    onRegionsChange([...regions, newRegion]);
    setSelectedId(id);
  };

  const handleDeleteRegion = (id: string) => {
    const filtered = regions
      .filter((r) => r.id !== id)
      .map((r, i) => ({ ...r, label: `Region ${i + 1}` }));
    onRegionsChange(filtered);
  };

  const handleTogglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = val;
    }
    setCurrentTime(val);
  };

  const updateRegionField = (id: string, patch: Partial<WatermarkRegion>) => {
    onRegionsChange(
      regions.map((r) =>
        r.id === id ? clampRegion({ ...r, ...patch }, video.width, video.height) : r
      )
    );
  };

  const activeMode = MODE_OPTIONS.find((m) => m.id === mode) ?? MODE_OPTIONS[0];
  const targetDims = computeUpscaleDimensions(video.width, video.height, upscale);
  const activeRegionCount = removeWatermarkEnabled ? regions.length : 0;
  const canProcess = activeRegionCount > 0 || targetDims.upscaled;

  const useAdminColab = isAdminMode && aiConnection.connected;
  const colabWithinLimits =
    video.size <= aiLimits.maxSizeMb * 1024 * 1024 && video.duration <= aiLimits.maxDurationSec;
  const webGpuLimitCheck = checkAiVideoLimits(video, aiWebGpuLimits);

  const canSelectAiEngine =
    targetDims.upscaled && (useAdminColab ? colabWithinLimits : webGpuSupport.supported);
  const effectiveEngine: UpscaleEngine = canSelectAiEngine && upscaleEngine === 'ai' ? 'ai' : 'cpu';
  const aiBlockedByLimits = effectiveEngine === 'ai' && !useAdminColab && !webGpuLimitCheck.allowed;

  const aiTooltip = useAdminColab
    ? !colabWithinLimits
      ? `Colab tunnel supports up to ${aiLimits.maxSizeMb} MB / ${aiLimits.maxDurationSec}s`
      : 'Use RealESRGAN on your connected Colab GPU'
    : webGpuSupport.supported
      ? 'Use Real-ESRGAN AI super-resolution in your browser'
      : "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.";

  const actionLabel =
    activeRegionCount > 0 && targetDims.upscaled
      ? `Remove Watermark & Upscale (${upscale.toUpperCase()})`
      : activeRegionCount === 0 && targetDims.upscaled
        ? effectiveEngine === 'ai'
          ? `AI Upscale to ${upscale.toUpperCase()}`
          : `Upscale Video to ${upscale.toUpperCase()}`
        : !removeWatermarkEnabled
          ? 'Select Upscale or Remove Watermark'
          : 'Remove Watermark';

  const processingTitle = clientAiProgress.active
    ? clientAiProgress.stage || `AI Upscaling to ${upscale.toUpperCase()}`
    : activeRegionCount > 0 && targetDims.upscaled
      ? `Removing watermark & upscaling to ${upscale.toUpperCase()}`
      : activeRegionCount === 0 && targetDims.upscaled
        ? effectiveEngine === 'ai'
          ? `AI upscaling on GPU to ${upscale.toUpperCase()}`
          : `Upscaling video to ${upscale.toUpperCase()}`
        : 'Removing watermark from video';

  if (isProcessing) {
    const isQueued = !clientAiProgress.active && processStatus === 'queued';
    const isIndeterminate =
      clientAiProgress.active &&
      aiModelState.status === 'downloading' &&
      aiModelState.progress === null &&
      clientAiProgress.totalFrames === 0;
    const clampedProgress = Math.min(100, Math.max(0, processProgress));

    return (
      <div
        data-testid="processing-view"
        className="rounded-xl border border-slate-800 bg-[#111A2E] px-6 py-16 text-center"
      >
        <div className="mx-auto max-w-md space-y-5">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          </div>

          <div>
            <h2 className="font-display text-xl font-semibold text-slate-50">
              {isQueued
                ? queuePosition && queuePosition > 0
                  ? `Queued (#${queuePosition} in line)`
                  : 'Queued for processing'
                : processingTitle}
            </h2>
            <p className="mt-1 text-sm text-slate-400 truncate">{video.originalName}</p>
          </div>

          <div className="space-y-2 text-left">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className="font-mono tabular-nums">
                {clientAiProgress.active && clientAiProgress.totalFrames > 0
                  ? `Frames ${clientAiProgress.doneFrames}/${clientAiProgress.totalFrames}${
                      clientAiProgress.etaSeconds ? ` · ~${clientAiProgress.etaSeconds}s left` : ''
                    }`
                  : `${activeRegionCount > 0 ? `${activeMode.label} · ` : ''}${
                      effectiveEngine === 'ai' && targetDims.upscaled ? 'AI GPU · ' : ''
                    }${targetDims.width}×${targetDims.height}`}
              </span>
              <span className="font-mono text-sm font-semibold text-sky-400 tabular-nums">
                {isQueued ? 'Waiting' : isIndeterminate ? 'Loading' : `${clampedProgress}%`}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              {isIndeterminate ? (
                <div className="h-full w-2/5 animate-pulse rounded-full bg-sky-500" />
              ) : (
                <div
                  className="h-full bg-sky-500 transition-[width] duration-200 ease-out"
                  style={{ width: `${isQueued ? 0 : clampedProgress}%` }}
                />
              )}
            </div>
          </div>

          {clientAiProgress.active && (
            <p
              data-testid="ai-status-line"
              className="font-mono text-[11px] text-slate-300 tabular-nums"
            >
              {(clientAiProgress.provider || aiModelState.provider || 'webgpu').toUpperCase()}
              {' · '}
              {clientAiProgress.modelName || aiModelState.modelName || 'realesr-general-x4v3.onnx'}
              {clientAiProgress.totalFrames > 0 && (
                <>
                  {' · '}
                  {clientAiProgress.doneFrames}/{clientAiProgress.totalFrames} frames
                </>
              )}
              {clientAiProgress.msPerFrame !== null && (
                <>
                  {' · '}
                  {clientAiProgress.msPerFrame} ms/frame
                </>
              )}
            </p>
          )}

          {clientAiProgress.active && aiModelState.status === 'downloading' && (
            <p className="text-xs text-sky-300">
              {aiModelState.progress === null
                ? 'Downloading AI model (size unknown) — cached in browser after first run.'
                : `Downloading AI model (${aiModelState.progress}%) — cached in browser after first run.`}
            </p>
          )}

          <p className="text-xs text-slate-400">
            {isQueued
              ? 'Waiting for an available processing slot. Your job will start automatically.'
              : clientAiProgress.active
                ? clientAiProgress.provider === 'wasm'
                  ? 'Running Real-ESRGAN (WASM fallback) tiles locally in your browser and muxing original audio.'
                  : 'Running Real-ESRGAN WebGPU tiles locally in your browser and muxing original audio.'
                : effectiveEngine === 'ai'
                  ? 'Upscaling video frames on your connected Colab GPU and muxing original audio.'
                  : 'Encoding visually lossless frames and preserving original audio. Keep this tab open.'}
          </p>

          {clientAiProgress.active && (
            <button
              type="button"
              onClick={onCancelProcessing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel AI Upscale
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_350px] items-start">
      {/* Left: Video Canvas Stage & Timeline */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            {removeWatermarkEnabled
              ? 'Drag anywhere on the frame to mark a watermark, or drag corners to resize.'
              : 'Select Remove Watermark on the right (or drag on the frame) to erase logos or text.'}
          </span>
          {removeWatermarkEnabled && (
            <button
              type="button"
              onClick={handleAddRegionButton}
              disabled={regions.length >= 8}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-100 hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
              Add Box
            </button>
          )}
        </div>

        <div className="relative flex w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950">
          <div
            className="relative mx-auto w-full"
            style={{
              aspectRatio: `${video.width} / ${video.height}`,
              maxHeight: '460px',
              maxWidth: `calc(460px * ${video.width} / ${video.height})`,
            }}
          >
            <video
              ref={videoRef}
              src={video.previewUrl}
              playsInline
              preload="auto"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onTimeUpdate={() => {
                if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
              }}
              className="h-full w-full object-contain select-none"
            />

            {/* Interactive Watermark Selection Overlay */}
            <div
              ref={overlayRef}
              onPointerDown={handleStagePointerDown}
              data-testid="watermark-overlay"
              className={`absolute inset-0 touch-none ${removeWatermarkEnabled ? 'cursor-crosshair' : 'cursor-default'}`}
            >
              {regions.map((region) => {
                const isSelected = region.id === selectedId;
                const leftPct = (region.x / video.width) * 100;
                const topPct = (region.y / video.height) * 100;
                const widthPct = (region.w / video.width) * 100;
                const heightPct = (region.h / video.height) * 100;
                const labelInside = topPct < 7;

                return (
                  <div
                    key={region.id}
                    data-testid={`region-box-${region.id}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedId(region.id);
                      const pt = toVideoCoords(e.clientX, e.clientY);
                      setDragAction({
                        type: 'move',
                        regionId: region.id,
                        offsetX: pt.x - region.x,
                        offsetY: pt.y - region.y,
                      });
                    }}
                    style={{
                      left: `${leftPct}%`,
                      top: `${topPct}%`,
                      width: `${widthPct}%`,
                      height: `${heightPct}%`,
                    }}
                    className={`absolute cursor-move border-2 transition-colors ${
                      isSelected
                        ? 'border-sky-400 bg-sky-400/20'
                        : 'border-white/90 bg-slate-900/30 hover:border-sky-300'
                    }`}
                  >
                    <span
                      className={`pointer-events-none absolute rounded bg-slate-950/90 px-1.5 py-0.5 font-mono text-[11px] font-medium text-sky-300 whitespace-nowrap ${
                        labelInside ? 'top-1 left-1' : '-top-6 left-0'
                      }`}
                    >
                      {region.label}
                    </span>

                    {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
                      const posClass =
                        handle === 'nw'
                          ? '-top-1.5 -left-1.5 cursor-nwse-resize'
                          : handle === 'ne'
                            ? '-top-1.5 -right-1.5 cursor-nesw-resize'
                            : handle === 'sw'
                              ? '-bottom-1.5 -left-1.5 cursor-nesw-resize'
                              : '-bottom-1.5 -right-1.5 cursor-nwse-resize';

                      return (
                        <button
                          key={handle}
                          type="button"
                          aria-label={`Resize ${region.label} ${handle} corner`}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelectedId(region.id);
                            const anchorX =
                              handle === 'nw' || handle === 'sw'
                                ? region.x + region.w
                                : region.x;
                            const anchorY =
                              handle === 'nw' || handle === 'ne'
                                ? region.y + region.h
                                : region.y;
                            setDragAction({
                              type: 'resize',
                              regionId: region.id,
                              handle,
                              anchorX,
                              anchorY,
                            });
                          }}
                          className={`absolute h-3.5 w-3.5 rounded-xs border border-sky-500 bg-white ${posClass}`}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Playback Controls */}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleTogglePlay}
            aria-label={isPlaying ? 'Pause video preview' : 'Play video preview'}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800 cursor-pointer"
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>

          <input
            type="range"
            min={0}
            max={Math.max(0.1, video.duration)}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek video timeline"
            className="h-2 w-full accent-sky-400 cursor-pointer"
          />

          <span className="font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap shrink-0">
            {formatTimecode(currentTime)} / {formatTimecode(video.duration)}
          </span>
        </div>
      </div>

      {/* Right: Inspector Controls */}
      <aside className="rounded-xl border border-slate-800 bg-[#111A2E] p-5 space-y-5">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="min-w-0">
            <h2 className="truncate font-display text-sm font-semibold text-slate-50">
              {video.originalName}
            </h2>
            <p className="mt-1 font-mono text-xs text-slate-400 tabular-nums">
              {video.width}×{video.height} · {formatTimecode(video.duration)} ·{' '}
              {formatBytes(video.size)}
            </p>
          </div>
          <button
            type="button"
            onClick={onChangeVideo}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Change
          </button>
        </div>

        {/* Manual Watermark Removal Toggle */}
        <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B1120] px-3 py-2.5 cursor-pointer">
          <div>
            <span className="block text-xs font-semibold text-slate-200">Remove Watermark</span>
            <span className="block text-[11px] text-slate-400">
              {removeWatermarkEnabled
                ? 'Select boxes over logos or text overlays'
                : 'Enable to mark and erase watermarks'}
            </span>
          </div>
          <input
            type="checkbox"
            checked={removeWatermarkEnabled}
            onChange={(e) => onRemoveWatermarkToggle(e.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-900 accent-sky-400 cursor-pointer"
          />
        </label>

        {/* Removal Method Segmented Control (shown only when Remove Watermark is enabled) */}
        {removeWatermarkEnabled && (
          <div>
            <span className="block text-xs font-semibold text-slate-200">Removal Method</span>
            <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-[#0B1120] p-1">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onModeChange(opt.id)}
                  className={`rounded-md px-2 py-2 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    mode === opt.id
                      ? 'bg-slate-800 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">{activeMode.hint}</p>
          </div>
        )}

        {/* Output Resolution / Upscale Selector */}
        <div className="border-t border-slate-800 pt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-200">Upscale Resolution</span>
            <span className="font-mono text-xs font-medium text-sky-400 tabular-nums">
              {targetDims.width}×{targetDims.height}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-[#0B1120] p-1">
            {UPSCALE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onUpscaleChange(opt.id)}
                className={`rounded-md px-2 py-2 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  upscale === opt.id
                    ? 'bg-slate-800 text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {targetDims.upscaled ? (
            <div className="mt-3 space-y-3">
              {/* Upscale Engine Selector: CPU (Built-in) default vs WebGPU AI Upscaler */}
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#0B1120] p-1">
                <button
                  type="button"
                  onClick={() => onUpscaleEngineChange('cpu')}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    effectiveEngine === 'cpu'
                      ? 'bg-slate-800 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                  CPU (Built-in)
                </button>
                <button
                  type="button"
                  disabled={!canSelectAiEngine}
                  onClick={() => onUpscaleEngineChange('ai')}
                  title={aiTooltip}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    effectiveEngine === 'ai'
                      ? 'bg-slate-800 text-sky-300 cursor-pointer'
                      : canSelectAiEngine
                        ? 'text-slate-300 hover:text-slate-100 cursor-pointer'
                        : 'text-slate-500 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  AI Upscaler
                </button>
              </div>

              {effectiveEngine === 'cpu' ? (
                <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={detailEnhance}
                    onChange={(e) => onDetailEnhanceChange(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-400 cursor-pointer"
                  />
                  <span>Neural detail enhance (NNEDI3 + Adaptive Sharpen)</span>
                </label>
              ) : useAdminColab ? (
                <p className="text-[11px] text-sky-300/90">
                  Using RealESRGAN on {aiConnection.gpuName || 'Colab GPU'} · Original audio &amp; aspect preserved.
                </p>
              ) : (
                <div className="space-y-2">
                  {aiModelState.status === 'downloading' && (
                    <div className="space-y-1.5 rounded-lg border border-sky-500/30 bg-sky-950/30 p-2.5">
                      <div className="flex items-center justify-between text-[11px] text-sky-300">
                        <span>
                          {aiModelState.progress === null
                            ? 'Downloading AI model (size unknown)...'
                            : aiModelState.progress >= 100
                              ? 'Initializing AI engine...'
                              : 'Downloading AI model...'}
                        </span>
                        {aiModelState.progress !== null && (
                          <span className="font-mono tabular-nums">{aiModelState.progress}%</span>
                        )}
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                        {aiModelState.progress === null ? (
                          <div className="h-full w-2/5 animate-pulse rounded-full bg-sky-400" />
                        ) : (
                          <div
                            className="h-full bg-sky-400 transition-[width] duration-150"
                            style={{ width: `${Math.min(100, Math.max(0, aiModelState.progress))}%` }}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {aiModelState.status === 'ready' && (
                    <p className="text-[11px] text-emerald-400">
                      AI ready ({(aiModelState.provider || 'webgpu').toUpperCase()} ·{' '}
                      {aiModelState.modelName || 'realesr-general-x4v3.onnx'}, cached) · Max{' '}
                      {aiWebGpuLimits.maxDurationSec}s / {aiWebGpuLimits.maxHeight}p /{' '}
                      {aiWebGpuLimits.maxSizeMb} MB
                    </p>
                  )}

                  {aiModelState.status === 'error' && aiModelState.error && (
                    <p className="text-[11px] text-amber-300">{aiModelState.error}</p>
                  )}

                  {aiBlockedByLimits && (
                    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-950/30 p-2.5 text-[11px] text-amber-200">
                      <p>{webGpuLimitCheck.reason}</p>
                      <button
                        type="button"
                        onClick={() => onUpscaleEngineChange('cpu')}
                        className="w-full rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 cursor-pointer"
                      >
                        Use CPU mode
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Admin-only Colab GPU Tunnel (?admin=1) — hidden from normal users */}
              {isAdminMode && (
                <div className="rounded-lg border border-slate-800 bg-[#0B1120]/80 p-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-slate-300">Admin: Colab GPU Tunnel</span>
                    <a
                      href="/colab/ClearFrame_ComfyUI_Upscaler.ipynb"
                      download="ClearFrame_ComfyUI_Upscaler.ipynb"
                      className="inline-flex items-center gap-1 font-medium text-sky-400 hover:underline whitespace-nowrap"
                    >
                      <Download className="h-3 w-3" aria-hidden="true" />
                      Colab .ipynb
                    </a>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="url"
                      value={comfyUrlInput}
                      onChange={(e) => onComfyUrlInputChange(e.target.value)}
                      disabled={aiConnection.checking || aiConnection.connected}
                      placeholder="https://xxxx.trycloudflare.com"
                      aria-label="Colab ComfyUI HTTPS tunnel URL"
                      className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-70"
                    />
                    {aiConnection.connected ? (
                      <button
                        type="button"
                        onClick={onDisconnectColab}
                        className="shrink-0 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 cursor-pointer"
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onConnectColab}
                        disabled={aiConnection.checking || !comfyUrlInput.trim()}
                        className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-sky-300 hover:bg-slate-700 disabled:opacity-50 cursor-pointer"
                      >
                        {aiConnection.checking ? 'Checking...' : 'Connect'}
                      </button>
                    )}
                  </div>

                  {aiConnection.connected ? (
                    <p className="text-[11px] text-emerald-400">
                      GPU ready: {aiConnection.gpuName}
                      {aiConnection.vramGb ? ` (${aiConnection.vramGb} GB)` : ''} · Max {aiLimits.maxSizeMb} MB / {aiLimits.maxDurationSec}s
                    </p>
                  ) : aiConnection.error ? (
                    <p className="text-[11px] text-amber-300">{aiConnection.error}</p>
                  ) : (
                    <p className="text-[11px] text-slate-500">
                      Free T4 GPU via Colab · Max {aiLimits.maxSizeMb} MB / {aiLimits.maxDurationSec}s · Session only
                    </p>
                  )}

                  {!colabWithinLimits && (
                    <p className="text-[11px] text-amber-300">
                      This clip exceeds AI tunnel limit ({aiLimits.maxSizeMb} MB / {aiLimits.maxDurationSec}s) — using CPU upscaler.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : upscale !== 'original' ? (
            <p className="mt-2 text-xs text-slate-400">
              Source is already {video.width}×{video.height} (at or above {upscale.toUpperCase()}). Original resolution kept without upscaling or re-encoding loss.
            </p>
          ) : (
            <p className="mt-2 text-xs text-slate-400">
              Keep native {video.width}×{video.height} or upscale up to 4K UHD.
            </p>
          )}
        </div>

        {/* Selected Regions List (shown only when Remove Watermark is enabled) */}
        {removeWatermarkEnabled && (
          <div className="space-y-2.5 border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Watermark Regions ({regions.length})
              </span>
              {regions.length === 0 && (
                <button
                  type="button"
                  onClick={handleAddRegionButton}
                  className="text-xs font-medium text-sky-400 hover:underline cursor-pointer"
                >
                  + Add region
                </button>
              )}
            </div>

            {regions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-700 bg-[#0B1120]/60 px-3 py-4 text-center text-xs text-slate-400">
                {targetDims.upscaled
                  ? `No watermark boxes selected — video will be upscaled to ${upscale.toUpperCase()} only.`
                  : 'Draw a box over the watermark or click + Add region above.'}
              </p>
            ) : (
              <div className="max-h-52 space-y-2 overflow-y-auto pr-0.5">
              {regions.map((region) => {
                const isSelected = region.id === selectedId;
                return (
                  <div
                    key={region.id}
                    onClick={() => setSelectedId(region.id)}
                    className={`rounded-lg border p-2.5 text-xs transition-colors ${
                      isSelected
                        ? 'border-sky-500/70 bg-sky-500/10'
                        : 'border-slate-800 bg-[#0B1120]/70 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">{region.label}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRegion(region.id);
                        }}
                        aria-label={`Delete ${region.label}`}
                        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-slate-400 tabular-nums">
                      <span>
                        X:{region.x} Y:{region.y}
                      </span>
                      <span>
                        {region.w}×{region.h}px
                      </span>
                    </div>

                    {isSelected && (
                      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-800 pt-2">
                        <label className="block">
                          <span className="text-[11px] text-slate-400">Start (s)</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, Number(video.duration.toFixed(1)))}
                            step={0.1}
                            placeholder="0.0"
                            value={region.startTime ?? ''}
                            onChange={(e) =>
                              updateRegionField(region.id, {
                                startTime: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-slate-700 bg-[#0B1120] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[11px] text-slate-400">End (s)</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0.1, Number(video.duration.toFixed(1)))}
                            step={0.1}
                            placeholder={video.duration.toFixed(1)}
                            value={region.endTime ?? ''}
                            onChange={(e) =>
                              updateRegionField(region.id, {
                                endTime: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-slate-700 bg-[#0B1120] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {processError && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-red-500/40 bg-red-950/50 px-3 py-2.5 text-xs text-red-200"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
              <span>{processError}</span>
            </div>
            {processFallbackAvailable && (
              <button
                type="button"
                onClick={onContinueWithCpu}
                className="w-full rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 cursor-pointer"
              >
                Continue with CPU Upscaler
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onStartProcessing}
          disabled={!canProcess || aiBlockedByLimits}
          className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap cursor-pointer"
        >
          <Eraser className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{actionLabel}</span>
        </button>
      </aside>
    </div>
  );
};
