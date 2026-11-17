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
} from 'lucide-react';
import {
  clampRegion,
  computeUpscaleDimensions,
  formatBytes,
  formatTimecode,
  type RemovalMode,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from '../utils/watermark';

interface WatermarkEditorProps {
  video: VideoMetadata;
  removeWatermarkEnabled: boolean;
  regions: WatermarkRegion[];
  mode: RemovalMode;
  upscale: UpscalePreset;
  detailEnhance: boolean;
  isProcessing: boolean;
  processStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  queuePosition?: number;
  processProgress: number;
  processError: string | null;
  onRemoveWatermarkToggle: (enabled: boolean) => void;
  onRegionsChange: (regions: WatermarkRegion[]) => void;
  onModeChange: (mode: RemovalMode) => void;
  onUpscaleChange: (upscale: UpscalePreset) => void;
  onDetailEnhanceChange: (enabled: boolean) => void;
  onStartProcessing: () => void;
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
  removeWatermarkEnabled,
  regions,
  mode,
  upscale,
  detailEnhance,
  isProcessing,
  processStatus,
  queuePosition,
  processProgress,
  processError,
  onRemoveWatermarkToggle,
  onRegionsChange,
  onModeChange,
  onUpscaleChange,
  onDetailEnhanceChange,
  onStartProcessing,
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

  const actionLabel =
    activeRegionCount > 0 && targetDims.upscaled
      ? `Remove Watermark & Upscale (${upscale.toUpperCase()})`
      : activeRegionCount === 0 && targetDims.upscaled
        ? `Upscale Video to ${upscale.toUpperCase()}`
        : !removeWatermarkEnabled
          ? 'Select Upscale or Remove Watermark'
          : 'Remove Watermark';

  const processingTitle =
    activeRegionCount > 0 && targetDims.upscaled
      ? `Removing watermark & upscaling to ${upscale.toUpperCase()}`
      : activeRegionCount === 0 && targetDims.upscaled
        ? `Upscaling video to ${upscale.toUpperCase()}`
        : 'Removing watermark from video';

  if (isProcessing) {
    const isQueued = processStatus === 'queued';
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
                {activeRegionCount > 0 ? `${activeMode.label} · ` : ''}
                {targetDims.width}×{targetDims.height}
              </span>
              <span className="font-mono text-sm font-semibold text-sky-400 tabular-nums">
                {isQueued ? 'Waiting' : `${processProgress}%`}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-sky-500 transition-[width] duration-200 ease-out"
                style={{ width: `${isQueued ? 4 : Math.max(4, processProgress)}%` }}
              />
            </div>
          </div>

          <p className="text-xs text-slate-400">
            {isQueued
              ? 'Waiting for an available processing slot. Your job will start automatically.'
              : 'Encoding visually lossless frames and preserving original audio. Keep this tab open.'}
          </p>
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
            <label className="mt-2.5 flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={detailEnhance}
                onChange={(e) => onDetailEnhanceChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-400 cursor-pointer"
              />
              <span>
                Neural detail enhance (NNEDI3 + Adaptive Sharpen)
              </span>
            </label>
          ) : upscale !== 'original' ? (
            <p className="mt-2 text-xs text-slate-400">
              Source is already {video.width}×{video.height}. Original resolution kept without downscaling.
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
            className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/50 px-3 py-2.5 text-xs text-red-200"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
            <span>{processError}</span>
          </div>
        )}

        <button
          type="button"
          onClick={onStartProcessing}
          disabled={!canProcess}
          className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap cursor-pointer"
        >
          <Eraser className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{actionLabel}</span>
        </button>
      </aside>
    </div>
  );
};
