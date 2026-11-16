import express from 'express';
import compression from 'compression';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_MB,
  SUPPORTED_VIDEO_EXTENSIONS,
  buildFfmpegFilterGraph,
  clampRegion,
  getFileExtension,
  type RemovalMode,
  type UpscalePreset,
  type VideoMetadata,
  type WatermarkRegion,
} from './src/utils/watermark.ts';

const PORT = Number(process.env.PORT || 3000);
const WORK_DIR = '/tmp/clearframe-studio';
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const OUTPUT_DIR = path.join(WORK_DIR, 'outputs');
const SAMPLE_DIR = path.join(WORK_DIR, 'sample');
const SAMPLE_PATH = path.join(SAMPLE_DIR, 'sample-watermarked.mp4');
const FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';

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
      r_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error('No readable video stream found in the uploaded file.');
  }

  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const rawDuration = Number(parsed.format?.duration ?? videoStream.duration ?? 0);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 5;

  let fps = 30;
  if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) {
      fps = Math.round((num / den) * 100) / 100;
    }
  }

  return {
    width: videoStream.width,
    height: videoStream.height,
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
    const hasFont = fs.existsSync(FONT_PATH);
    // Clean scenic animated background with an unmistakable corner watermark box
    const drawParts = [
      "drawbox=x=0:y=0:w=1280:h=240:color=#0f172a@0.85:t=fill",
      "drawbox=x=0:y=240:w=1280:h=240:color=#1e3a8a@0.75:t=fill",
      "drawbox=x=0:y=480:w=1280:h=240:color=#0369a1@0.75:t=fill",
      "drawbox=x=mod(t*220\\,1280)-180:y=160:w=220:h=400:color=#38bdf8@0.35:t=fill",
      "drawbox=x=1280-mod(t*160\\,1280):y=220:w=180:h=260:color=#e0f2fe@0.25:t=fill",
      "drawbox=x=906:y=616:w=326:h=60:color=#ffffff@0.22:t=fill",
      "drawbox=x=906:y=616:w=326:h=60:color=#ffffff@0.55:t=2",
    ];

    if (hasFont) {
      drawParts.push(
        `drawtext=fontfile=${FONT_PATH}:text='CLEARFRAME SAMPLE':x=72:y=96:fontsize=42:fontcolor=#f8fafc@0.92`,
        `drawtext=fontfile=${FONT_PATH}:text='WATERMARK DEMO':x=924:y=634:fontsize=26:fontcolor=#ffffff@0.95`
      );
    }

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
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function cleanupExpiredFiles(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, video] of videos.entries()) {
    if (video.createdAt < cutoff) {
      if (!video.isSample && fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(id);
    }
  }
  for (const [jobId, job] of jobs.entries()) {
    if (job.startedAt < cutoff) {
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
}

setInterval(cleanupExpiredFiles, 5 * 60 * 1000).unref();

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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, maxUploadMb: MAX_VIDEO_SIZE_MB });
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
        `Sitemap: ${baseUrl}/sitemap.xml`,
        `Agentmap: ${baseUrl}/.well-known/ard.json`,
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
        '- Maximum File Size: Up to 300 MB per video upload (100% free)',
        '- Supported Input Formats: MP4, MOV, WebM, MKV, AVI, M4V',
        '- Watermark Removal Engines: Smart Inpaint (delogo), Soft Blur (boxblur), Mosaic Mask',
        '- Multi-Region Selection: Up to 8 independent boxes with optional start/end timestamps',
        '- Video Upscaling: Original, 1080p Full HD, 2K QHD, and 4K UHD (3840x2160), preserving aspect ratio without downscaling source footage',
        '- Audio & Privacy: Original audio track preserved; temporary uploads auto-deleted after 30 minutes',
        '',
        '## Pages & Discovery',
        `- [ClearFrame Workspace](${baseUrl}/#workspace): Upload videos up to 300 MB, mark watermark regions, and export clean MP4.`,
        `- [How It Works](${baseUrl}/#how-it-works): Step-by-step guide to watermark removal and 4K upscaling.`,
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

  app.post('/api/sample', async (_req, res) => {
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
    if (video) {
      if (!video.isSample && fs.existsSync(video.filePath)) {
        fs.unlink(video.filePath, () => {});
      }
      videos.delete(req.params.videoId);
    }
    res.json({ ok: true });
  });

  app.post('/api/jobs', (req, res) => {
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

    const removalMode: RemovalMode =
      mode === 'blur' || mode === 'pixelate' || mode === 'delogo' ? mode : 'delogo';

    const clampedRegions = rawRegions
      .slice(0, 8)
      .map((r) => clampRegion(r, video.width, video.height));
    const { filterComplex, outputLabel, outputWidth, outputHeight, upscaled } =
      buildFfmpegFilterGraph(
        clampedRegions,
        removalMode,
        video.width,
        video.height,
        video.duration,
        {
          upscale: upscalePreset,
          detailEnhance: detailEnhance !== false,
        }
      );

    const jobId = crypto.randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

    const job: JobRecord = {
      jobId,
      videoId: video.videoId,
      originalName: video.originalName,
      status: 'processing',
      progress: 1,
      outputPath,
      outputWidth,
      outputHeight,
      upscale: upscaled ? upscalePreset : 'original',
      regionsCount: clampedRegions.length,
      startedAt: Date.now(),
    };
    jobs.set(jobId, job);

    const args = [
      '-y',
      '-threads',
      '0',
      '-filter_threads',
      '0',
      '-i',
      video.filePath,
      '-filter_complex',
      filterComplex,
      '-map',
      outputLabel,
    ];

    if (video.hasAudio) {
      const canCopyAudio = video.audioCodec === 'aac' || video.audioCodec === 'mp3';
      if (canCopyAudio) {
        args.push('-map', '0:a?', '-c:a', 'copy');
      } else {
        args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '192k');
      }
    }

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'superfast',
      '-crf',
      upscaled ? '17' : '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      outputPath
    );

    const child = spawn(FFMPEG_BIN, args);
    let stderrTail = '';
    const totalUs = Math.max(100_000, Math.round(video.duration * 1_000_000));

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
      stderrTail = (stderrTail + chunk.toString()).slice(-1000);
    });

    child.on('error', (err) => {
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = Date.now();
    });

    child.on('close', (code) => {
      job.finishedAt = Date.now();
      if (code === 0 && fs.existsSync(outputPath)) {
        job.status = 'completed';
        job.progress = 100;
        job.outputSize = fs.statSync(outputPath).size;
      } else {
        job.status = 'failed';
        job.error = 'FFmpeg could not process this video. Check region bounds or format.';
      }
    });

    res.status(202).json({ jobId });
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Processing job not found.' });
      return;
    }

    res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
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
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
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
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClearFrame studio running on http://0.0.0.0:${PORT}`);
    // Pre-warm sample video in background so "Try Sample Video" is instant
    ensureSampleVideo().catch(() => {});
  });
  // Allow up to 30 minutes for large (up to 300 MB) uploads on slower connections
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 65 * 1000;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
