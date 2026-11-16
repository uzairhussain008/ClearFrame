import { useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { UploadDropzone } from './components/UploadDropzone';
import { WatermarkEditor } from './components/WatermarkEditor';
import { ComparisonResult } from './components/ComparisonResult';
import { Footer, InfoSections } from './components/InfoSections';
import {
  clampRegion,
  validateVideoFile,
  type ProcessingJobStatus,
  type RemovalMode,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from './utils/watermark';

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);

  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [regions, setRegions] = useState<WatermarkRegion[]>([]);
  const [mode, setMode] = useState<RemovalMode>('delogo');
  const [upscale, setUpscale] = useState<UpscalePreset>('original');
  const [detailEnhance, setDetailEnhance] = useState(true);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLoadedBytes, setUploadLoadedBytes] = useState(0);
  const [uploadTotalBytes, setUploadTotalBytes] = useState(0);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isLoadingSample, setIsLoadingSample] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ProcessingJobStatus | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);

  const initializeVideoWorkspace = (meta: VideoMetadata) => {
    setVideo(meta);
    setJobId(null);
    setJob(null);
    setProcessError(null);

    if (meta.suggestedRegion) {
      setRegions([
        clampRegion(
          {
            id: 'reg-default',
            label: 'Region 1',
            ...meta.suggestedRegion,
          },
          meta.width,
          meta.height
        ),
      ]);
    } else {
      const defaultW = Math.max(48, Math.round(meta.width * 0.22));
      const defaultH = Math.max(32, Math.round(meta.height * 0.09));
      setRegions([
        clampRegion(
          {
            id: 'reg-default',
            label: 'Region 1',
            x: Math.round(meta.width - defaultW - meta.width * 0.04),
            y: Math.round(meta.height - defaultH - meta.height * 0.05),
            w: defaultW,
            h: defaultH,
            startTime: null,
            endTime: null,
          },
          meta.width,
          meta.height
        ),
      ]);
    }
  };

  const activeUploadIdRef = useRef<string | null>(null);
  const uploadCancelledRef = useRef(false);

  const handleFileSelected = async (file: File) => {
    setUploadError(null);
    const check = validateVideoFile({
      name: file.name,
      size: file.size,
      type: file.type,
    });

    if (!check.valid) {
      setUploadError(check.error ?? 'Invalid video file.');
      return;
    }

    uploadCancelledRef.current = false;
    activeUploadIdRef.current = null;
    setIsUploading(true);
    setUploadProgress(0);
    setUploadLoadedBytes(0);
    setUploadTotalBytes(file.size);
    setUploadFileName(file.name);

    const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024;

    if (file.size <= CHUNK_THRESHOLD_BYTES) {
      const formData = new FormData();
      formData.append('video', file);

      const xhr = new XMLHttpRequest();
      activeXhrRef.current = xhr;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          setUploadLoadedBytes(event.loaded);
          setUploadTotalBytes(event.total);
          setUploadProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      };

      xhr.onload = () => {
        activeXhrRef.current = null;
        setIsUploading(false);

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText) as VideoMetadata;
            setUploadProgress(100);
            initializeVideoWorkspace(parsed);
          } catch {
            setUploadError('Received an unexpected server response.');
          }
        } else {
          try {
            const errPayload = JSON.parse(xhr.responseText) as { error?: string };
            setUploadError(errPayload.error ?? 'Failed to upload video.');
          } catch {
            setUploadError('Failed to upload video. Please try again.');
          }
        }
      };

      xhr.onerror = () => {
        activeXhrRef.current = null;
        setIsUploading(false);
        setUploadError('Network error while uploading. Please try again.');
      };

      xhr.onabort = () => {
        activeXhrRef.current = null;
        setIsUploading(false);
      };

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
      return;
    }

    try {
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          type: file.type,
        }),
      });
      const initData = (await initRes.json()) as {
        uploadId?: string;
        chunkSize?: number;
        error?: string;
      };
      if (!initRes.ok || !initData.uploadId) {
        throw new Error(initData.error || 'Could not initialize video upload.');
      }

      const uploadId = initData.uploadId;
      activeUploadIdRef.current = uploadId;
      const chunkSize = initData.chunkSize || CHUNK_THRESHOLD_BYTES;

      let offset = 0;
      let chunkIndex = 0;
      while (offset < file.size) {
        if (uploadCancelledRef.current) {
          return;
        }
        const end = Math.min(file.size, offset + chunkSize);
        const slice = file.slice(offset, end);
        const chunkOffset = offset;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeXhrRef.current = xhr;

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const totalLoaded = Math.min(file.size, chunkOffset + event.loaded);
              setUploadLoadedBytes(totalLoaded);
              setUploadProgress(Math.min(99, Math.round((totalLoaded / file.size) * 100)));
            }
          };

          xhr.onload = () => {
            activeXhrRef.current = null;
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              try {
                const errPayload = JSON.parse(xhr.responseText) as { error?: string };
                reject(new Error(errPayload.error || `Chunk ${chunkIndex + 1} upload failed.`));
              } catch {
                reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
              }
            }
          };

          xhr.onerror = () => {
            activeXhrRef.current = null;
            reject(new Error('Network error while uploading video chunk.'));
          };

          xhr.onabort = () => {
            activeXhrRef.current = null;
            reject(new Error('__ABORTED__'));
          };

          xhr.open('POST', `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${chunkIndex}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.send(slice);
        });

        offset = end;
        chunkIndex += 1;
        setUploadLoadedBytes(offset);
        setUploadProgress(Math.min(99, Math.round((offset / file.size) * 100)));
      }

      if (uploadCancelledRef.current) {
        return;
      }

      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });
      const completeData = (await completeRes.json()) as VideoMetadata & { error?: string };
      if (!completeRes.ok) {
        throw new Error(completeData.error || 'Failed to finalize uploaded video.');
      }

      activeUploadIdRef.current = null;
      setUploadProgress(100);
      setIsUploading(false);
      initializeVideoWorkspace(completeData);
    } catch (err) {
      activeXhrRef.current = null;
      const uploadIdToDelete = activeUploadIdRef.current;
      activeUploadIdRef.current = null;
      if (uploadIdToDelete) {
        fetch(`/api/upload/${uploadIdToDelete}`, { method: 'DELETE' }).catch(() => {});
      }
      setIsUploading(false);
      if (err instanceof Error && err.message === '__ABORTED__') {
        return;
      }
      setUploadError(err instanceof Error ? err.message : 'Failed to upload video.');
    }
  };

  const handleCancelUpload = () => {
    uploadCancelledRef.current = true;
    if (activeXhrRef.current) {
      activeXhrRef.current.abort();
      activeXhrRef.current = null;
    }
    if (activeUploadIdRef.current) {
      const id = activeUploadIdRef.current;
      activeUploadIdRef.current = null;
      fetch(`/api/upload/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    setIsUploading(false);
    setUploadProgress(0);
  };

  const handleTrySample = async () => {
    setUploadError(null);
    setIsLoadingSample(true);
    try {
      const res = await fetch('/api/sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not load sample video.');
      }
      initializeVideoWorkspace(data as VideoMetadata);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not load sample video.');
    } finally {
      setIsLoadingSample(false);
    }
  };

  const handleStartProcessing = async () => {
    if (!video || (regions.length === 0 && upscale === 'original')) return;
    setProcessError(null);

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: video.videoId,
          regions,
          mode,
          upscale,
          detailEnhance,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start video processing.');
      }
      setJobId(data.jobId);
      setJob({
        jobId: data.jobId,
        status: 'processing',
        progress: 2,
      });
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Processing failed to start.');
    }
  };

  useEffect(() => {
    if (!jobId || !job || job.status === 'completed' || job.status === 'failed') {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const data = (await res.json()) as ProcessingJobStatus;
        if (cancelled) return;
        setJob(data);
        if (data.status === 'failed') {
          setProcessError(data.error ?? 'Video processing failed.');
          setJobId(null);
        }
      } catch {
        // Ignore transient network poll glitch
      }
    };

    const timer = window.setInterval(poll, 450);
    poll();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, job?.status]);

  const handleResetWorkspace = () => {
    if (video) {
      fetch(`/api/videos/${video.videoId}`, { method: 'DELETE' }).catch(() => {});
    }
    setVideo(null);
    setRegions([]);
    setJobId(null);
    setJob(null);
    setProcessError(null);
    setUploadError(null);
  };

  const handleHeaderUploadClick = () => {
    const el = document.getElementById('workspace');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
    if (!video && !isUploading) {
      fileInputRef.current?.click();
    }
  };

  const isProcessing = Boolean(job && job.status === 'processing');
  const isCompleted = Boolean(job && job.status === 'completed' && job.outputUrl);

  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <Header onUploadClick={handleHeaderUploadClick} />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6 sm:py-12">
        {/* Hero Header */}
        <section id="workspace" className="scroll-mt-6">
          <div className="mx-auto max-w-3xl text-center">
            <h1
              className="font-display font-bold tracking-tight text-slate-50 text-center"
              style={{ fontSize: 'clamp(2.35rem, 4.4vw, 3.5rem)', lineHeight: 1.1, textWrap: 'balance' }}
            >
              Remove watermarks &amp;{' '}
              <span className="bg-gradient-to-r from-sky-400 to-cyan-300 bg-clip-text text-transparent">
                upscale videos up to 4K
              </span>
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-center text-base sm:text-lg leading-relaxed text-slate-300">
              Upload videos up to 300 MB, erase logos or text overlays cleanly, and optionally upscale up to 4K UHD without degrading original quality.
            </p>
            <p className="mt-3 text-center text-xs sm:text-sm font-medium text-slate-400">
              100% Free · Up to 300 MB · 1080p / 2K / 4K Upscaling · Original audio preserved
            </p>
          </div>

          {/* Interactive Workspace Area */}
          <div className="mt-8">
            {!video && (
              <UploadDropzone
                fileInputRef={fileInputRef}
                isUploading={isUploading}
                uploadProgress={uploadProgress}
                uploadLoadedBytes={uploadLoadedBytes}
                uploadTotalBytes={uploadTotalBytes}
                uploadFileName={uploadFileName}
                isLoadingSample={isLoadingSample}
                error={uploadError}
                onFileSelected={handleFileSelected}
                onTrySample={handleTrySample}
                onCancelUpload={handleCancelUpload}
                onDismissError={() => setUploadError(null)}
              />
            )}

            {video && !isCompleted && (
              <WatermarkEditor
                video={video}
                regions={regions}
                mode={mode}
                upscale={upscale}
                detailEnhance={detailEnhance}
                isProcessing={isProcessing}
                processProgress={job?.progress ?? 0}
                processError={processError}
                onRegionsChange={setRegions}
                onModeChange={setMode}
                onUpscaleChange={setUpscale}
                onDetailEnhanceChange={setDetailEnhance}
                onStartProcessing={handleStartProcessing}
                onChangeVideo={handleResetWorkspace}
              />
            )}

            {video && isCompleted && job && (
              <ComparisonResult
                video={video}
                job={job}
                regionsCount={regions.length}
                onEditRegions={() => {
                  setJob(null);
                  setJobId(null);
                  setProcessError(null);
                }}
                onReset={handleResetWorkspace}
              />
            )}
          </div>
        </section>

        <div className="mt-16">
          <InfoSections />
        </div>
      </main>

      <Footer />
    </div>
  );
}
