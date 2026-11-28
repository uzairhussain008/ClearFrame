import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { UploadDropzone } from './components/UploadDropzone';
import { Footer, InfoSections } from './components/InfoSections';
import { AdBannerSlot } from './components/AdBannerSlot';

const WatermarkEditor = lazy(() =>
  import('./components/WatermarkEditor').then((m) => ({ default: m.WatermarkEditor }))
);
const ComparisonResult = lazy(() =>
  import('./components/ComparisonResult').then((m) => ({ default: m.ComparisonResult }))
);
import {
  clampRegion,
  validateVideoFile,
  type ProcessingJobStatus,
  type RemovalMode,
  type UpscaleEngine,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from './utils/watermark';
import { validateComfyUrlFormat } from './utils/comfyUrlGuard';
import {
  DEFAULT_AI_CLIENT_LIMITS,
  checkAiVideoLimits,
  detectWebGpuSupport,
  disposeWebGpuAiSession,
  ensureWebGpuAiSession,
  runBrowserWebGpuUpscale,
  type AiClientLimits,
  type AiProvider,
  type WebGpuSupportResult,
} from './utils/webgpuUpscaler';

export interface AiConnectionState {
  connected: boolean;
  checking: boolean;
  gpuName?: string;
  vramGb?: number;
  error?: string;
}

export interface AiLimits {
  maxSizeMb: number;
  maxDurationSec: number;
}

export interface AiModelState {
  status: 'idle' | 'downloading' | 'ready' | 'error';
  progress: number | null;
  provider?: AiProvider;
  modelName?: string;
  error?: string;
}

export interface ClientAiProgressState {
  active: boolean;
  stage: string;
  doneFrames: number;
  totalFrames: number;
  percent: number;
  etaSeconds: number | null;
  msPerFrame: number | null;
  provider?: AiProvider;
  modelName?: string;
  jobId?: string;
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const modelAbortControllerRef = useRef<AbortController | null>(null);

  const [isAdminMode] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('admin') === '1'
  );

  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [removeWatermarkEnabled, setRemoveWatermarkEnabled] = useState(false);
  const [regions, setRegions] = useState<WatermarkRegion[]>([]);
  const [mode, setMode] = useState<RemovalMode>('delogo');
  const [upscale, setUpscale] = useState<UpscalePreset>('original');
  const [detailEnhance, setDetailEnhance] = useState(true);
  const [upscaleEngine, setUpscaleEngine] = useState<UpscaleEngine>('cpu');

  // Client-side WebGPU AI state
  const [webGpuSupport, setWebGpuSupport] = useState<WebGpuSupportResult & { checked: boolean }>({
    checked: false,
    supported: false,
    reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
  });
  const [aiWebGpuLimits, setAiWebGpuLimits] = useState<AiClientLimits>(DEFAULT_AI_CLIENT_LIMITS);
  const [aiModelState, setAiModelState] = useState<AiModelState>({
    status: 'idle',
    progress: 0,
  });
  const [clientAiProgress, setClientAiProgress] = useState<ClientAiProgressState>({
    active: false,
    stage: '',
    doneFrames: 0,
    totalFrames: 0,
    percent: 0,
    etaSeconds: null,
    msPerFrame: null,
  });

  // Session-only Colab GPU tunnel state (admin ?admin=1 only, never persisted)
  const [comfyUrlInput, setComfyUrlInput] = useState('');
  const [connectedComfyUrl, setConnectedComfyUrl] = useState('');
  const [aiConnection, setAiConnection] = useState<AiConnectionState>({
    connected: false,
    checking: false,
  });
  const [aiLimits, setAiLimits] = useState<AiLimits>({
    maxSizeMb: 50,
    maxDurationSec: 60,
  });

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLoadedBytes, setUploadLoadedBytes] = useState(0);
  const [uploadTotalBytes, setUploadTotalBytes] = useState(0);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ProcessingJobStatus | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processFallbackAvailable, setProcessFallbackAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    detectWebGpuSupport()
      .then((res) => {
        if (active) {
          setWebGpuSupport({ checked: true, ...res });
        }
      })
      .catch(() => {
        if (active) {
          setWebGpuSupport({
            checked: true,
            supported: false,
            reason: "Your browser/device doesn't support GPU AI upscaling. Using CPU mode.",
          });
        }
      });

    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { aiLimits?: AiLimits; aiWebGpuLimits?: AiClientLimits } | null) => {
        if (!active || !data) return;
        if (data.aiLimits?.maxSizeMb && data.aiLimits?.maxDurationSec) {
          setAiLimits(data.aiLimits);
        }
        if (
          data.aiWebGpuLimits?.maxDurationSec &&
          data.aiWebGpuLimits?.maxHeight &&
          data.aiWebGpuLimits?.maxSizeMb
        ) {
          setAiWebGpuLimits(data.aiWebGpuLimits);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  const createDefaultRegion = (meta: VideoMetadata): WatermarkRegion => {
    const defaultW = Math.max(48, Math.round(meta.width * 0.22));
    const defaultH = Math.max(32, Math.round(meta.height * 0.09));
    return clampRegion(
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
    );
  };

  const initializeVideoWorkspace = (meta: VideoMetadata) => {
    setVideo(meta);
    setJobId(null);
    setJob(null);
    setProcessError(null);
    setProcessFallbackAvailable(false);
    // Keep CPU as safe default whenever a new video is loaded
    setUpscaleEngine('cpu');

    if (meta.suggestedRegion) {
      setRemoveWatermarkEnabled(true);
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
      setRemoveWatermarkEnabled(false);
      setRegions([]);
    }
  };

  const handleToggleRemoveWatermark = (enabled: boolean) => {
    setRemoveWatermarkEnabled(enabled);
    if (enabled && video && regions.length === 0) {
      setRegions([createDefaultRegion(video)]);
    } else if (!enabled) {
      setRegions([]);
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

  const handleConnectColab = async () => {
    const check = validateComfyUrlFormat(comfyUrlInput);
    if (!check.valid || !check.origin) {
      setConnectedComfyUrl('');
      setUpscaleEngine('cpu');
      setAiConnection({
        connected: false,
        checking: false,
        error: check.error || 'Enter a valid HTTPS tunnel URL.',
      });
      return;
    }

    setAiConnection({ connected: false, checking: true });
    try {
      const res = await fetch('/api/ai/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comfyUrl: check.origin }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        gpuName?: string;
        vramGb?: number;
        error?: string;
        limits?: AiLimits;
      };
      if (data.limits) {
        setAiLimits(data.limits);
      }
      if (!res.ok || !data.ok) {
        setConnectedComfyUrl('');
        setUpscaleEngine('cpu');
        setAiConnection({
          connected: false,
          checking: false,
          error: data.error || 'Could not verify a GPU on that Colab URL.',
        });
        return;
      }

      setComfyUrlInput(check.origin);
      setConnectedComfyUrl(check.origin);
      setAiConnection({
        connected: true,
        checking: false,
        gpuName: data.gpuName || 'NVIDIA GPU',
        vramGb: data.vramGb,
      });
    } catch {
      setConnectedComfyUrl('');
      setUpscaleEngine('cpu');
      setAiConnection({
        connected: false,
        checking: false,
        error: 'Network error checking Colab URL.',
      });
    }
  };

  const handleDisconnectColab = () => {
    setConnectedComfyUrl('');
    setComfyUrlInput('');
    setUpscaleEngine('cpu');
    setAiConnection({ connected: false, checking: false });
  };

  const handleSelectUpscaleEngine = async (nextEngine: UpscaleEngine) => {
    setProcessError(null);
    setProcessFallbackAvailable(false);
    if (nextEngine === 'cpu') {
      setUpscaleEngine('cpu');
      return;
    }

    const useAdminColab = isAdminMode && aiConnection.connected && Boolean(connectedComfyUrl);
    if (useAdminColab) {
      setUpscaleEngine('ai');
      return;
    }

    if (!webGpuSupport.supported) {
      setUpscaleEngine('cpu');
      return;
    }

    setUpscaleEngine('ai');
    if (aiModelState.status === 'ready' || aiModelState.status === 'downloading') {
      return;
    }

    const abortController = new AbortController();
    modelAbortControllerRef.current = abortController;
    setAiModelState({ status: 'downloading', progress: 0 });
    try {
      const sessionInfo = await ensureWebGpuAiSession(
        (pct) => setAiModelState({ status: 'downloading', progress: pct }),
        abortController.signal
      );
      if (!abortController.signal.aborted) {
        setAiModelState({
          status: 'ready',
          progress: 100,
          provider: sessionInfo.provider,
          modelName: sessionInfo.modelName,
        });
      }
    } catch (err) {
      if (abortController.signal.aborted) return;
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not initialize AI model on WebGPU or WASM.';
      setAiModelState({ status: 'error', progress: 0, error: msg });
      setProcessError(msg);
      setProcessFallbackAvailable(true);
    } finally {
      if (modelAbortControllerRef.current === abortController) {
        modelAbortControllerRef.current = null;
      }
    }
  };

  const handleStartProcessing = async (overrideEngine?: UpscaleEngine) => {
    const activeRegions = removeWatermarkEnabled ? regions : [];
    if (!video || (activeRegions.length === 0 && upscale === 'original')) return;

    const useAdminColab = isAdminMode && aiConnection.connected && Boolean(connectedComfyUrl);
    const effectiveEngine: UpscaleEngine =
      overrideEngine === 'cpu'
        ? 'cpu'
        : upscaleEngine === 'ai' && upscale !== 'original' && (useAdminColab || webGpuSupport.supported)
          ? 'ai'
          : 'cpu';

    setProcessError(null);
    setProcessFallbackAvailable(false);

    // Client-side 100% WebGPU/WASM AI upscaler path
    if (effectiveEngine === 'ai' && !useAdminColab) {
      const limitCheck = checkAiVideoLimits(video, aiWebGpuLimits);
      if (!limitCheck.allowed) {
        setProcessError(limitCheck.reason || 'Video exceeds AI Upscaler limits.');
        setProcessFallbackAvailable(true);
        return;
      }

      const abortController = new AbortController();
      aiAbortControllerRef.current = abortController;
      let aiJobId: string | null = null;

      setClientAiProgress({
        active: true,
        stage: aiModelState.status === 'ready' ? 'Preparing AI frames...' : 'Loading AI model...',
        doneFrames: 0,
        totalFrames: 0,
        percent: 1,
        etaSeconds: null,
        msPerFrame: null,
        provider: aiModelState.provider,
        modelName: aiModelState.modelName,
      });

      try {
        setAiModelState((prev) =>
          prev.status === 'ready' ? prev : { status: 'downloading', progress: prev.progress ?? null }
        );
        const sessionInfo = await ensureWebGpuAiSession((pct) => {
          setAiModelState({ status: 'downloading', progress: pct });
        }, abortController.signal);
        setAiModelState({
          status: 'ready',
          progress: 100,
          provider: sessionInfo.provider,
          modelName: sessionInfo.modelName,
        });

        if (abortController.signal.aborted) {
          throw new Error('Cancelled');
        }

        setClientAiProgress((prev) => ({
          ...prev,
          stage: 'Preparing source video...',
          percent: 2,
          provider: sessionInfo.provider,
          modelName: sessionInfo.modelName,
        }));

        const initRes = await fetch('/api/jobs/ai-init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            videoId: video.videoId,
            regions: activeRegions,
            mode,
            upscale,
          }),
        });
        const initData = (await initRes.json()) as {
          jobId?: string;
          sourceUrl?: string;
          sourceWidth?: number;
          sourceHeight?: number;
          targetWidth?: number;
          targetHeight?: number;
          fps?: number;
          duration?: number;
          frameTimestampsSec?: number[];
          error?: string;
        };
        if (
          !initRes.ok ||
          !initData.jobId ||
          !initData.sourceUrl ||
          !initData.targetWidth ||
          !initData.targetHeight
        ) {
          throw new Error(initData.error || 'Could not initialize AI upscaling job.');
        }

        aiJobId = initData.jobId;
        setClientAiProgress((prev) => ({
          ...prev,
          jobId: aiJobId ?? undefined,
          stage: `AI Upscaling (${upscale.toUpperCase()})`,
          percent: 3,
        }));

        const aiResult = await runBrowserWebGpuUpscale({
          sourceUrl: initData.sourceUrl,
          sourceWidth: initData.sourceWidth ?? video.width,
          sourceHeight: initData.sourceHeight ?? video.height,
          targetWidth: initData.targetWidth,
          targetHeight: initData.targetHeight,
          fps: initData.fps ?? video.fps,
          duration: initData.duration ?? video.duration,
          frameTimestampsSec: initData.frameTimestampsSec,
          signal: abortController.signal,
          onModelProgress: (pct) => {
            setAiModelState((prev) =>
              prev.status === 'ready' ? prev : { status: 'downloading', progress: pct }
            );
          },
          onFrameProgress: ({ doneFrames, totalFrames, percent, etaSeconds, msPerFrame, provider, modelName }) => {
            setClientAiProgress({
              active: true,
              jobId: aiJobId ?? undefined,
              stage: `AI Upscaling (${upscale.toUpperCase()})`,
              doneFrames,
              totalFrames,
              percent,
              etaSeconds,
              msPerFrame,
              provider,
              modelName,
            });
          },
        });

        if (abortController.signal.aborted) {
          throw new Error('Cancelled');
        }

        setClientAiProgress((prev) => ({
          ...prev,
          stage: 'Muxing original audio...',
          percent: 95,
          etaSeconds: null,
          provider: aiResult.provider,
        }));

        const formData = new FormData();
        formData.append('video', new File([aiResult.blob], 'ai-upscaled.mp4', { type: 'video/mp4' }));
        formData.append('codec', aiResult.muxerCodec);

        const finRes = await fetch(`/api/jobs/${aiJobId}/finalize-ai`, {
          method: 'POST',
          signal: abortController.signal,
          body: formData,
        });
        const finData = (await finRes.json()) as ProcessingJobStatus & { error?: string };
        if (!finRes.ok || finData.status !== 'completed') {
          throw new Error(finData.error || 'Failed to finalize AI upscaled MP4.');
        }

        setClientAiProgress({
          active: false,
          stage: '',
          doneFrames: 0,
          totalFrames: 0,
          percent: 100,
          etaSeconds: null,
          msPerFrame: null,
        });
        setJobId(finData.jobId);
        setJob(finData);
      } catch (err) {
        const wasAborted =
          abortController.signal.aborted ||
          (err instanceof Error && (err.name === 'AbortError' || err.message === 'Cancelled'));

        if (aiJobId) {
          fetch(`/api/jobs/${aiJobId}/cancel-ai`, { method: 'POST' }).catch(() => {});
        }

        setClientAiProgress({
          active: false,
          stage: '',
          doneFrames: 0,
          totalFrames: 0,
          percent: 0,
          etaSeconds: null,
          msPerFrame: null,
        });

        if (!wasAborted) {
          await disposeWebGpuAiSession();
          const message =
            err instanceof Error
              ? err.message
              : 'AI upscaling stopped unexpectedly. You can continue with the CPU upscaler.';
          setAiModelState({ status: 'error', progress: 0, error: message });
          setProcessError(message);
          setProcessFallbackAvailable(true);
        }
      } finally {
        if (aiAbortControllerRef.current === abortController) {
          aiAbortControllerRef.current = null;
        }
      }
      return;
    }

    // Standard CPU queue path (or Admin Colab GPU path when ?admin=1 + tunnel connected)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: video.videoId,
          regions: activeRegions,
          mode,
          upscale,
          detailEnhance,
          upscaleEngine: effectiveEngine,
          comfyUrl: effectiveEngine === 'ai' && useAdminColab ? connectedComfyUrl : undefined,
        }),
      });
      const data = (await res.json()) as {
        jobId?: string;
        status?: 'queued' | 'processing';
        queuePosition?: number;
        error?: string;
        aiUnavailable?: boolean;
      };
      if (!res.ok || !data.jobId) {
        if (data.aiUnavailable) {
          setConnectedComfyUrl('');
          setUpscaleEngine('cpu');
          setAiConnection({
            connected: false,
            checking: false,
            error: data.error || 'Colab GPU tunnel is offline.',
          });
          setProcessFallbackAvailable(true);
        }
        throw new Error(data.error || 'Failed to start video processing.');
      }
      setJobId(data.jobId);
      setJob({
        jobId: data.jobId,
        status: data.status === 'queued' ? 'queued' : 'processing',
        progress: data.status === 'queued' ? 0 : 2,
        upscaleEngine: effectiveEngine,
        queuePosition: typeof data.queuePosition === 'number' ? data.queuePosition : undefined,
      });
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Processing failed to start.');
    }
  };

  const handleCancelAiProcessing = () => {
    const activeJobId = clientAiProgress.jobId;
    aiAbortControllerRef.current?.abort();
    aiAbortControllerRef.current = null;
    if (activeJobId) {
      fetch(`/api/jobs/${activeJobId}/cancel-ai`, { method: 'POST' }).catch(() => {});
    }
    setClientAiProgress({
      active: false,
      stage: '',
      doneFrames: 0,
      totalFrames: 0,
      percent: 0,
      etaSeconds: null,
      msPerFrame: null,
    });
  };

  const handleContinueWithCpu = () => {
    setUpscaleEngine('cpu');
    setProcessError(null);
    setProcessFallbackAvailable(false);
    void handleStartProcessing('cpu');
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
          if (data.fallbackAvailable) {
            setConnectedComfyUrl('');
            setUpscaleEngine('cpu');
            setAiConnection({
              connected: false,
              checking: false,
              error: 'Colab tunnel disconnected.',
            });
            setProcessFallbackAvailable(true);
          }
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
    handleCancelAiProcessing();
    modelAbortControllerRef.current?.abort();
    modelAbortControllerRef.current = null;
    if (video) {
      fetch(`/api/videos/${video.videoId}`, { method: 'DELETE' }).catch(() => {});
    }
    setVideo(null);
    setRemoveWatermarkEnabled(false);
    setRegions([]);
    setJobId(null);
    setJob(null);
    setProcessError(null);
    setProcessFallbackAvailable(false);
    setUploadError(null);
  };

  const handleHeaderUploadClick = () => {
    const el = document.getElementById('workspace');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
    if (!video && !isUploading) {
      fileInputRef.current?.click();
    }
  };

  const isProcessing =
    clientAiProgress.active || Boolean(job && (job.status === 'processing' || job.status === 'queued'));
  const isCompleted = Boolean(job && job.status === 'completed' && job.outputUrl);

  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <Header onUploadClick={handleHeaderUploadClick} />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6 sm:py-12">
        {/* Hero Header */}
        <section id="workspace" className="scroll-mt-[88px]">
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
                error={uploadError}
                onFileSelected={handleFileSelected}
                onCancelUpload={handleCancelUpload}
                onDismissError={() => setUploadError(null)}
              />
            )}

            {video && !isCompleted && (
              <Suspense
                fallback={
                  <div className="rounded-xl border border-slate-800 bg-[#111A2E] px-6 py-16 text-center text-sm text-slate-300">
                    Loading video workspace...
                  </div>
                }
              >
                <WatermarkEditor
                  video={video}
                  isAdminMode={isAdminMode}
                  removeWatermarkEnabled={removeWatermarkEnabled}
                  regions={regions}
                  mode={mode}
                  upscale={upscale}
                  detailEnhance={detailEnhance}
                  upscaleEngine={upscaleEngine}
                  webGpuSupport={webGpuSupport}
                  aiWebGpuLimits={aiWebGpuLimits}
                  aiModelState={aiModelState}
                  clientAiProgress={clientAiProgress}
                  comfyUrlInput={comfyUrlInput}
                  aiConnection={aiConnection}
                  aiLimits={aiLimits}
                  isProcessing={isProcessing}
                  processStatus={job?.status}
                  queuePosition={job?.queuePosition}
                  processProgress={clientAiProgress.active ? clientAiProgress.percent : (job?.progress ?? 0)}
                  processError={processError}
                  processFallbackAvailable={processFallbackAvailable}
                  onRemoveWatermarkToggle={handleToggleRemoveWatermark}
                  onRegionsChange={(next) => {
                    if (next.length > 0 && !removeWatermarkEnabled) {
                      setRemoveWatermarkEnabled(true);
                    }
                    setRegions(next);
                  }}
                  onModeChange={setMode}
                  onUpscaleChange={(nextUpscale) => {
                    setUpscale(nextUpscale);
                    if (nextUpscale === 'original') {
                      setUpscaleEngine('cpu');
                    }
                  }}
                  onDetailEnhanceChange={setDetailEnhance}
                  onUpscaleEngineChange={(eng) => void handleSelectUpscaleEngine(eng)}
                  onComfyUrlInputChange={setComfyUrlInput}
                  onConnectColab={handleConnectColab}
                  onDisconnectColab={handleDisconnectColab}
                  onStartProcessing={() => handleStartProcessing()}
                  onCancelProcessing={handleCancelAiProcessing}
                  onContinueWithCpu={handleContinueWithCpu}
                  onChangeVideo={handleResetWorkspace}
                />
              </Suspense>
            )}

            {video && isCompleted && job && (
              <Suspense
                fallback={
                  <div className="rounded-xl border border-slate-800 bg-[#111A2E] px-6 py-16 text-center text-sm text-slate-300">
                    Loading comparison view...
                  </div>
                }
              >
                <ComparisonResult
                  video={video}
                  job={job}
                  regionsCount={removeWatermarkEnabled ? regions.length : 0}
                  onEditRegions={() => {
                    setJob(null);
                    setJobId(null);
                    setProcessError(null);
                  }}
                  onReset={handleResetWorkspace}
                />
              </Suspense>
            )}
          </div>
        </section>

        <div className="mt-8 flex justify-center">
          <AdBannerSlot
            adKey="e4c73dde1517c4ed05244df3fca96f66"
            scriptSrc="https://bicea.org/22/e4c73dde1517c4ed05244df3fca96f66"
            width={320}
            height={50}
            className="min-h-[50px] w-[320px]"
          />
        </div>

        <div className="mt-12 grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_160px]">
          <InfoSections />
          <div
            role="complementary"
            aria-label="Sponsored banner"
            className="mx-auto flex justify-center lg:sticky lg:top-6"
          >
            <AdBannerSlot
              adKey="6d47a6b0b83fb4794141a766961e1af2"
              scriptSrc="https://bicea.org/22/6d47a6b0b83fb4794141a766961e1af2"
              width={160}
              height={600}
              className="min-h-[600px] w-[160px]"
            />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
