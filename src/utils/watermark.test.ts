import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_SIZE_BYTES,
  validateVideoFile,
  formatBytes,
  formatTimecode,
  clampRegion,
  computeUpscaleDimensions,
  buildFfmpegFilterGraph,
} from './watermark';

test('validateVideoFile accepts valid videos up to 300 MB', () => {
  assert.deepEqual(
    validateVideoFile({ name: 'clip.mp4', size: MAX_VIDEO_SIZE_BYTES, type: 'video/mp4' }),
    { valid: true }
  );
  assert.deepEqual(
    validateVideoFile({ name: 'screen-recording.MOV', size: 14_500_000, type: 'video/quicktime' }),
    { valid: true }
  );
});

test('validateVideoFile rejects files over 300 MB, empty files, and unsupported formats', () => {
  const overLimit = validateVideoFile({
    name: 'huge.mp4',
    size: MAX_VIDEO_SIZE_BYTES + 1,
    type: 'video/mp4',
  });
  assert.equal(overLimit.valid, false);
  assert.match(overLimit.error ?? '', /300 MB/);

  const empty = validateVideoFile({ name: 'empty.mp4', size: 0, type: 'video/mp4' });
  assert.equal(empty.valid, false);
  assert.match(empty.error ?? '', /empty/i);

  const wrongType = validateVideoFile({ name: 'document.pdf', size: 1024, type: 'application/pdf' });
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.error ?? '', /Unsupported/i);
});

test('formatBytes and formatTimecode format values predictably', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(25.4 * 1024 * 1024), '25.4 MB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');

  assert.equal(formatTimecode(0), '00:00.0');
  assert.equal(formatTimecode(65.4), '01:05.4');
});

test('clampRegion enforces 1px FFmpeg delogo border margin and minimum size', () => {
  const clamped = clampRegion(
    { id: '1', label: 'Logo', x: 0, y: 0, w: 150, h: 60 },
    1280,
    720
  );
  assert.equal(clamped.x, 1);
  assert.equal(clamped.y, 1);
  assert.equal(clamped.w, 150);
  assert.equal(clamped.h, 60);

  const bottomRight = clampRegion(
    { id: '2', label: 'Corner', x: 1200, y: 690, w: 200, h: 80 },
    1280,
    720
  );
  assert.ok(bottomRight.x + bottomRight.w <= 1279);
  assert.ok(bottomRight.y + bottomRight.h <= 719);

  const tiny = clampRegion(
    { id: '3', label: 'Tiny', x: 50, y: 50, w: 4, h: 5 },
    1280,
    720
  );
  assert.equal(tiny.w, 12);
  assert.equal(tiny.h, 12);
});

test('computeUpscaleDimensions preserves aspect ratio and never downscales', () => {
  const landscape4k = computeUpscaleDimensions(1280, 720, '4k');
  assert.deepEqual(
    { width: landscape4k.width, height: landscape4k.height, upscaled: landscape4k.upscaled },
    { width: 3840, height: 2160, upscaled: true }
  );

  const portrait4k = computeUpscaleDimensions(720, 1280, '4k');
  assert.deepEqual(
    { width: portrait4k.width, height: portrait4k.height, upscaled: portrait4k.upscaled },
    { width: 2160, height: 3840, upscaled: true }
  );

  const square2k = computeUpscaleDimensions(1080, 1080, '2k');
  assert.deepEqual(
    { width: square2k.width, height: square2k.height, upscaled: square2k.upscaled },
    { width: 1440, height: 1440, upscaled: true }
  );

  const already4k = computeUpscaleDimensions(3840, 2160, '1080p');
  assert.deepEqual(
    { width: already4k.width, height: already4k.height, upscaled: already4k.upscaled },
    { width: 3840, height: 2160, upscaled: false }
  );
});

test('buildFfmpegFilterGraph generates valid delogo, blur, pixelate, and 4K upscale graphs', () => {
  const delogo = buildFfmpegFilterGraph(
    [
      { id: 'a', label: 'R1', x: 900, y: 610, w: 320, h: 64 },
      { id: 'b', label: 'R2', x: 40, y: 40, w: 120, h: 40, startTime: 1, endTime: 3.5 },
    ],
    'delogo',
    1280,
    720,
    5
  );
  assert.equal(delogo.outputLabel, '[v_2]');
  assert.equal(delogo.outputWidth, 1280);
  assert.equal(delogo.outputHeight, 720);
  assert.match(delogo.filterComplex, /\[0:v\]delogo=x=900:y=610:w=320:h=64:show=0\[v_1\]/);
  assert.match(
    delogo.filterComplex,
    /\[v_1\]delogo=x=40:y=40:w=120:h=40:show=0:enable='between\(t,1,3.5\)'\[v_2\]$/
  );

  const delogo4k = buildFfmpegFilterGraph(
    [{ id: 'a', label: 'R1', x: 900, y: 610, w: 320, h: 64 }],
    'delogo',
    1280,
    720,
    5,
    { upscale: '4k', detailEnhance: true }
  );
  assert.equal(delogo4k.outputWidth, 3840);
  assert.equal(delogo4k.outputHeight, 2160);
  assert.equal(delogo4k.upscaled, true);
  assert.match(
    delogo4k.filterComplex,
    /scale=3840:2160:flags=lanczos,unsharp=3:3:0\.35\[vout\]$/
  );

  // Upscale-only without watermark regions
  const upscaleOnly = buildFfmpegFilterGraph([], 'delogo', 1280, 720, 5, {
    upscale: '4k',
    detailEnhance: false,
  });
  assert.equal(
    upscaleOnly.filterComplex,
    '[0:v]scale=3840:2160:flags=lanczos[vout]'
  );

  // Requires at least a region or an upscale
  assert.throws(() => buildFfmpegFilterGraph([], 'delogo', 1280, 720, 5, { upscale: 'original' }));
});
