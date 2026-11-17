import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_SIZE_BYTES,
  validateVideoFile,
  formatBytes,
  formatTimecode,
  clampRegion,
  resolveDisplayDimensions,
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

test('resolveDisplayDimensions handles 90/-90/270 rotation metadata and non-square SAR', () => {
  const portraitRotated = resolveDisplayDimensions(1280, 720, '1:1', -90);
  assert.deepEqual(
    { width: portraitRotated.width, height: portraitRotated.height, needsSarNormalize: portraitRotated.needsSarNormalize },
    { width: 720, height: 1280, needsSarNormalize: false }
  );

  const portrait270 = resolveDisplayDimensions(1920, 1080, '1:1', 270);
  assert.deepEqual(
    { width: portrait270.width, height: portrait270.height },
    { width: 1080, height: 1920 }
  );

  const upsideDownHoriz = resolveDisplayDimensions(1280, 720, '1:1', 180);
  assert.deepEqual(
    { width: upsideDownHoriz.width, height: upsideDownHoriz.height },
    { width: 1280, height: 720 }
  );

  const anamorphic = resolveDisplayDimensions(1440, 1080, '4:3', 0);
  assert.deepEqual(
    { width: anamorphic.width, height: anamorphic.height, needsSarNormalize: anamorphic.needsSarNormalize },
    { width: 1920, height: 1080, needsSarNormalize: true }
  );
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

test('computeUpscaleDimensions preserves aspect ratio, orientation, and never downscales', () => {
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
  assert.ok(portrait4k.width < portrait4k.height);

  const portraitReel = computeUpscaleDimensions(480, 854, '4k');
  assert.ok(portraitReel.width < portraitReel.height);
  assert.ok(Math.abs(portraitReel.width / portraitReel.height - 480 / 854) < 0.01);

  const square2k = computeUpscaleDimensions(1080, 1080, '2k');
  assert.deepEqual(
    { width: square2k.width, height: square2k.height, upscaled: square2k.upscaled },
    { width: 1440, height: 1440, upscaled: true }
  );
  assert.equal(square2k.width, square2k.height);

  const already4k = computeUpscaleDimensions(3840, 2160, '1080p');
  assert.deepEqual(
    { width: already4k.width, height: already4k.height, upscaled: already4k.upscaled },
    { width: 3840, height: 2160, upscaled: false }
  );
});

test('buildFfmpegFilterGraph generates valid delogo, NNEDI3 restoration, SAR normalize, and 4K upscale graphs', () => {
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
  assert.equal(delogo.outputLabel, '[vout]');
  assert.equal(delogo.outputWidth, 1280);
  assert.equal(delogo.outputHeight, 720);
  assert.match(delogo.filterComplex, /\[0:v\]delogo=x=900:y=610:w=320:h=64:show=0\[v_1\]/);
  assert.match(
    delogo.filterComplex,
    /\[v_1\]delogo=x=40:y=40:w=120:h=40:show=0:enable='between\(t,1,3.5\)'\[v_2\];\[v_2\]setsar=1\[vout\]$/
  );

  const delogo4k = buildFfmpegFilterGraph(
    [{ id: 'a', label: 'R1', x: 100, y: 100, w: 120, h: 48 }],
    'delogo',
    720,
    1280,
    5,
    { upscale: '4k', detailEnhance: true, nnediWeightsPath: '/app/applet/models/nnedi3_weights.bin' }
  );
  assert.equal(delogo4k.outputWidth, 2160);
  assert.equal(delogo4k.outputHeight, 3840);
  assert.equal(delogo4k.upscaled, true);
  assert.match(delogo4k.filterComplex, /deblock=filter=weak:block=4,hqdn3d=/);
  assert.match(delogo4k.filterComplex, /nnedi=weights='\/app\/applet\/models\/nnedi3_weights\.bin'/);
  assert.match(delogo4k.filterComplex, /scale=2160:3840:flags=lanczos,setsar=1,cas=strength=0\.42\[vout\]$/);

  const upscalePlain = buildFfmpegFilterGraph([], 'delogo', 1280, 720, 5, {
    upscale: '4k',
    detailEnhance: false,
    sarNormalize: true,
  });
  assert.equal(
    upscalePlain.filterComplex,
    '[0:v]scale=1280:720:flags=lanczos,setsar=1[v_sar];[v_sar]scale=3840:2160:flags=lanczos,setsar=1[vout]'
  );

  // Requires at least a region or an upscale
  assert.throws(() => buildFfmpegFilterGraph([], 'delogo', 1280, 720, 5, { upscale: 'original' }));
});
