import React, { useRef, useState } from 'react';
import {
  Download,
  Play,
  Pause,
  SlidersHorizontal,
  Columns2,
  RotateCcw,
  CheckCircle2,
  Pencil,
} from 'lucide-react';
import {
  formatBytes,
  formatTimecode,
  type ProcessingJobStatus,
  type VideoMetadata,
} from '../utils/watermark';

interface ComparisonResultProps {
  video: VideoMetadata;
  job: ProcessingJobStatus;
  regionsCount: number;
  onEditRegions: () => void;
  onReset: () => void;
}

export const ComparisonResult: React.FC<ComparisonResultProps> = ({
  video,
  job,
  regionsCount,
  onEditRegions,
  onReset,
}) => {
  const beforeRef = useRef<HTMLVideoElement | null>(null);
  const afterRef = useRef<HTMLVideoElement | null>(null);
  const savedTimeRef = useRef(0);

  const [viewMode, setViewMode] = useState<'split' | 'side'>('split');
  const [splitPercent, setSplitPercent] = useState(50);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [outputPreviewError, setOutputPreviewError] = useState(false);

  React.useEffect(() => {
    setOutputPreviewError(false);
    setIsPlaying(false);
    setCurrentTime(0);
    savedTimeRef.current = 0;
  }, [job.outputUrl]);

  const restoreFrameTime = (el: HTMLVideoElement | null) => {
    if (!el) return;
    const targetTime = savedTimeRef.current;
    if (targetTime > 0.05 && el.paused && Math.abs(el.currentTime - targetTime) > 0.03) {
      try {
        const safeMax = Math.max(0.05, (el.duration || video.duration) - 0.05);
        el.currentTime = Math.min(targetTime, safeMax);
      } catch {
        // Ignore seek errors before stream stabilizes
      }
    }
  };

  const handleSwitchViewMode = (nextMode: 'split' | 'side') => {
    if (nextMode === viewMode) return;
    const activeTime = afterRef.current?.currentTime ?? beforeRef.current?.currentTime ?? currentTime;
    savedTimeRef.current = activeTime;
    afterRef.current?.pause();
    beforeRef.current?.pause();
    setIsPlaying(false);
    setViewMode(nextMode);
  };

  const syncPlayState = () => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;

    if (after.paused) {
      before.currentTime = after.currentTime;
      Promise.all([after.play(), before.play()])
        .then(() => setIsPlaying(true))
        .catch(() => {
          // If one stream blocks autoplay, try playing output alone
          after.play().then(() => setIsPlaying(true)).catch(() => {});
        });
    } else {
      after.pause();
      before.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    savedTimeRef.current = val;
    if (afterRef.current) afterRef.current.currentTime = val;
    if (beforeRef.current) beforeRef.current.currentTime = val;
    setCurrentTime(val);
  };

  const handleAfterTimeUpdate = () => {
    const after = afterRef.current;
    if (!after) return;
    savedTimeRef.current = after.currentTime;
    setCurrentTime(after.currentTime);
    if (beforeRef.current && Math.abs(beforeRef.current.currentTime - after.currentTime) > 0.2) {
      beforeRef.current.currentTime = after.currentTime;
    }
  };

  const displayW = job.outputWidth ?? video.width;
  const displayH = job.outputHeight ?? video.height;

  return (
    <div
      data-testid="comparison-result"
      className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 sm:p-6 space-y-6"
    >
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-50">
              {regionsCount > 0 && job.upscale && job.upscale !== 'original'
                ? `Watermark removed & upscaled to ${job.upscale.toUpperCase()}`
                : regionsCount === 0 && job.upscale && job.upscale !== 'original'
                  ? `Video upscaled to ${job.upscale.toUpperCase()}`
                  : 'Watermark removed'}
            </h2>
            <p className="text-xs text-slate-400 truncate max-w-md">{video.originalName}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center rounded-lg bg-[#0B1120] p-1">
            <button
              type="button"
              onClick={() => handleSwitchViewMode('split')}
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                viewMode === 'split'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              Split Slider
            </button>
            <button
              type="button"
              onClick={() => handleSwitchViewMode('side')}
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                viewMode === 'side'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
              Side by Side
            </button>
          </div>
        </div>
      </div>

      {outputPreviewError && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          Your device browser could not preview the {displayW}×{displayH} stream inline, but the processed file is ready to download below.
        </p>
      )}

      {/* Video Comparison Viewport */}
      {viewMode === 'split' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Before (Left)</span>
            <span className="text-sky-400">After (Right)</span>
          </div>
          <div className="relative flex w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950">
            <div
              className="relative mx-auto w-full select-none"
              style={{
                aspectRatio: `${displayW} / ${displayH}`,
                maxHeight: '400px',
                maxWidth: `calc(400px * ${displayW} / ${displayH})`,
              }}
            >
              {/* Cleaned Output Layer (Right side / Base) */}
              <video
                ref={afterRef}
                src={job.outputUrl}
                playsInline
                preload="auto"
                onLoadedData={() => restoreFrameTime(afterRef.current)}
                onError={() => setOutputPreviewError(true)}
                onEnded={() => {
                  beforeRef.current?.pause();
                  setIsPlaying(false);
                }}
                onTimeUpdate={handleAfterTimeUpdate}
                className="h-full w-full object-contain"
              />

              {/* Original Video Layer (Left side, clipped by splitPercent) */}
              <video
                ref={beforeRef}
                src={video.previewUrl}
                muted
                playsInline
                preload="auto"
                onLoadedData={() => restoreFrameTime(beforeRef.current)}
                style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              />

              {/* Split Line Divider */}
              <div
                style={{ left: `${splitPercent}%` }}
                className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-sky-400 shadow-sm"
              >
                <div className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sky-400 bg-slate-950 text-sky-400 shadow">
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </div>
              </div>

              {/* Transparent full-stage range slider for smooth drag */}
              <input
                type="range"
                min={0}
                max={100}
                value={splitPercent}
                onChange={(e) => setSplitPercent(Number(e.target.value))}
                aria-label="Drag to compare before and after video"
                className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-300">
              Original
            </div>
            <div className="flex items-center justify-center bg-slate-950">
              <video
                ref={beforeRef}
                src={video.previewUrl}
                muted
                playsInline
                preload="auto"
                onLoadedData={() => restoreFrameTime(beforeRef.current)}
                style={{
                  aspectRatio: `${video.width} / ${video.height}`,
                  maxHeight: '360px',
                  maxWidth: `calc(360px * ${video.width} / ${video.height})`,
                }}
                className="mx-auto w-full object-contain"
              />
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-sky-400">
              Clean Output
            </div>
            <div className="flex items-center justify-center bg-slate-950">
              <video
                ref={afterRef}
                src={job.outputUrl}
                playsInline
                preload="auto"
                onLoadedData={() => restoreFrameTime(afterRef.current)}
                onError={() => setOutputPreviewError(true)}
                onEnded={() => {
                  beforeRef.current?.pause();
                  setIsPlaying(false);
                }}
                onTimeUpdate={handleAfterTimeUpdate}
                style={{
                  aspectRatio: `${displayW} / ${displayH}`,
                  maxHeight: '360px',
                  maxWidth: `calc(360px * ${displayW} / ${displayH})`,
                }}
                className="mx-auto w-full object-contain"
              />
            </div>
          </div>
        </div>
      )}

      {/* Synced Playback Bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={syncPlayState}
          aria-label={isPlaying ? 'Pause comparison playback' : 'Play comparison playback'}
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
          aria-label="Seek comparison playback"
          className="h-2 w-full accent-sky-400 cursor-pointer"
        />

        <span className="font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap shrink-0">
          {formatTimecode(currentTime)} / {formatTimecode(video.duration)}
        </span>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-4 border-y border-slate-800 py-4 sm:grid-cols-4">
        <div>
          <span className="block text-xs text-slate-400">Original</span>
          <span className="mt-0.5 block font-mono text-sm font-semibold text-slate-50 tabular-nums">
            {video.width}×{video.height} · {formatBytes(video.size)}
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-400">Output Resolution</span>
          <span className="mt-0.5 block font-mono text-sm font-semibold text-sky-400 tabular-nums">
            {job.outputWidth ?? video.width}×{job.outputHeight ?? video.height}
            {job.upscale && job.upscale !== 'original' ? ` (${job.upscale.toUpperCase()})` : ''}
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-400">Output Size</span>
          <span className="mt-0.5 block font-mono text-sm font-semibold text-slate-50 tabular-nums">
            {job.outputSize ? formatBytes(job.outputSize) : 'Ready'}
          </span>
        </div>
        <div>
          <span className="block text-xs text-slate-400">Processing Time</span>
          <span className="mt-0.5 block font-mono text-sm font-semibold text-slate-50 tabular-nums">
            {job.processingMs ? `${(job.processingMs / 1000).toFixed(1)}s` : 'Done'}
          </span>
        </div>
      </div>

      {/* Primary & Secondary Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={job.downloadUrl}
            download
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Download Clean Video
          </a>

          <button
            type="button"
            onClick={onEditRegions}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-100 transition-colors hover:border-slate-600 hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Pencil className="h-4 w-4 text-sky-400" aria-hidden="true" />
            Adjust Regions
          </button>
        </div>

        <button
          type="button"
          onClick={onReset}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Process Another Video
        </button>
      </div>
    </div>
  );
};
