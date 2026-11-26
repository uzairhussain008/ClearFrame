import React, { useState } from 'react';
import { Columns2, Download, Pencil, RotateCcw, SlidersHorizontal, CheckCircle2 } from 'lucide-react';

interface PhotoComparisonViewProps {
  title: string;
  subtitle: string;
  beforeUrl: string;
  afterUrl: string;
  beforeWidth: number;
  beforeHeight: number;
  afterWidth: number;
  afterHeight: number;
  downloadLabel: string;
  onDownload: () => void;
  editLabel?: string;
  onEdit?: () => void;
  onReset: () => void;
}

export const PhotoComparisonView: React.FC<PhotoComparisonViewProps> = ({
  title,
  subtitle,
  beforeUrl,
  afterUrl,
  beforeWidth,
  beforeHeight,
  afterWidth,
  afterHeight,
  downloadLabel,
  onDownload,
  editLabel,
  onEdit,
  onReset,
}) => {
  const [viewMode, setViewMode] = useState<'split' | 'side'>('split');
  const [splitPercent, setSplitPercent] = useState(50);

  return (
    <div
      data-testid="photo-comparison-result"
      className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 sm:p-6 space-y-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-50">{title}</h2>
            <p className="text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center rounded-lg bg-[#0B1120] p-1">
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              viewMode === 'split' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Split Slider
          </button>
          <button
            type="button"
            onClick={() => setViewMode('side')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              viewMode === 'side' ? 'bg-slate-800 text-sky-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
            Side by Side
          </button>
        </div>
      </div>

      {viewMode === 'split' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Before (Left · {beforeWidth}×{beforeHeight})</span>
            <span className="text-sky-400">After (Right · {afterWidth}×{afterHeight})</span>
          </div>
          <div className="relative flex w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950 p-2">
            <div
              className="relative mx-auto w-full select-none"
              style={{
                aspectRatio: `${afterWidth} / ${afterHeight}`,
                maxHeight: '460px',
                maxWidth: `calc(460px * ${afterWidth} / ${afterHeight})`,
              }}
            >
              <img
                src={afterUrl}
                alt="Processed output"
                className="h-full w-full object-contain pointer-events-none select-none"
              />
              <img
                src={beforeUrl}
                alt="Original input"
                className="absolute inset-0 h-full w-full object-contain pointer-events-none select-none"
                style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-sky-400"
                style={{ left: `${splitPercent}%`, transform: 'translateX(-50%)' }}
              >
                <div className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sky-400 bg-slate-950 text-sky-300">
                  <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={splitPercent}
                aria-label="Before and after comparison slider"
                onChange={(e) => setSplitPercent(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-400">
              Original ({beforeWidth}×{beforeHeight})
            </div>
            <img
              src={beforeUrl}
              alt="Original photo"
              className="w-full max-h-[380px] object-contain bg-slate-950"
            />
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-sky-400">
              Processed ({afterWidth}×{afterHeight})
            </div>
            <img
              src={afterUrl}
              alt="Processed photo"
              className="w-full max-h-[380px] object-contain bg-slate-950"
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {onEdit && editLabel && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 cursor-pointer"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {editLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 cursor-pointer"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            New Photo
          </button>
        </div>

        <button
          type="button"
          onClick={onDownload}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 cursor-pointer"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {downloadLabel}
        </button>
      </div>
    </div>
  );
};
