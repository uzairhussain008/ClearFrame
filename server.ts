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
  buildFfmpegFilterGraph,
  clampRegion,
  getFileExtension,
  resolveDisplayDimensions,
  type RemovalMode,
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
const DEFAULT_STORAGE_MB = Math.min(3584, Math.max(512, Math.floor(TOTAL_MEM_MB * 0.4)));
const MAX_WORK_DIR_BYTES =
  Math.max(512, Number(process.env.MAX_STORAGE_MB) || DEFAULT_STORAGE_MB) * 1024 * 1024;
const EXPIRY_TTL_MS = 15 * 60 * 1000;
const MAX_JOB_RUNTIME_MS = 15 * 60 * 1000;
const WORK_DIR = '/tmp/clearframe-studio';
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const OUTPUT_DIR = path.join(WORK_DIR, 'outputs');
const SAMPLE_DIR = path.join(WORK_DIR, 'sample');
const SAMPLE_PATH = path.join(SAMPLE_DIR, 'sample-watermarked.mp4');
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

const FFPROBE_STATIC_PATH = (() => {
  try {
    const mod = require('ffprobe-static') as { path?: string } | undefined;
    return mod?.path ?? null;
  } catch {
    return null;
  }
})();

const FFMPEG_BIN = resolveExecutable(process.env.FFMPEG_PATH, FFMPEG_STATIC_PATH, 'ffmpeg');
const FFPROBE_BIN = resolveExecutable(process.env.FFPROBE_PATH, FFPROBE_STATIC_PATH, 'ffprobe');

for (const dir of [WORK_DIR, UPLOAD_DIR, OUTPUT_DIR, SAMPLE_DIR]) {
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
  isSample?: boolean;
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
const activeChildren = new Set<ChildProcess>();

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
const sampleLimiter = new SlidingWindowRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_SAMPLE) || 20,
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
      if (!video.isSample && fs.existsSync(video.filePath)) {
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
    if (video.isSample) continue;
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
  const { stdout } = await runProcess(FFPROBE_BIN, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

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

let sampleGenerationPromise: Promise<void> | null = null;

async function ensureSampleVideo(): Promise<void> {
  if (fs.existsSync(SAMPLE_PATH) && fs.statSync(SAMPLE_PATH).size > 1024) {
    return;
  }
  if (sampleGenerationPromise) {
    return sampleGenerationPromise;
  }

  sampleGenerationPromise = (async () => {
    // Clean scenic animated background with an unmistakable corner watermark box (pure drawbox for universal FFmpeg compatibility)
    const drawParts = [
      'drawbox=x=0:y=0:w=1280:h=240:color=#0f172a@0.85:t=fill',
      'drawbox=x=0:y=240:w=1280:h=240:color=#1e3a8a@0.75:t=fill',
      'drawbox=x=0:y=480:w=1280:h=240:color=#0369a1@0.75:t=fill',
      'drawbox=x=mod(t*220\\,1280)-180:y=160:w=220:h=400:color=#38bdf8@0.35:t=fill',
      'drawbox=x=1280-mod(t*160\\,1280):y=220:w=180:h=260:color=#e0f2fe@0.25:t=fill',
      'drawbox=x=906:y=616:w=326:h=60:color=#ffffff@0.25:t=fill',
      'drawbox=x=906:y=616:w=326:h=60:color=#ffffff@0.75:t=3',
      'drawbox=x=924:y=632:w=28:h=28:color=#38bdf8@0.95:t=fill',
      'drawbox=x=966:y=636:w=246:h=8:color=#ffffff@0.92:t=fill',
      'drawbox=x=966:y=650:w=180:h=8:color=#bae6fd@0.85:t=fill',
    ];

    await runProcess(FFMPEG_BIN, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=#0f172a:s=1280x720:d=5:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=5',
      '-vf',
      drawParts.join(','),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      SAMPLE_PATH,
    ]);
  })().finally(() => {
    sampleGenerationPromise = null;
  });

  return sampleGenerationPromise;
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
      if (!video.isSample && fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(id);
    }
  }
  for (const [jobId, job] of jobs.entries()) {
    const isActive = job.status === 'queued' || job.status === 'processing';
    if (!isActive && (job.finishedAt ?? job.startedAt) < cutoff) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
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
  sampleLimiter.prune(now);
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
      queue: jobQueue.getStats(),
    });
  });

  function getBaseUrl(req: express.Request): string {
    const rawHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    if (rawHost) {
      const rawProto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
      const proto = rawHost.startsWith('localhost') || rawHost.startsWith('127.') ? 'http' : rawProto || 'https';
      return `${proto}://${rawHost}`.replace(/\/$/, '');
    }
    return (process.env.APP_URL || 'https://clearframe.ai.studio').replace(/\/$/, '');
  }

  app.get('/robots.txt', (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        '',
        `Sitemap: ${baseUrl}/sitemap.xml`,
      ].join('\n') + '\n'
    );
  });

  app.get('/sitemap.xml', (req, res) => {
    const baseUrl = getBaseUrl(req);
    const today = new Date().toISOString().split('T')[0];
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${baseUrl}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`
    );
  });

  app.get('/llms.txt', (req, res) => {
    const baseUrl = getBaseUrl(req);
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

  const handleArdManifest = (req: express.Request, res: express.Response) => {
    const baseUrl = getBaseUrl(req);
    let publisherHost = 'clearframe.ai.studio';
    try {
      publisherHost = new URL(baseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, '') || publisherHost;
    } catch {
      // Fallback to default host
    }
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

  app.post('/api/sample', async (req, res) => {
    if (!enforceRateLimit(sampleLimiter, req, res, 'Too many sample requests from this IP.')) {
      return;
    }
    try {
      await ensureSampleVideo();
      const stat = fs.statSync(SAMPLE_PATH);
      const info = await probeVideo(SAMPLE_PATH);
      const videoId = `sample-${crypto.randomUUID().slice(0, 8)}`;

      const stored: StoredVideo = {
        videoId,
        originalName: 'sample-watermarked-clip.mp4',
        filePath: SAMPLE_PATH,
        size: stat.size,
        width: info.width,
        height: info.height,
        needsSarNormalize: info.needsSarNormalize,
        rotation: info.rotation,
        duration: info.duration,
        fps: info.fps,
        hasAudio: info.hasAudio,
        createdAt: Date.now(),
        isSample: true,
      };
      videos.set(videoId, stored);

      const payload: VideoMetadata = {
        videoId,
        originalName: stored.originalName,
        size: stored.size,
        width: stored.width,
        height: stored.height,
        duration: stored.duration,
        fps: stored.fps,
        hasAudio: stored.hasAudio,
        previewUrl: `/api/videos/${videoId}/stream`,
        isSample: true,
        suggestedRegion: {
          x: 902,
          y: 612,
          w: 334,
          h: 68,
          startTime: null,
          endTime: null,
        },
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to prepare sample video.',
      });
    }
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
      if (!video.isSample && fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(req.params.videoId);
    }
    res.json({ ok: true });
  });

  app.post('/api/jobs', (req, res) => {
    if (!enforceRateLimit(jobSubmitLimiter, req, res, 'Too many processing requests from this IP.')) {
      return;
    }

    const { videoId, regions, mode, upscale, detailEnhance } = req.body as {
      videoId?: string;
      regions?: WatermarkRegion[];
      mode?: RemovalMode;
      upscale?: UpscalePreset;
      detailEnhance?: boolean;
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
          job.status = 'failed';
          job.error = 'Source video expired before processing started. Please upload again.';
          job.finishedAt = Date.now();
          return;
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

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use((req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/' || req.path === '/index.html')) {
        const baseUrl = getBaseUrl(req);
        res.setHeader('Link', `<${baseUrl}/.well-known/ard.json>; rel="ard"`);
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

    const sendLocalizedIndexHtml = (req: express.Request, res: express.Response) => {
      const baseUrl = getBaseUrl(req);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Link', `<${baseUrl}/.well-known/ard.json>; rel="ard"`);
      res.setHeader(
        'X-Robots-Tag',
        'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );
      if (cachedIndexHtml) {
        res
          .type('text/html; charset=utf-8')
          .send(cachedIndexHtml.replaceAll('https://clearframe.ai.studio', baseUrl));
      } else {
        res.sendFile(indexHtmlPath);
      }
    };

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
    // Pre-warm sample video in background so "Try Sample Video" is instant
    ensureSampleVideo().catch(() => {});
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
