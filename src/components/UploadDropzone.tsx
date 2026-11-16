import React, { useRef, useState } from 'react';
import { Upload, Film, AlertCircle, X } from 'lucide-react';
import { MAX_VIDEO_SIZE_MB, formatBytes } from '../utils/watermark';

interface UploadDropzoneProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isUploading: boolean;
  uploadProgress: number;
  uploadLoadedBytes: number;
  uploadTotalBytes: number;
  uploadFileName: string;
  isLoadingSample: boolean;
  error: string | null;
  onFileSelected: (file: File) => void;
  onTrySample: () => void;
  onCancelUpload: () => void;
  onDismissError: () => void;
}

export const UploadDropzone: React.FC<UploadDropzoneProps> = ({
  fileInputRef,
  isUploading,
  uploadProgress,
  uploadLoadedBytes,
  uploadTotalBytes,
  uploadFileName,
  isLoadingSample,
  error,
  onFileSelected,
  onTrySample,
  onCancelUpload,
  onDismissError,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);

    if (isUploading || isLoadingSample) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onFileSelected(file);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelected(file);
    }
    e.target.value = '';
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 sm:p-6">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v"
        onChange={handleInputChange}
        className="sr-only"
        aria-label="Choose video file to upload"
      />

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-950/50 px-4 py-3 text-sm text-red-200"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss upload error"
            className="rounded p-1 text-red-300 hover:bg-red-900/50 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isUploading ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-slate-800 bg-[#0B1120]/70 px-6 py-14 text-center">
          <div className="w-full max-w-md space-y-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="truncate font-medium text-slate-100">{uploadFileName}</span>
              <span className="font-mono text-sm font-semibold text-sky-400 tabular-nums shrink-0">
                {uploadProgress}%
              </span>
            </div>

            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-sky-500 transition-[width] duration-150 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-mono tabular-nums">
                {formatBytes(uploadLoadedBytes)} / {formatBytes(uploadTotalBytes)}
              </span>
              <button
                type="button"
                onClick={onCancelUpload}
                className="font-medium text-slate-300 underline underline-offset-2 hover:text-white cursor-pointer"
              >
                Cancel upload
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          data-testid="upload-dropzone"
          className={`flex flex-col items-center justify-center rounded-lg border border-dashed px-5 py-12 sm:px-8 sm:py-14 text-center transition-colors ${
            isDragging
              ? 'border-sky-400 bg-sky-500/10'
              : 'border-slate-700 bg-[#0B1120]/60 hover:border-sky-500/60'
          }`}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-400">
            <Upload className="h-5 w-5" aria-hidden="true" />
          </div>

          <h2 className="font-display text-lg font-semibold text-slate-50">
            Drop your video to clean &amp; upscale
          </h2>

          <p className="mt-1.5 max-w-md text-sm text-slate-400">
            Select MP4, MOV, WebM, MKV, AVI, or M4V files up to{' '}
            <span className="font-semibold text-slate-100 tabular-nums">{MAX_VIDEO_SIZE_MB} MB</span>.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoadingSample}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              Choose Video File
            </button>

            <button
              type="button"
              onClick={onTrySample}
              disabled={isLoadingSample}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-100 transition-colors hover:border-slate-600 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Film className="h-4 w-4 text-sky-400" aria-hidden="true" />
              {isLoadingSample ? 'Loading Sample...' : 'Try Sample Video'}
            </button>
          </div>

          <p className="mt-5 text-xs text-slate-400">
            100% Free · No signup or API keys · Original audio preserved
          </p>
        </div>
      )}
    </div>
  );
};
