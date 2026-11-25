import express from 'express';
import compression from 'compression';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_MB,
  SUPPORTED_VIDEO_EXTENSIONS,
  buildAiPreprocessFilterGraph,
  buildFfmpegFilterGraph,
  clampRegion,
  getFileExtension,
  resolveDisplayDimensions,
  type RemovalMode,
  type UpscaleEngine,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from './src/utils/watermark.ts';
import {
  BoundedJobQueue,
  SlidingWindowRateLimiter,
  selectEvictionsForBudget,
  type StorageArtifact,
} from './src/utils/serverGuard.ts';
import {
  AI_MAX_DURATION_SEC,
  AI_MAX_VIDEO_BYTES,
  AI_MAX_VIDEO_MB,
  ComfyFallbackError,
  checkComfySystemStats,
  runComfyUpscaleJob,
} from './src/utils/comfyServer.ts';
import { checkAiVideoLimits, type AiClientLimits } from './src/utils/webgpuUpscaler.ts';
import {
  LAST_MODIFIED,
  buildRobotsTxt,
  buildSitemapXml,
  getLandingPageByPath,
  injectLandingPageSeo,
} from './src/seo/landingPages.ts';

const SITE_URL = 'https://clearframe.ai.studio';
const PORT = Number(process.env.PORT || 3000);
const CPU_COUNT = Math.max(1, os.cpus().length);
const TOTAL_MEM_MB = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
const LOW_MEM_HOST = TOTAL_MEM_MB < 1800;
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_JOBS) ||
    (TOTAL_MEM_MB <= 4096 ? 1 : Math.min(2, Math.max(1, Math.floor(CPU_COUNT / 2))))
);
const MAX_QUEUED_JOBS = Math.max(2, Number(process.env.MAX_QUEUED_JOBS) || 25);
const AI_WEBGPU_LIMITS: AiClientLimits = {
  maxDurationSec: Math.max(5, Number(process.env.AI_WEBGPU_MAX_DURATION_SEC) || 30),
  maxHeight: Math.max(360, Number(process.env.AI_WEBGPU_MAX_HEIGHT) || 720),
  maxSizeMb: Math.max(10, Number(process.env.AI_WEBGPU_MAX_SIZE_MB) || 100),
};
const DEFAULT_STORAGE_MB = Math.min(3584, Math.max(512, Math.floor(TOTAL_MEM_MB * 0.4)));
const MAX_WORK_DIR_BYTES =
  Math.max(512, Number(process.env.MAX_STORAGE_MB) || DEFAULT_STORAGE_MB) * 1024 * 1024;
const EXPIRY_TTL_MS = 15 * 60 * 1000;
const MAX_JOB_RUNTIME_MS = 15 * 60 * 1000;
const WORK_DIR = '/tmp/clearframe-studio';
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const OUTPUT_DIR = path.join(WORK_DIR, 'outputs');
const NNEDI_WEIGHTS_PATH = path.resolve(process.cwd(), 'models', 'nnedi3_weights.bin');

const require = createRequire(import.meta.url);

function resolveExecutable(envOverride: string | undefined, bundledPath: string | null | undefined, fallbackName: string): string {
  const candidates = [envOverride, bundledPath].filter((v): v is string => Boolean(v && v.trim()));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(candidate, 0o755);
        } catch {
          // Ignore chmod failures on read-only filesystems
        }
      }
      return candidate;
    }
  }
  return fallbackName;
}

const FFMPEG_STATIC_PATH = (() => {
  try {
    return require('ffmpeg-static') as string | null;
  } catch {
    return null;
  }
})();

const FFMPEG_BIN = resolveExecutable(process.env.FFMPEG_PATH, FFMPEG_STATIC_PATH, 'ffmpeg');
const FFPROBE_BIN = resolveExecutable(process.env.FFPROBE_PATH, null, 'ffprobe');

for (const dir of [WORK_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

interface StoredVideo {
  videoId: string;
  originalName: string;
  filePath: string;
  size: number;
  width: number;
  height: number;
  needsSarNormalize: boolean;
  rotation: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
  createdAt: number;
}

interface JobRecord {
  jobId: string;
  videoId: string;
  originalName: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  error?: string;
  outputPath?: string;
  outputSize?: number;
  outputWidth?: number;
  outputHeight?: number;
  upscale: UpscalePreset;
  upscaleEngine: UpscaleEngine;
  fallbackAvailable?: boolean;
  regionsCount: number;
  startedAt: number;
  finishedAt?: number;
}

interface ChunkUploadSession {
  uploadId: string;
  originalName: string;
  filePath: string;
  expectedSize: number;
  receivedBytes: number;
  createdAt: number;
}

const videos = new Map<string, StoredVideo>();
const jobs = new Map<string, JobRecord>();
const uploadSessions = new Map<string, ChunkUploadSession>();
const activeAiJobsByIp = new Map<string, string>();
const aiTempSourcePaths = new Map<string, string>();
const activeChildren = new Set<ChildProcess>();

function releaseAiIpLock(jobId: string): void {
  for (const [ip, activeJobId] of activeAiJobsByIp.entries()) {
    if (activeJobId === jobId) {
      activeAiJobsByIp.delete(ip);
    }
  }
}

const jobQueue = new BoundedJobQueue({
  maxConcurrent: MAX_CONCURRENT_JOBS,
  maxQueued: MAX_QUEUED_JOBS,
  maxQueuedPerOwner: 3,
});

const uploadInitLimiter = new SlidingWindowRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_UPLOADS) || 20,
});
const uploadChunkLimiter = new SlidingWindowRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_CHUNKS) || 250,
});
const jobSubmitLimiter = new SlidingWindowRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_JOBS) || 15,
});
const aiCheckLimiter = new SlidingWindowRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_AI_CHECK) || 30,
});

function getClientIp(req: express.Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(
  limiter: SlidingWindowRateLimiter,
  req: express.Request,
  res: express.Response,
  message: string
): boolean {
  const decision = limiter.check(getClientIp(req));
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSec));
    res.status(429).json({
      error: `${message} Please try again in ${decision.retryAfterSec}s.`,
    });
    return false;
  }
  return true;
}

function cleanOrphanedWorkFiles(): void {
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        fs.unlink(path.join(dir, entry), () => {});
      }
    } catch {
      // Ignore cleanup errors on startup
    }
  }
}

function isVideoProtected(videoId: string): boolean {
  for (const job of jobs.values()) {
    if (job.videoId === videoId && (job.status === 'queued' || job.status === 'processing')) {
      return true;
    }
  }
  return false;
}

function evictArtifactById(artifactId: string): void {
  if (artifactId.startsWith('vid:')) {
    const id = artifactId.slice(4);
    const video = videos.get(id);
    if (video) {
      if (fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(id);
    }
    return;
  }
  if (artifactId.startsWith('job:')) {
    const id = artifactId.slice(4);
    const job = jobs.get(id);
    if (job) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
      const aiSrc = aiTempSourcePaths.get(id);
      if (aiSrc && fs.existsSync(aiSrc)) {
        fs.unlink(aiSrc, () => {});
      }
      aiTempSourcePaths.delete(id);
      releaseAiIpLock(id);
      jobs.delete(id);
    }
    return;
  }
  if (artifactId.startsWith('up:')) {
    const id = artifactId.slice(3);
    const session = uploadSessions.get(id);
    if (session) {
      if (fs.existsSync(session.filePath)) {
        fs.unlink(session.filePath, () => {});
      }
      uploadSessions.delete(id);
    }
  }
}

function ensureStorageBudget(incomingBytes: number): boolean {
  const artifacts: StorageArtifact[] = [];

  for (const [id, video] of videos.entries()) {
    artifacts.push({
      id: `vid:${id}`,
      sizeBytes: video.size,
      createdAt: video.createdAt,
      protected: isVideoProtected(id),
    });
  }

  for (const [jobId, job] of jobs.entries()) {
    const isActive = job.status === 'queued' || job.status === 'processing';
    const estimatedOut = job.outputSize ?? 0;
    if (estimatedOut > 0 || !isActive) {
      artifacts.push({
        id: `job:${jobId}`,
        sizeBytes: estimatedOut,
        createdAt: job.finishedAt ?? job.startedAt,
        protected: isActive,
      });
    }
  }

  for (const [uploadId, session] of uploadSessions.entries()) {
    const isFresh = Date.now() - session.createdAt < 5 * 60 * 1000;
    artifacts.push({
      id: `up:${uploadId}`,
      sizeBytes: Math.max(session.receivedBytes, session.expectedSize),
      createdAt: session.createdAt,
      protected: isFresh,
    });
  }

  const plan = selectEvictionsForBudget(artifacts, incomingBytes, MAX_WORK_DIR_BYTES);
  for (const id of plan.evictIds) {
    evictArtifactById(id);
  }
  return plan.allowed;
}

function runProcess(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(-400)}`));
      }
    });
  });
}

async function runFfmpegProbeStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', () => resolve(stderr));
  });
}

async function probeVideoWithFfmpegFallback(filePath: string): Promise<{
  width: number;
  height: number;
  needsSarNormalize: boolean;
  rotation: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
}> {
  const stderr = await runFfmpegProbeStderr(['-hide_banner', '-i', filePath]);

  const videoLineMatch = stderr.match(/Stream #0:\d+[^\n]*Video:\s*([^\n]+)/i);
  if (!videoLineMatch) {
    throw new Error('No readable video stream found in the uploaded file.');
  }
  const videoLine = videoLineMatch[1];
  const dimMatch = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b(?:\s*\[SAR\s+(\d+:\d+))?/i);
  if (!dimMatch) {
    throw new Error('Could not read video dimensions from uploaded file.');
  }

  const rawW = Number(dimMatch[1]);
  const rawH = Number(dimMatch[2]);
  const sar = dimMatch[3];

  let rawRotation = 0;
  const dmRotMatch = stderr.match(/displaymatrix:\s*rotation of\s*([-+]?\d+(?:\.\d+)?)\s*degrees/i);
  const tagRotMatch = stderr.match(/rotate\s*:\s*([-+]?\d+)/i);
  if (dmRotMatch) rawRotation = Number(dmRotMatch[1]);
  else if (tagRotMatch) rawRotation = Number(tagRotMatch[1]);

  const display = resolveDisplayDimensions(rawW, rawH, sar, rawRotation);

  let duration = 5;
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (durMatch) {
    const parsedDur =
      Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
    if (Number.isFinite(parsedDur) && parsedDur > 0) duration = parsedDur;
  }

  let fps = 30;
  const fpsMatch = videoLine.match(/\b(\d+(?:\.\d+)?)\s*(?:fps|tbr)\b/i);
  if (fpsMatch) {
    const parsedFps = Number(fpsMatch[1]);
    if (Number.isFinite(parsedFps) && parsedFps > 0.5) {
      fps = Math.round(parsedFps * 100) / 100;
    }
  }

  const audioMatch = stderr.match(/Stream #0:\d+[^\n]*Audio:\s*([a-z0-9_]+)/i);
  return {
    width: display.width,
    height: display.height,
    needsSarNormalize: display.needsSarNormalize,
    rotation: display.rotation,
    duration,
    fps,
    hasAudio: Boolean(audioMatch),
    audioCodec: audioMatch?.[1]?.toLowerCase(),
  };
}

async function probeVideo(filePath: string): Promise<{
  width: number;
  height: number;
  needsSarNormalize: boolean;
  rotation: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
}> {
  let stdout: string;
  try {
    const res = await runProcess(FFPROBE_BIN, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    stdout = res.stdout;
  } catch {
    return probeVideoWithFfmpegFallback(filePath);
  }

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      sample_aspect_ratio?: string;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: Array<{ rotation?: number }>;
    }>;
    format?: { duration?: string };
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('No readable video stream found in the uploaded file.');
  }

  const sideDataRot = videoStream.side_data_list?.find(
    (sd) => typeof sd.rotation === 'number' && Number.isFinite(sd.rotation)
  )?.rotation;
  const rawRotation = sideDataRot ?? videoStream.tags?.rotate ?? 0;
  const display = resolveDisplayDimensions(
    videoStream.width,
    videoStream.height,
    videoStream.sample_aspect_ratio,
    rawRotation
  );

  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const rawDuration = Number(parsed.format?.duration ?? videoStream.duration ?? 0);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 5;

  let fps = 30;
  const fpsRate =
    videoStream.avg_frame_rate && videoStream.avg_frame_rate !== '0/0'
      ? videoStream.avg_frame_rate
      : videoStream.r_frame_rate;
  if (fpsRate && fpsRate.includes('/')) {
    const [num, den] = fpsRate.split('/').map(Number);
    if (den > 0 && num > 0) {
      fps = Math.round((num / den) * 100) / 100;
    }
  }

  return {
    width: display.width,
    height: display.height,
    needsSarNormalize: display.needsSarNormalize,
    rotation: display.rotation,
    duration,
    fps,
    hasAudio: Boolean(audioStream),
    audioCodec: audioStream?.codec_name?.toLowerCase(),
  };
}

async function probeVideoFrameTimestamps(filePath: string): Promise<number[] | undefined> {
  try {
    const { stdout } = await runProcess(FFPROBE_BIN, [
      '-v',
      'quiet',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      filePath,
    ]);
    const raw = stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((val) => Number.isFinite(val) && val >= 0)
      .sort((a, b) => a - b);
    if (raw.length >= 2) return raw.slice(0, 4000);
  } catch {
    // Fallback to ffmpeg showinfo timestamp probe when ffprobe is unavailable
  }

  try {
    const stderr = await runFfmpegProbeStderr([
      '-hide_banner',
      '-v',
      'info',
      '-i',
      filePath,
      '-map',
      '0:v:0',
      '-vf',
      'showinfo',
      '-f',
      'null',
      '-',
    ]);
    const matches = Array.from(stderr.matchAll(/\bpts_time:\s*([\d.]+)/g));
    const raw = matches
      .map((m) => Number(m[1]))
      .filter((val) => Number.isFinite(val) && val >= 0)
      .sort((a, b) => a - b);
    if (raw.length >= 2) return raw.slice(0, 4000);
  } catch {
    // Ignore fallback probe failure
  }
  return undefined;
}

function streamVideoFile(req: express.Request, res: express.Response, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Video file not found.' });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.webm'
      ? 'video/webm'
      : ext === '.mov'
        ? 'video/quicktime'
        : ext === '.mkv'
          ? 'video/x-matroska'
          : 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

function cleanupExpiredFiles(): void {
  const cutoff = Date.now() - EXPIRY_TTL_MS;
  for (const [id, video] of videos.entries()) {
    if (video.createdAt < cutoff && !isVideoProtected(id)) {
      if (fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(id);
    }
  }
  for (const [jobId, job] of jobs.entries()) {
    const isActive = job.status === 'queued' || job.status === 'processing';
    const isStaleAi = job.upscaleEngine === 'ai' && isActive && job.startedAt < cutoff;
    if ((!isActive || isStaleAi) && (job.finishedAt ?? job.startedAt) < cutoff) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
      const aiSrc = aiTempSourcePaths.get(jobId);
      if (aiSrc && fs.existsSync(aiSrc)) {
        fs.unlink(aiSrc, () => {});
      }
      aiTempSourcePaths.delete(jobId);
      releaseAiIpLock(jobId);
      jobs.delete(jobId);
    }
  }
  for (const [uploadId, session] of uploadSessions.entries()) {
    if (session.createdAt < cutoff) {
      if (fs.existsSync(session.filePath)) {
        fs.unlink(session.filePath, () => {});
      }
      uploadSessions.delete(uploadId);
    }
  }
  const now = Date.now();
  uploadInitLimiter.prune(now);
  uploadChunkLimiter.prune(now);
  jobSubmitLimiter.prune(now);
  aiCheckLimiter.prune(now);
}

cleanOrphanedWorkFiles();
setInterval(cleanupExpiredFiles, 2 * 60 * 1000).unref();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname) || '.mp4';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_VIDEO_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    const extOk = (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
    const mimeOk = Boolean(file.mimetype && file.mimetype.startsWith('video/'));
    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported video format. Please upload MP4, MOV, WebM, MKV, AVI, or M4V.'));
    }
  },
});

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    compression({
      filter: (req, res) => {
        if (req.path.endsWith('/stream') || req.path.endsWith('/download')) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      maxUploadMb: MAX_VIDEO_SIZE_MB,
      aiLimits: {
        maxSizeMb: AI_MAX_VIDEO_MB,
        maxDurationSec: AI_MAX_DURATION_SEC,
      },
      aiWebGpuLimits: AI_WEBGPU_LIMITS,
      queue: jobQueue.getStats(),
    });
  });

  app.post('/api/ai/check', async (req, res) => {
    if (!enforceRateLimit(aiCheckLimiter, req, res, 'Too many Colab GPU connection checks.')) {
      return;
    }
    const comfyUrl = (req.body as { comfyUrl?: unknown } | undefined)?.comfyUrl;
    if (typeof comfyUrl !== 'string') {
      res.status(400).json({ ok: false, error: 'Paste your Colab HTTPS tunnel URL first.' });
      return;
    }
    const result = await checkComfySystemStats(comfyUrl);
    if (!result.ok) {
      res.status(400).json({
        ok: false,
        error: result.error || 'Could not reach ComfyUI GPU server.',
        limits: {
          maxSizeMb: AI_MAX_VIDEO_MB,
          maxDurationSec: AI_MAX_DURATION_SEC,
        },
      });
      return;
    }
    res.json({
      ok: true,
      gpuName: result.gpuName,
      vramGb: result.vramGb,
      comfyVersion: result.comfyVersion,
      limits: {
        maxSizeMb: AI_MAX_VIDEO_MB,
        maxDurationSec: AI_MAX_DURATION_SEC,
      },
    });
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(buildRobotsTxt(SITE_URL));
  });

  app.get('/sitemap.xml', (_req, res) => {
    res.type('application/xml').send(buildSitemapXml(SITE_URL, LAST_MODIFIED));
  });

  app.get('/llms.txt', (_req, res) => {
    const baseUrl = SITE_URL;
    res.type('text/markdown; charset=utf-8').send(
      [
        '# ClearFrame — Free Video Watermark Remover & 4K Upscaler',
        '',
        '> ClearFrame is a free, zero-signup web video studio for removing watermarks and upscaling videos up to 4K UHD without external paid APIs or export watermarks.',
        '',
        '## Core Capabilities',
        '- Maximum File Size: Up to 300 MB per video upload (100% free, no account or credits)',
        '- Supported Input Formats: MP4, MOV, WebM, MKV, AVI, M4V',
        '- Watermark Removal Engines: Smart Inpaint (delogo), Soft Blur (boxblur), Mosaic Mask',
        '- Multi-Region Selection: Up to 8 independent boxes with optional Start and End timestamps in seconds',
        '- Video Upscaling: Original, 1080p Full HD, 2K QHD, and 4K UHD via NNEDI3 neural edge-directed reconstruction, Lanczos resampling, and Adaptive Sharpening, preserving orientation and never downscaling higher-res footage',
        '- Output & Audio: Visually lossless H.264 MP4 (CRF 16–18) with original audio track preserved and Before/After split slider comparison',
        '- Privacy: Temporary uploads and exports are automatically deleted after 15 minutes or immediately on video reset',
        '',
        '## Direct Answers (AEO)',
        '- **Is ClearFrame completely free up to 300 MB?** Yes, 100% free with no account, credits, or export watermark.',
        '- **Does 4K upscaling reduce original quality?** No, it uses NNEDI3 neural reconstruction, deblocking, Lanczos resampling, and balanced Adaptive Sharpening with H.264 encoding (CRF 16–18).',
        '- **Which watermark removal engine should I use?** Smart Inpaint for corner logos and static text; Soft Blur or Mosaic for moving or complex textured backgrounds.',
        '',
        '## Pages & Discovery',
        `- [ClearFrame Workspace](${baseUrl}/#workspace): Upload videos up to 300 MB, mark watermark regions, and export clean MP4.`,
        `- [How It Works](${baseUrl}/#how-it-works): 3-step guide to watermark removal and 4K upscaling.`,
        `- [Supported Formats & Specs](${baseUrl}/#specs): Input limits, removal engines, and upscale targets.`,
        `- [Frequently Asked Questions](${baseUrl}/#faq): Answers on free 300 MB limits, 4K quality, and privacy.`,
        `- [XML Sitemap](${baseUrl}/sitemap.xml): Search engine sitemap for ClearFrame.`,
        `- [Agentic Resource Discovery](${baseUrl}/.well-known/ard.json): ARD manifest for AI agents.`,
      ].join('\n') + '\n'
    );
  });

  const handleArdManifest = (_req: express.Request, res: express.Response) => {
    const baseUrl = SITE_URL;
    const publisherHost = 'clearframe.ai.studio';
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      specVersion: '0.91',
      entries: [
        {
          identifier: `urn:air:${publisherHost}:tool:clearframe-video-studio`,
          displayName: 'ClearFrame Video Watermark Remover & 4K Upscaler',
          type: 'text/markdown',
          url: `${baseUrl}/llms.txt`,
          representativeQueries: [
            'remove watermark from video free up to 300mb',
            'upscale video to 4k without losing quality',
            'erase logo or text overlay from mp4 video',
          ],
        },
      ],
    });
  };

  app.get('/.well-known/ard.json', handleArdManifest);
  app.get('/.well-known/ai-catalog.json', handleArdManifest);

  async function finalizeUploadedVideo(
    filePath: string,
    originalName: string,
    size: number
  ): Promise<VideoMetadata> {
    const info = await probeVideo(filePath);
    const videoId = crypto.randomUUID();
    const stored: StoredVideo = {
      videoId,
      originalName,
      filePath,
      size,
      width: info.width,
      height: info.height,
      needsSarNormalize: info.needsSarNormalize,
      rotation: info.rotation,
      duration: info.duration,
      fps: info.fps,
      hasAudio: info.hasAudio,
      audioCodec: info.audioCodec,
      createdAt: Date.now(),
    };
    videos.set(videoId, stored);

    return {
      videoId,
      originalName: stored.originalName,
      size: stored.size,
      width: stored.width,
      height: stored.height,
      duration: stored.duration,
      fps: stored.fps,
      hasAudio: stored.hasAudio,
      previewUrl: `/api/videos/${videoId}/stream`,
    };
  }

  app.post('/api/upload/init', (req, res) => {
    if (!enforceRateLimit(uploadInitLimiter, req, res, 'Too many uploads from this IP.')) {
      return;
    }

    const { filename, size, type } = (req.body ?? {}) as {
      filename?: string;
      size?: number;
      type?: string;
    };

    if (!filename || typeof filename !== 'string') {
      res.status(400).json({ error: 'Missing file name.' });
      return;
    }

    const totalSize = Number(size);
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      res.status(400).json({ error: 'Invalid video file size.' });
      return;
    }

    if (totalSize > MAX_VIDEO_SIZE_BYTES) {
      res.status(413).json({
        error: `File exceeds the ${MAX_VIDEO_SIZE_MB} MB maximum size limit.`,
      });
      return;
    }

    const ext = getFileExtension(filename);
    const extOk = (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
    const mimeOk = Boolean(type && type.startsWith('video/'));
    if (!extOk && !mimeOk) {
      res.status(400).json({
        error: 'Unsupported video format. Please upload MP4, MOV, WebM, MKV, AVI, or M4V.',
      });
      return;
    }

    if (!ensureStorageBudget(totalSize)) {
      res.setHeader('Retry-After', '30');
      res.status(503).json({
        error: 'Server storage is temporarily busy with active uploads. Please retry in a moment.',
      });
      return;
    }

    const uploadId = crypto.randomUUID();
    const safeExt = ext || '.mp4';
    const filePath = path.join(UPLOAD_DIR, `${uploadId}${safeExt}`);
    fs.writeFileSync(filePath, Buffer.alloc(0));

    uploadSessions.set(uploadId, {
      uploadId,
      originalName: filename,
      filePath,
      expectedSize: totalSize,
      receivedBytes: 0,
      createdAt: Date.now(),
    });

    res.json({
      uploadId,
      chunkSize: 8 * 1024 * 1024,
    });
  });

  app.post(
    '/api/upload/chunk',
    express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    async (req, res) => {
      if (!enforceRateLimit(uploadChunkLimiter, req, res, 'Too many upload chunks from this IP.')) {
        return;
      }
      const uploadId = String(req.query.uploadId ?? '');
      const session = uploadSessions.get(uploadId);
      if (!session) {
        res.status(404).json({ error: 'Upload session not found or expired.' });
        return;
      }

      const chunk = req.body;
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
        res.status(400).json({ error: 'Empty video chunk received.' });
        return;
      }

      if (session.receivedBytes + chunk.length > MAX_VIDEO_SIZE_BYTES) {
        uploadSessions.delete(uploadId);
        fs.unlink(session.filePath, () => {});
        res.status(413).json({
          error: `File exceeds the ${MAX_VIDEO_SIZE_MB} MB maximum size limit.`,
        });
        return;
      }

      try {
        await fs.promises.appendFile(session.filePath, chunk);
        session.receivedBytes += chunk.length;
        res.json({ ok: true, receivedBytes: session.receivedBytes });
      } catch (err) {
        uploadSessions.delete(uploadId);
        fs.unlink(session.filePath, () => {});
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to write video chunk.',
        });
      }
    }
  );

  app.post('/api/upload/complete', async (req, res) => {
    const uploadId = String((req.body as { uploadId?: string } | undefined)?.uploadId ?? '');
    const session = uploadSessions.get(uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired.' });
      return;
    }

    uploadSessions.delete(uploadId);
    try {
      const stat = fs.statSync(session.filePath);
      if (stat.size <= 0) {
        throw new Error('Uploaded file is empty.');
      }
      const payload = await finalizeUploadedVideo(session.filePath, session.originalName, stat.size);
      res.json(payload);
    } catch (probeErr) {
      fs.unlink(session.filePath, () => {});
      res.status(400).json({
        error:
          probeErr instanceof Error
            ? probeErr.message
            : 'Could not read video metadata. Please try another file.',
      });
    }
  });

  app.delete('/api/upload/:uploadId', (req, res) => {
    const session = uploadSessions.get(req.params.uploadId);
    if (session) {
      uploadSessions.delete(req.params.uploadId);
      if (fs.existsSync(session.filePath)) {
        fs.unlink(session.filePath, () => {});
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/upload', (req, res) => {
    if (!enforceRateLimit(uploadInitLimiter, req, res, 'Too many uploads from this IP.')) {
      return;
    }

    const contentLength = Number(req.get('content-length') || 0);
    if (!ensureStorageBudget(Number.isFinite(contentLength) ? contentLength : 8 * 1024 * 1024)) {
      res.setHeader('Retry-After', '30');
      res.status(503).json({
        error: 'Server storage is temporarily busy with active uploads. Please retry in a moment.',
      });
      return;
    }

    upload.single('video')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `File exceeds the ${MAX_VIDEO_SIZE_MB} MB maximum size limit.`,
          });
          return;
        }
        res.status(400).json({ error: err.message || 'Upload failed.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No video file provided.' });
        return;
      }

      try {
        const payload = await finalizeUploadedVideo(
          req.file.path,
          req.file.originalname,
          req.file.size
        );
        res.json(payload);
      } catch (probeErr) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({
          error:
            probeErr instanceof Error
              ? probeErr.message
              : 'Could not read video metadata. Please try another file.',
        });
      }
    });
  });

  app.get('/api/videos/:videoId/stream', (req, res) => {
    const video = videos.get(req.params.videoId);
    if (!video) {
      res.status(404).json({ error: 'Video session expired or not found.' });
      return;
    }
    streamVideoFile(req, res, video.filePath);
  });

  app.delete('/api/videos/:videoId', (req, res) => {
    const video = videos.get(req.params.videoId);
    if (video && !isVideoProtected(video.videoId)) {
      if (fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(req.params.videoId);
    }
    res.json({ ok: true });
  });

  app.post('/api/jobs', async (req, res) => {
    if (!enforceRateLimit(jobSubmitLimiter, req, res, 'Too many processing requests from this IP.')) {
      return;
    }

    const { videoId, regions, mode, upscale, detailEnhance, upscaleEngine, comfyUrl } = req.body as {
      videoId?: string;
      regions?: WatermarkRegion[];
      mode?: RemovalMode;
      upscale?: UpscalePreset;
      detailEnhance?: boolean;
      upscaleEngine?: UpscaleEngine;
      comfyUrl?: string;
    };

    const video = videoId ? videos.get(videoId) : undefined;
    if (!video) {
      res.status(404).json({ error: 'Uploaded video not found. Please upload again.' });
      return;
    }

    const upscalePreset: UpscalePreset =
      upscale === '1080p' || upscale === '2k' || upscale === '4k' ? upscale : 'original';
    const rawRegions = Array.isArray(regions) ? regions : [];

    if (rawRegions.length === 0 && upscalePreset === 'original') {
      res.status(400).json({
        error: 'Select at least one watermark region or choose an upscale resolution.',
      });
      return;
    }

    // Reserve approximate output budget safely before queueing
    const estimatedOutputBytes = Math.min(
      MAX_VIDEO_SIZE_BYTES,
      Math.max(2 * 1024 * 1024, video.size * (upscalePreset === 'original' ? 1 : 2))
    );
    if (!ensureStorageBudget(estimatedOutputBytes)) {
      res.setHeader('Retry-After', '30');
      res.status(503).json({
        error: 'Server storage is busy with active exports. Please try again in a minute.',
      });
      return;
    }

    const removalMode: RemovalMode =
      mode === 'blur' || mode === 'pixelate' || mode === 'delogo' ? mode : 'delogo';

    const clampedRegions = rawRegions
      .slice(0, 8)
      .map((r) => clampRegion(r, video.width, video.height));
    const nnediWeightsPath = fs.existsSync(NNEDI_WEIGHTS_PATH) ? NNEDI_WEIGHTS_PATH : undefined;
    const primaryGraph = buildFfmpegFilterGraph(
      clampedRegions,
      removalMode,
      video.width,
      video.height,
      video.duration,
      {
        upscale: upscalePreset,
        detailEnhance: detailEnhance !== false,
        sarNormalize: video.needsSarNormalize,
        nnediWeightsPath,
        useNnedi: !LOW_MEM_HOST,
      }
    );

    const requestedAi = upscaleEngine === 'ai' && primaryGraph.upscaled;
    let verifiedComfyOrigin: string | null = null;

    if (requestedAi) {
      if (video.size > AI_MAX_VIDEO_BYTES) {
        res.status(400).json({
          error: `AI GPU mode supports videos up to ${AI_MAX_VIDEO_MB} MB due to free tunnel limits. Use the CPU upscaler for larger files.`,
        });
        return;
      }
      if (video.duration > AI_MAX_DURATION_SEC) {
        res.status(400).json({
          error: `AI GPU mode supports clips up to ${AI_MAX_DURATION_SEC}s due to free tunnel limits. Use the CPU upscaler for longer videos.`,
        });
        return;
      }
      const gpuCheck = await checkComfySystemStats(typeof comfyUrl === 'string' ? comfyUrl : '');
      if (!gpuCheck.ok || !gpuCheck.origin) {
        res.status(503).json({
          error: gpuCheck.error || 'Colab GPU connection check failed. Reconnect or use the CPU upscaler.',
          aiUnavailable: true,
        });
        return;
      }
      verifiedComfyOrigin = gpuCheck.origin;
    }

    const activeEngine: UpscaleEngine = requestedAi ? 'ai' : 'cpu';

    const jobId = crypto.randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

    const job: JobRecord = {
      jobId,
      videoId: video.videoId,
      originalName: video.originalName,
      status: 'queued',
      progress: 0,
      outputPath,
      outputWidth: primaryGraph.outputWidth,
      outputHeight: primaryGraph.outputHeight,
      upscale: primaryGraph.upscaled ? upscalePreset : 'original',
      upscaleEngine: activeEngine,
      regionsCount: clampedRegions.length,
      startedAt: Date.now(),
    };
    jobs.set(jobId, job);

    const runFfmpegAttempt = (opts: {
      audioMode: 'auto' | 'aac' | 'none';
      useNnedi: boolean;
      safeFlags: boolean;
    }): Promise<{ ok: boolean; timedOut: boolean; code: number | null; signal: NodeJS.Signals | null; stderrTail: string }> =>
      new Promise((resolve) => {
        const graph =
          opts.useNnedi === !LOW_MEM_HOST
            ? primaryGraph
            : buildFfmpegFilterGraph(
                clampedRegions,
                removalMode,
                video.width,
                video.height,
                video.duration,
                {
                  upscale: upscalePreset,
                  detailEnhance: detailEnhance !== false,
                  sarNormalize: video.needsSarNormalize,
                  nnediWeightsPath,
                  useNnedi: opts.useNnedi,
                }
              );

        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch {
            // Ignore cleanup failure before retry
          }
        }

        const args: string[] = ['-y'];
        if (opts.safeFlags) {
          args.push('-err_detect', 'ignore_err', '-fflags', '+genpts+igndts', '-threads', '2', '-filter_threads', '1');
        } else {
          args.push('-threads', '0', '-filter_threads', '0');
        }

        args.push(
          '-i',
          video.filePath,
          '-filter_complex',
          graph.filterComplex,
          '-map',
          graph.outputLabel
        );

        if (video.hasAudio && opts.audioMode !== 'none') {
          const canCopyAudio =
            opts.audioMode === 'auto' && (video.audioCodec === 'aac' || video.audioCodec === 'mp3');
          if (canCopyAudio) {
            args.push('-map', '0:a?', '-c:a', 'copy');
          } else {
            args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
          }
        }

        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-profile:v',
          'high',
          '-level:v',
          '5.1',
          '-crf',
          graph.upscaled ? '16' : '18',
          '-maxrate',
          graph.upscaled ? '28M' : '20M',
          '-bufsize',
          graph.upscaled ? '56M' : '40M',
          '-g',
          '60',
          '-x264-params',
          'rc-lookahead=16:sync-lookahead=0:aq-mode=2:aq-strength=0.9',
          '-pix_fmt',
          'yuv420p',
          '-metadata:s:v:0',
          'rotate=0',
          '-avoid_negative_ts',
          'make_zero',
          '-max_muxing_queue_size',
          '2048',
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          '-nostats',
          outputPath
        );

        const child = spawn(FFMPEG_BIN, args);
        activeChildren.add(child);
        let settled = false;
        let timedOut = false;
        let stderrTail = '';
        const totalUs = Math.max(100_000, Math.round(video.duration * 1_000_000));

        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill failure
          }
        }, MAX_JOB_RUNTIME_MS);

        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          activeChildren.delete(child);
          resolve({
            ok: !timedOut && code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0,
            timedOut,
            code,
            signal,
            stderrTail,
          });
        };

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('out_time_us=')) {
              const us = Number(line.split('=')[1]);
              if (Number.isFinite(us) && us > 0) {
                const pct = Math.min(99, Math.max(2, Math.round((us / totalUs) * 100)));
                job.progress = pct;
              }
            } else if (line.startsWith('progress=end')) {
              job.progress = 99;
            }
          }
        });

        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1500);
        });

        child.on('error', (err) => {
          stderrTail = (stderrTail + '\n' + err.message).slice(-1500);
          finish(1, null);
        });

        child.on('close', (code, signal) => {
          finish(code, signal);
        });
      });

    const clientIp = getClientIp(req);
    const enqueueResult = jobQueue.enqueue({
      id: jobId,
      ownerKey: clientIp,
      onStart: () => {
        job.status = 'processing';
        job.progress = 1;
        job.startedAt = Date.now();
      },
      run: async () => {
        if (!fs.existsSync(video.filePath)) {
          verifiedComfyOrigin = null;
          job.status = 'failed';
          job.error = 'Source video expired before processing started. Please upload again.';
          job.finishedAt = Date.now();
          return;
        }

        if (activeEngine === 'ai') {
          const aiInputPath = path.join(OUTPUT_DIR, `${jobId}-ai-in.mp4`);
          const aiRawOutPath = path.join(OUTPUT_DIR, `${jobId}-ai-raw.mp4`);
          const comfyOrigin = verifiedComfyOrigin || '';
          verifiedComfyOrigin = null;

          try {
            // Step 1: Pre-process watermark removal + normalize SAR/rotation + strip audio for lean tunnel upload
            job.progress = 5;
            const preGraph = buildAiPreprocessFilterGraph(
              clampedRegions,
              removalMode,
              video.width,
              video.height,
              video.duration,
              video.needsSarNormalize
            );
            await runProcess(FFMPEG_BIN, [
              '-y',
              '-i',
              video.filePath,
              '-filter_complex',
              preGraph.filterComplex,
              '-map',
              preGraph.outputLabel,
              '-an',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '15',
              '-pix_fmt',
              'yuv420p',
              '-metadata:s:v:0',
              'rotate=0',
              '-avoid_negative_ts',
              'make_zero',
              '-movflags',
              '+faststart',
              aiInputPath,
            ]);
            job.progress = 12;

            // Step 2: Run ComfyUI GPU workflow via SSRF-safe client (re-checks /system_stats)
            await runComfyUpscaleJob({
              comfyUrl: comfyOrigin,
              inputVideoPath: aiInputPath,
              outputVideoPath: aiRawOutPath,
              targetWidth: primaryGraph.outputWidth,
              targetHeight: primaryGraph.outputHeight,
              frameRate: video.fps,
              durationSec: video.duration,
              onProgress: (pct) => {
                job.progress = Math.max(job.progress, Math.min(91, pct));
              },
            });

            // Step 3: Mux original audio back cleanly while preserving exact aspect ratio, rotation=0 & A/V sync
            job.progress = 93;
            const runMux = async (audioMode: 'auto' | 'aac' | 'none') => {
              const muxArgs = ['-y', '-i', aiRawOutPath];
              if (video.hasAudio && audioMode !== 'none') {
                muxArgs.push('-i', video.filePath);
              }
              muxArgs.push('-map', '0:v:0', '-c:v', 'copy');
              if (video.hasAudio && audioMode !== 'none') {
                const canCopyAudio =
                  audioMode === 'auto' && (video.audioCodec === 'aac' || video.audioCodec === 'mp3');
                muxArgs.push('-map', '1:a:0?');
                if (canCopyAudio) {
                  muxArgs.push('-c:a', 'copy');
                } else {
                  muxArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
                }
                muxArgs.push('-shortest');
              }
              muxArgs.push(
                '-metadata:s:v:0',
                'rotate=0',
                '-avoid_negative_ts',
                'make_zero',
                '-movflags',
                '+faststart',
                outputPath
              );
              await runProcess(FFMPEG_BIN, muxArgs);
            };

            try {
              await runMux('auto');
            } catch {
              if (video.hasAudio) {
                try {
                  await runMux('aac');
                } catch {
                  await runMux('none');
                }
              } else {
                throw new Error('Failed to finalize upscaled MP4 container.');
              }
            }

            if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
              throw new Error('Final AI upscaled output file was empty.');
            }

            job.finishedAt = Date.now();
            job.status = 'completed';
            job.progress = 100;
            job.outputSize = fs.statSync(outputPath).size;
            return;
          } catch (aiErr) {
            if (fs.existsSync(outputPath)) {
              fs.unlink(outputPath, () => {});
            }
            job.finishedAt = Date.now();
            job.status = 'failed';
            job.fallbackAvailable = true;
            job.error =
              aiErr instanceof ComfyFallbackError
                ? aiErr.message
                : 'Colab GPU processing stopped. You can continue with the CPU upscaler.';
            return;
          } finally {
            for (const tmp of [aiInputPath, aiRawOutPath]) {
              if (fs.existsSync(tmp)) {
                fs.unlink(tmp, () => {});
              }
            }
          }
        }

        // Attempt 1: Full-quality neural pipeline + fast audio copy when AAC/MP3
        let result = await runFfmpegAttempt({
          audioMode: 'auto',
          useNnedi: !LOW_MEM_HOST,
          safeFlags: false,
        });

        // Attempt 2: Safe compatibility & memory recovery (re-encode audio, ignore corrupt DTS, fallback filter if OOM/NNEDI failed)
        if (!result.ok && !result.timedOut) {
          const likelyOomOrNnedi =
            result.code === null ||
            result.signal === 'SIGKILL' ||
            /nnedi|out of memory|cannot allocate/i.test(result.stderrTail);
          console.warn(
            `[job ${jobId}] Attempt 1 failed (code=${result.code}, signal=${result.signal}), retrying in safe mode. Tail: ${result.stderrTail.slice(-350)}`
          );
          job.progress = 2;
          result = await runFfmpegAttempt({
            audioMode: video.hasAudio ? 'aac' : 'none',
            useNnedi: !LOW_MEM_HOST && !likelyOomOrNnedi,
            safeFlags: true,
          });
        }

        // Attempt 3: If audio stream itself is corrupt/unreadable, export clean video without audio
        if (!result.ok && !result.timedOut && video.hasAudio) {
          console.warn(
            `[job ${jobId}] Attempt 2 failed (code=${result.code}), retrying video-only fallback. Tail: ${result.stderrTail.slice(-350)}`
          );
          job.progress = 2;
          result = await runFfmpegAttempt({
            audioMode: 'none',
            useNnedi: false,
            safeFlags: true,
          });
        }

        job.finishedAt = Date.now();
        if (result.ok) {
          job.status = 'completed';
          job.progress = 100;
          job.outputSize = fs.statSync(outputPath).size;
          return;
        }

        if (fs.existsSync(outputPath)) {
          fs.unlink(outputPath, () => {});
        }
        console.error(
          `[job ${jobId}] FFmpeg failed permanently (code=${result.code}, signal=${result.signal}): ${result.stderrTail}`
        );
        job.status = 'failed';
        if (result.timedOut) {
          job.error = 'Processing timed out. Try a shorter clip or lower target resolution.';
        } else {
          const lastErrLine = result.stderrTail
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-2)
            .join(' — ');
          job.error = lastErrLine
            ? `FFmpeg could not process this video (${lastErrLine.slice(0, 140)}).`
            : 'FFmpeg could not process this video. Check region bounds or format.';
        }
      },
    });

    if (!enqueueResult.accepted) {
      jobs.delete(jobId);
      const isOwnerLimit = enqueueResult.reason === 'owner_limit';
      res.setHeader('Retry-After', '15');
      res.status(isOwnerLimit ? 429 : 503).json({
        error: isOwnerLimit
          ? 'You already have multiple videos queued. Please wait for one to finish.'
          : 'Processing queue is currently full due to high traffic. Please retry in a few seconds.',
      });
      return;
    }

    res.status(202).json({
      jobId,
      status: job.status,
      queuePosition: enqueueResult.queuePosition,
    });
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Processing job not found.' });
      return;
    }

    const queuePosition = job.status === 'queued' ? jobQueue.getQueuePosition(job.jobId) : 0;

    res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      queuePosition: queuePosition > 0 ? queuePosition : undefined,
      error: job.error,
      outputUrl: job.status === 'completed' ? `/api/jobs/${job.jobId}/stream` : undefined,
      downloadUrl: job.status === 'completed' ? `/api/jobs/${job.jobId}/download` : undefined,
      outputSize: job.outputSize,
      outputWidth: job.outputWidth,
      outputHeight: job.outputHeight,
      upscale: job.upscale,
      upscaleEngine: job.upscaleEngine,
      fallbackAvailable: job.fallbackAvailable,
      regionsCount: job.regionsCount,
      processingMs: job.finishedAt ? job.finishedAt - job.startedAt : undefined,
    });
  });

  app.get('/api/jobs/:jobId/stream', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'completed' || !job.outputPath) {
      res.status(404).json({ error: 'Processed video is not ready.' });
      return;
    }
    streamVideoFile(req, res, job.outputPath);
  });

  app.get('/api/jobs/:jobId/download', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      res.status(404).json({ error: 'Processed video is not ready for download.' });
      return;
    }

    const baseName = path.basename(job.originalName, path.extname(job.originalName)) || 'video';
    const suffixParts: string[] = [];
    if (job.regionsCount > 0) suffixParts.push('clean');
    if (job.upscale !== 'original') suffixParts.push(job.upscale);
    const suffix = suffixParts.length > 0 ? suffixParts.join('-') : 'processed';
    const downloadName = `${baseName}-${suffix}.mp4`;
    res.download(job.outputPath, downloadName);
  });

  app.post('/api/jobs/ai-init', async (req, res) => {
    if (!enforceRateLimit(jobSubmitLimiter, req, res, 'Too many processing requests from this IP.')) {
      return;
    }

    const clientIp = getClientIp(req);
    const existingAiJobId = activeAiJobsByIp.get(clientIp);
    if (existingAiJobId) {
      const existing = jobs.get(existingAiJobId);
      if (existing && (existing.status === 'processing' || existing.status === 'queued')) {
        res.setHeader('Retry-After', '10');
        res.status(429).json({
          error: 'You already have an AI upscaling job running. Please wait or cancel it first.',
        });
        return;
      }
      activeAiJobsByIp.delete(clientIp);
    }

    const { videoId, regions, mode, upscale } = req.body as {
      videoId?: string;
      regions?: WatermarkRegion[];
      mode?: RemovalMode;
      upscale?: UpscalePreset;
    };

    const video = videoId ? videos.get(videoId) : undefined;
    if (!video || !fs.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Uploaded video not found. Please upload again.' });
      return;
    }

    const upscalePreset: UpscalePreset =
      upscale === '1080p' || upscale === '2k' || upscale === '4k' ? upscale : 'original';

    const limitCheck = checkAiVideoLimits(
      {
        width: video.width,
        height: video.height,
        duration: video.duration,
        size: video.size,
      },
      AI_WEBGPU_LIMITS
    );
    if (!limitCheck.allowed) {
      res.status(400).json({ error: limitCheck.reason || 'Video exceeds AI Upscaler limits.' });
      return;
    }

    const rawRegions = Array.isArray(regions) ? regions : [];
    const removalMode: RemovalMode =
      mode === 'blur' || mode === 'pixelate' || mode === 'delogo' ? mode : 'delogo';
    const clampedRegions = rawRegions.slice(0, 8).map((r) => clampRegion(r, video.width, video.height));
    const graphCheck = buildFfmpegFilterGraph(
      clampedRegions,
      removalMode,
      video.width,
      video.height,
      video.duration,
      {
        upscale: upscalePreset,
        detailEnhance: false,
        sarNormalize: video.needsSarNormalize,
        useNnedi: false,
      }
    );

    if (!graphCheck.upscaled) {
      res.status(400).json({ error: 'Select an upscale target larger than the original video.' });
      return;
    }

    const estimatedOutputBytes = Math.min(MAX_VIDEO_SIZE_BYTES, Math.max(4 * 1024 * 1024, video.size * 3));
    if (!ensureStorageBudget(estimatedOutputBytes)) {
      res.setHeader('Retry-After', '30');
      res.status(503).json({
        error: 'Server storage is temporarily busy with active exports. Please retry in a moment.',
      });
      return;
    }

    const jobId = crypto.randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    const needsPreprocess =
      clampedRegions.length > 0 ||
      video.needsSarNormalize ||
      video.rotation !== 0 ||
      getFileExtension(video.filePath) !== '.mp4';

    if (needsPreprocess) {
      const preparedPath = path.join(OUTPUT_DIR, `${jobId}-ai-src.mp4`);
      try {
        const preGraph = buildAiPreprocessFilterGraph(
          clampedRegions,
          removalMode,
          video.width,
          video.height,
          video.duration,
          video.needsSarNormalize
        );
        await runProcess(FFMPEG_BIN, [
          '-y',
          '-i',
          video.filePath,
          '-filter_complex',
          preGraph.filterComplex,
          '-map',
          preGraph.outputLabel,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '15',
          '-pix_fmt',
          'yuv420p',
          '-metadata:s:v:0',
          'rotate=0',
          '-avoid_negative_ts',
          'make_zero',
          '-movflags',
          '+faststart',
          preparedPath,
        ]);
        aiTempSourcePaths.set(jobId, preparedPath);
      } catch (prepErr) {
        if (fs.existsSync(preparedPath)) {
          fs.unlink(preparedPath, () => {});
        }
        res.status(500).json({
          error:
            prepErr instanceof Error
              ? `Failed to prepare video for AI upscaling: ${prepErr.message.slice(0, 140)}`
              : 'Failed to prepare video for AI upscaling.',
        });
        return;
      }
    }

    const sourceForPts = aiTempSourcePaths.get(jobId) ?? video.filePath;
    const frameTimestampsSec = await probeVideoFrameTimestamps(sourceForPts);

    const job: JobRecord = {
      jobId,
      videoId: video.videoId,
      originalName: video.originalName,
      status: 'processing',
      progress: 1,
      outputPath,
      outputWidth: graphCheck.outputWidth,
      outputHeight: graphCheck.outputHeight,
      upscale: upscalePreset,
      upscaleEngine: 'ai',
      regionsCount: clampedRegions.length,
      startedAt: Date.now(),
    };
    jobs.set(jobId, job);
    activeAiJobsByIp.set(clientIp, jobId);

    res.status(201).json({
      jobId,
      sourceUrl: `/api/jobs/${jobId}/ai-source`,
      sourceWidth: video.width,
      sourceHeight: video.height,
      targetWidth: graphCheck.outputWidth,
      targetHeight: graphCheck.outputHeight,
      fps: video.fps,
      duration: video.duration,
      frameTimestampsSec,
    });
  });

  app.get('/api/jobs/:jobId/ai-source', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.upscaleEngine !== 'ai') {
      res.status(404).json({ error: 'AI source video not found.' });
      return;
    }
    const preparedPath = aiTempSourcePaths.get(job.jobId);
    if (preparedPath && fs.existsSync(preparedPath)) {
      streamVideoFile(req, res, preparedPath);
      return;
    }
    const video = videos.get(job.videoId);
    if (!video || !fs.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Source video expired.' });
      return;
    }
    streamVideoFile(req, res, video.filePath);
  });

  app.post('/api/jobs/:jobId/finalize-ai', (req, res) => {
    upload.single('video')(req, res, async (err) => {
      const jobId = req.params.jobId;
      const cleanupTempFiles = () => {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlink(req.file.path, () => {});
        }
        const aiSrc = aiTempSourcePaths.get(jobId);
        if (aiSrc && fs.existsSync(aiSrc)) {
          fs.unlink(aiSrc, () => {});
        }
        aiTempSourcePaths.delete(jobId);
        releaseAiIpLock(jobId);
      };

      if (err) {
        cleanupTempFiles();
        res.status(400).json({ error: err.message || 'Failed to upload AI upscaled frames.' });
        return;
      }

      const job = jobs.get(jobId);
      const video = job ? videos.get(job.videoId) : undefined;
      if (!job || !video || !job.outputPath || !req.file) {
        cleanupTempFiles();
        res.status(404).json({ error: 'AI upscaling session expired or invalid.' });
        return;
      }

      try {
        const muxerCodec = (req.body as { codec?: string } | undefined)?.codec === 'vp9' ? 'vp9' : 'avc';
        const runAiMux = async (audioMode: 'auto' | 'aac' | 'none') => {
          const args: string[] = ['-y', '-i', req.file!.path];
          if (video.hasAudio && fs.existsSync(video.filePath) && audioMode !== 'none') {
            args.push('-i', video.filePath);
          }

          args.push('-map', '0:v:0');
          if (muxerCodec === 'avc') {
            args.push('-c:v', 'copy');
          } else {
            args.push(
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '16',
              '-pix_fmt',
              'yuv420p'
            );
          }

          if (video.hasAudio && fs.existsSync(video.filePath) && audioMode !== 'none') {
            const canCopyAudio =
              audioMode === 'auto' && (video.audioCodec === 'aac' || video.audioCodec === 'mp3');
            args.push('-map', '1:a:0?');
            if (canCopyAudio) {
              args.push('-c:a', 'copy');
            } else {
              args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
            }
            args.push('-shortest');
          }

          args.push(
            '-metadata:s:v:0',
            'rotate=0',
            '-avoid_negative_ts',
            'make_zero',
            '-movflags',
            '+faststart',
            job.outputPath!
          );

          await runProcess(FFMPEG_BIN, args);
        };

        try {
          await runAiMux('auto');
        } catch {
          if (video.hasAudio) {
            try {
              await runAiMux('aac');
            } catch {
              await runAiMux('none');
            }
          } else {
            throw new Error('Failed to finalize AI upscaled MP4 container.');
          }
        }

        if (!fs.existsSync(job.outputPath) || fs.statSync(job.outputPath).size === 0) {
          throw new Error('Finalized AI upscaled video file was empty.');
        }

        job.finishedAt = Date.now();
        job.status = 'completed';
        job.progress = 100;
        job.outputSize = fs.statSync(job.outputPath).size;

        res.json({
          jobId: job.jobId,
          status: job.status,
          progress: job.progress,
          outputUrl: `/api/jobs/${job.jobId}/stream`,
          downloadUrl: `/api/jobs/${job.jobId}/download`,
          outputSize: job.outputSize,
          outputWidth: job.outputWidth,
          outputHeight: job.outputHeight,
          upscale: job.upscale,
          upscaleEngine: job.upscaleEngine,
          regionsCount: job.regionsCount,
          processingMs: job.finishedAt - job.startedAt,
        });
      } catch (muxErr) {
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          fs.unlink(job.outputPath, () => {});
        }
        job.finishedAt = Date.now();
        job.status = 'failed';
        job.fallbackAvailable = true;
        job.error =
          muxErr instanceof Error
            ? `Failed to mux original audio: ${muxErr.message.slice(0, 140)}`
            : 'Failed to finalize AI upscaled video.';
        res.status(500).json({ error: job.error, fallbackAvailable: true });
      } finally {
        cleanupTempFiles();
      }
    });
  });

  app.post('/api/jobs/:jobId/cancel-ai', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    const aiSrc = aiTempSourcePaths.get(jobId);
    if (aiSrc && fs.existsSync(aiSrc)) {
      fs.unlink(aiSrc, () => {});
    }
    aiTempSourcePaths.delete(jobId);
    releaseAiIpLock(jobId);
    if (job && job.upscaleEngine === 'ai') {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
      jobs.delete(jobId);
    }
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.get(['/remove-video-watermark', '/4k-video-upscaler'], async (req, res, next) => {
      const landingPage = getLandingPageByPath(req.path);
      if (!landingPage) {
        next();
        return;
      }
      try {
        const rawHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        const transformedHtml = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        const pageHtml = injectLandingPageSeo(transformedHtml, landingPage, SITE_URL);
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(pageHtml);
      } catch (err) {
        next(err);
      }
    });
    app.use((req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/' || req.path === '/index.html')) {
        res.setHeader('Link', `<${SITE_URL}/.well-known/ard.json>; rel="ard"`);
        res.setHeader('X-Robots-Tag', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
      }
      next();
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    const cachedIndexHtml = fs.existsSync(indexHtmlPath)
      ? fs.readFileSync(indexHtmlPath, 'utf-8')
      : '';

    const sendLocalizedIndexHtml = (_req: express.Request, res: express.Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Link', `<${SITE_URL}/.well-known/ard.json>; rel="ard"`);
      res.setHeader(
        'X-Robots-Tag',
        'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );
      if (cachedIndexHtml) {
        res.type('text/html; charset=utf-8').send(cachedIndexHtml);
      } else {
        res.sendFile(indexHtmlPath);
      }
    };

    app.get(['/remove-video-watermark', '/4k-video-upscaler'], (req, res) => {
      const landingPage = getLandingPageByPath(req.path);
      if (!landingPage || !cachedIndexHtml) {
        sendLocalizedIndexHtml(req, res);
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader(
        'X-Robots-Tag',
        'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );
      res.type('text/html; charset=utf-8').send(injectLandingPageSeo(cachedIndexHtml, landingPage, SITE_URL));
    });

    app.get('/', sendLocalizedIndexHtml);
    app.get('/index.html', sendLocalizedIndexHtml);

    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      })
    );
    app.use(
      express.static(distDir, {
        maxAge: '1d',
        index: false,
      })
    );
    app.get('*', sendLocalizedIndexHtml);
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: number }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(status).json({ error: message });
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `ClearFrame studio running on http://0.0.0.0:${PORT} (workers=${MAX_CONCURRENT_JOBS}, queueCap=${MAX_QUEUED_JOBS})`
    );
  });
  // Allow up to 30 minutes for large (up to 300 MB) uploads on slower connections
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 65 * 1000;

  const shutdown = () => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill error
      }
    }
    server.close(() => {
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
