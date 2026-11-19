import dns from 'node:dns/promises';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import {
  buildComfyUpscaleWorkflow,
  extractGpuStats,
  isPublicIpAddress,
  parseComfyOutputFromHistory,
  validateComfyUrlFormat,
  type ComfyOutputFile,
} from './comfyUrlGuard.ts';

export const AI_MAX_VIDEO_MB = Math.max(5, Number(process.env.AI_MAX_VIDEO_MB) || 50);
export const AI_MAX_VIDEO_BYTES = AI_MAX_VIDEO_MB * 1024 * 1024;
export const AI_MAX_DURATION_SEC = Math.max(5, Number(process.env.AI_MAX_DURATION_SEC) || 60);

export class ComfyFallbackError extends Error {
  readonly fallbackAvailable = true;
  constructor(message: string) {
    super(message);
    this.name = 'ComfyFallbackError';
  }
}

export interface ComfyCheckResult {
  ok: boolean;
  origin?: string;
  gpuName?: string;
  vramGb?: number;
  comfyVersion?: string;
  error?: string;
}

export async function resolveSafeComfyOrigin(rawUrl: string): Promise<{
  ok: boolean;
  origin?: string;
  error?: string;
}> {
  const formatCheck = validateComfyUrlFormat(rawUrl);
  if (!formatCheck.valid || !formatCheck.origin || !formatCheck.hostname) {
    return { ok: false, error: formatCheck.error || 'Invalid ComfyUI tunnel URL.' };
  }

  try {
    const records = await dns.lookup(formatCheck.hostname, { all: true });
    if (!records || records.length === 0) {
      return { ok: false, error: 'Could not resolve tunnel hostname.' };
    }
    for (const rec of records) {
      if (!isPublicIpAddress(rec.address)) {
        return { ok: false, error: 'Tunnel hostname resolves to a restricted non-public IP.' };
      }
    }
    return { ok: true, origin: formatCheck.origin };
  } catch {
    return { ok: false, error: 'Tunnel hostname could not be resolved. Check your Colab URL.' };
  }
}

async function safeComfyFetch(
  origin: string,
  routePath: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(`${origin}${routePath}`, {
      ...rest,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkComfySystemStats(rawUrl: string): Promise<ComfyCheckResult> {
  const resolved = await resolveSafeComfyOrigin(rawUrl);
  if (!resolved.ok || !resolved.origin) {
    return { ok: false, error: resolved.error };
  }

  try {
    const res = await safeComfyFetch(resolved.origin, '/system_stats', {
      method: 'GET',
      timeoutMs: 8_000,
    });

    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 530 || res.status === 502
            ? 'Colab tunnel is offline or expired. Re-run Cell 2 in Colab.'
            : `ComfyUI returned HTTP ${res.status}.`,
      };
    }

    const payload = (await res.json()) as unknown;
    const stats = extractGpuStats(payload);
    if (!stats.hasGpu) {
      return {
        ok: false,
        error: 'ComfyUI responded, but no NVIDIA GPU was detected. Switch Colab Runtime to T4 GPU.',
      };
    }

    return {
      ok: true,
      origin: resolved.origin,
      gpuName: stats.gpuName,
      vramGb: stats.vramGb,
      comfyVersion: stats.comfyVersion,
    };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Timed out reaching Colab tunnel.'
        : 'Could not connect to Colab tunnel. Make sure Cell 2 is running.';
    return { ok: false, error: msg };
  }
}

async function pickUpscaleModelAndVerifyNodes(origin: string): Promise<string> {
  try {
    const vhsRes = await safeComfyFetch(origin, '/object_info/VHS_VideoCombine', {
      method: 'GET',
      timeoutMs: 8_000,
    });
    if (!vhsRes.ok) {
      throw new ComfyFallbackError(
        'ComfyUI-VideoHelperSuite nodes are missing in Colab. Re-run Cell 1 in the notebook.'
      );
    }
    const vhsJson = (await vhsRes.json()) as Record<string, unknown>;
    if (!vhsJson || !vhsJson.VHS_VideoCombine) {
      throw new ComfyFallbackError(
        'ComfyUI-VideoHelperSuite nodes are missing in Colab. Re-run Cell 1 in the notebook.'
      );
    }
  } catch (err) {
    if (err instanceof ComfyFallbackError) throw err;
    throw new ComfyFallbackError('Lost connection to Colab GPU while checking video nodes.');
  }

  try {
    const modelRes = await safeComfyFetch(origin, '/object_info/UpscaleModelLoader', {
      method: 'GET',
      timeoutMs: 8_000,
    });
    if (!modelRes.ok) return 'RealESRGAN_x2plus.pth';
    const data = (await modelRes.json()) as {
      UpscaleModelLoader?: { input?: { required?: { model_name?: unknown[] } } };
    };
    const choices = data?.UpscaleModelLoader?.input?.required?.model_name?.[0];
    if (Array.isArray(choices) && choices.length > 0) {
      const models = choices.filter((m): m is string => typeof m === 'string');
      const exact = models.find((m) => m === 'RealESRGAN_x2plus.pth');
      if (exact) return exact;
      const esrgan = models.find((m) => /esrgan|x2|x4|ultrasharp|remacri/i.test(m));
      if (esrgan) return esrgan;
      if (models[0]) return models[0];
    }
  } catch {
    // Fallback to default model name
  }

  return 'RealESRGAN_x2plus.pth';
}

export interface RunComfyUpscaleParams {
  comfyUrl: string;
  inputVideoPath: string;
  outputVideoPath: string;
  targetWidth: number;
  targetHeight: number;
  frameRate: number;
  durationSec: number;
  onProgress: (pct: number) => void;
}

export async function runComfyUpscaleJob(params: RunComfyUpscaleParams): Promise<void> {
  // Mandatory /system_stats + GPU re-check right before starting job
  const statsCheck = await checkComfySystemStats(params.comfyUrl);
  if (!statsCheck.ok || !statsCheck.origin) {
    throw new ComfyFallbackError(
      statsCheck.error || 'Colab GPU tunnel is offline. You can continue with the CPU upscaler.'
    );
  }
  const origin = statsCheck.origin;

  params.onProgress(14);
  const modelName = await pickUpscaleModelAndVerifyNodes(origin);

  // Upload silent, rotation-normalized video into ComfyUI input directory
  const remoteFilename = `clearframe_${crypto.randomUUID().slice(0, 10)}.mp4`;
  let uploadedName = remoteFilename;

  try {
    const fileBlob = await fs.openAsBlob(params.inputVideoPath, { type: 'video/mp4' });
    const form = new FormData();
    form.append('image', fileBlob, remoteFilename);
    form.append('overwrite', 'true');
    form.append('type', 'input');

    const uploadRes = await safeComfyFetch(origin, '/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: 120_000,
    });
    if (!uploadRes.ok) {
      throw new ComfyFallbackError(
        uploadRes.status === 413
          ? 'Video exceeded free tunnel upload limit. Try a shorter clip or use the CPU upscaler.'
          : 'Colab tunnel upload failed. You can continue with the CPU upscaler.'
      );
    }
    const uploadJson = (await uploadRes.json()) as { name?: string };
    if (uploadJson?.name && typeof uploadJson.name === 'string') {
      uploadedName = uploadJson.name;
    }
  } catch (err) {
    if (err instanceof ComfyFallbackError) throw err;
    throw new ComfyFallbackError(
      'Colab tunnel disconnected during upload. Continue with the CPU upscaler instead.'
    );
  }

  params.onProgress(22);

  const clientId = crypto.randomUUID();
  const filenamePrefix = `cf_out_${crypto.randomUUID().slice(0, 8)}`;
  const framesPerBatch = 16;
  const estTotalFrames = Math.max(1, Math.round(params.durationSec * params.frameRate));
  const estTotalBatches = Math.max(1, Math.ceil(estTotalFrames / framesPerBatch));

  const workflow = buildComfyUpscaleWorkflow({
    inputFilename: uploadedName,
    modelName,
    targetWidth: params.targetWidth,
    targetHeight: params.targetHeight,
    frameRate: params.frameRate,
    filenamePrefix,
    framesPerBatch,
  });

  // Open WebSocket listener before submitting prompt to receive live frame progress
  const wsUrl = `${origin.replace(/^https:/, 'wss:')}/ws?clientId=${encodeURIComponent(clientId)}`;
  let completedBatches = 0;
  let lastBatchValue = 0;
  let wsClosedUnexpectedly = false;
  let executionErrorMsg: string | null = null;
  let detectedOutput: ComfyOutputFile | null = null;
  const activePromptIds = new Set<string>();

  const ws = new WebSocket(wsUrl);
  const wsReadyPromise = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3500);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });

  ws.addEventListener('message', (event) => {
    try {
      if (typeof event.data !== 'string') return;
      const msg = JSON.parse(event.data) as {
        type?: string;
        data?: {
          prompt_id?: string;
          node?: string | null;
          value?: number;
          max?: number;
          output?: Record<string, unknown>;
          exception_message?: string;
        };
      };

      const promptId = msg.data?.prompt_id;
      if (msg.type === 'executing') {
        if (promptId) activePromptIds.add(promptId);
        if (msg.data?.node === null && promptId && activePromptIds.has(promptId)) {
          if (lastBatchValue > 0) {
            completedBatches += 1;
            lastBatchValue = 0;
          }
        }
      } else if (msg.type === 'progress') {
        const val = Number(msg.data?.value ?? 0);
        const max = Math.max(1, Number(msg.data?.max ?? framesPerBatch));
        lastBatchValue = val;
        const batchFraction = Math.min(1, (completedBatches + val / max) / estTotalBatches);
        const pct = Math.min(89, Math.max(24, Math.round(24 + batchFraction * 65)));
        params.onProgress(pct);
      } else if (msg.type === 'executed' && msg.data?.output) {
        const fakeEntry = { outputs: { [msg.data.node || '6']: msg.data.output } };
        const found = parseComfyOutputFromHistory(fakeEntry, filenamePrefix);
        if (found) {
          detectedOutput = found;
        }
      } else if (msg.type === 'execution_error') {
        executionErrorMsg =
          typeof msg.data?.exception_message === 'string' && msg.data.exception_message.trim()
            ? msg.data.exception_message.trim().slice(0, 140)
            : 'ComfyUI execution failed on Colab GPU.';
      }
    } catch {
      // Ignore malformed WS status frames
    }
  });

  ws.addEventListener('close', () => {
    wsClosedUnexpectedly = true;
  });
  ws.addEventListener('error', () => {
    wsClosedUnexpectedly = true;
  });

  try {
    await wsReadyPromise;

    let initialPromptId: string;
    try {
      const promptRes = await safeComfyFetch(origin, '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        timeoutMs: 15_000,
      });
      if (!promptRes.ok) {
        const errBody = await promptRes.text().catch(() => '');
        throw new ComfyFallbackError(
          `Colab rejected the GPU workflow (${promptRes.status}). ${errBody.slice(0, 80)}`.trim()
        );
      }
      const promptJson = (await promptRes.json()) as { prompt_id?: string; node_errors?: unknown };
      if (!promptJson.prompt_id) {
        throw new ComfyFallbackError('Colab did not return a prompt ID. Continue with CPU upscaler.');
      }
      initialPromptId = promptJson.prompt_id;
      activePromptIds.add(initialPromptId);
    } catch (err) {
      if (err instanceof ComfyFallbackError) throw err;
      throw new ComfyFallbackError(
        'Colab GPU tunnel dropped before processing started. Continue with CPU upscaler.'
      );
    }

    // Resilient history/queue polling handles requeued VHS batches & any brief WS drops
    const maxWaitMs = Math.max(180_000, Math.round(params.durationSec * 15_000));
    const deadline = Date.now() + maxWaitMs;
    let consecutiveNetFailures = 0;

    while (!detectedOutput && !executionErrorMsg) {
      if (Date.now() > deadline) {
        throw new ComfyFallbackError(
          'Colab GPU job timed out. Continue with the CPU upscaler instead.'
        );
      }

      await new Promise((r) => setTimeout(r, 2200));
      if (detectedOutput || executionErrorMsg) break;

      try {
        const histRes = await safeComfyFetch(origin, '/history?max_items=15', {
          method: 'GET',
          timeoutMs: 8_000,
        });

        if (!histRes.ok) {
          consecutiveNetFailures += 1;
          if (histRes.status === 530 || histRes.status === 502 || consecutiveNetFailures >= 3) {
            throw new ComfyFallbackError(
              'Colab GPU tunnel disconnected mid-job. Continue with the CPU upscaler.'
            );
          }
          continue;
        }

        consecutiveNetFailures = 0;
        const historyMap = (await histRes.json()) as Record<string, unknown>;
        for (const [pid, entry] of Object.entries(historyMap)) {
          const found = parseComfyOutputFromHistory(entry, filenamePrefix);
          if (found) {
            detectedOutput = found;
            break;
          }
          if (activePromptIds.has(pid) && entry && typeof entry === 'object') {
            const statusObj = (entry as { status?: { status_str?: string } }).status;
            if (statusObj?.status_str === 'error') {
              executionErrorMsg = 'ComfyUI reported an error on Colab GPU.';
              break;
            }
          }
        }
      } catch (err) {
        if (err instanceof ComfyFallbackError) throw err;
        consecutiveNetFailures += 1;
        if (consecutiveNetFailures >= 3 || (wsClosedUnexpectedly && consecutiveNetFailures >= 2)) {
          throw new ComfyFallbackError(
            'Colab GPU tunnel expired or disconnected mid-job. Continue with the CPU upscaler.'
          );
        }
      }
    }

    if (executionErrorMsg) {
      throw new ComfyFallbackError(`${executionErrorMsg} You can continue with the CPU upscaler.`);
    }

    if (!detectedOutput) {
      throw new ComfyFallbackError(
        'Colab GPU finished without returning a video file. Continue with the CPU upscaler.'
      );
    }

    params.onProgress(91);

    // Download resulting upscaled video from ComfyUI /view
    const viewParams = new URLSearchParams({
      filename: detectedOutput.filename,
      subfolder: detectedOutput.subfolder,
      type: detectedOutput.type,
    });
    const viewRes = await safeComfyFetch(origin, `/view?${viewParams.toString()}`, {
      method: 'GET',
      timeoutMs: 120_000,
    });
    if (!viewRes.ok || !viewRes.body) {
      throw new ComfyFallbackError(
        'Could not download upscaled video from Colab tunnel. Continue with the CPU upscaler.'
      );
    }

    const outStream = fs.createWriteStream(params.outputVideoPath);
    await pipeline(Readable.fromWeb(viewRes.body as unknown as import('stream/web').ReadableStream), outStream);

    if (!fs.existsSync(params.outputVideoPath) || fs.statSync(params.outputVideoPath).size === 0) {
      throw new ComfyFallbackError('Downloaded GPU output was empty. Continue with CPU upscaler.');
    }
  } finally {
    try {
      ws.close();
    } catch {
      // Ignore WebSocket close errors
    }
  }
}
