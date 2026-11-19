import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blendFixedUpscaledTileIntoAccum,
  checkAiVideoLimits,
  computeFrameSchedule,
  computeTileGrid,
  detectTensorLayoutFromShape,
  extractFixedRgbaTileToTensor,
  finalizeAccumToRgba,
} from './webgpuUpscaler';

test('checkAiVideoLimits enforces max duration, 720p source, and size limits', () => {
  assert.deepEqual(
    checkAiVideoLimits({ width: 1280, height: 720, duration: 25, size: 40 * 1024 * 1024 }),
    { allowed: true }
  );
  assert.deepEqual(
    checkAiVideoLimits({ width: 720, height: 1280, duration: 30, size: 100 * 1024 * 1024 }),
    { allowed: true }
  );

  const tooLong = checkAiVideoLimits({ width: 720, height: 1280, duration: 31, size: 10 * 1024 * 1024 });
  assert.equal(tooLong.allowed, false);
  assert.match(tooLong.reason ?? '', /30s/);

  const tooHiRes = checkAiVideoLimits({ width: 1920, height: 1080, duration: 10, size: 10 * 1024 * 1024 });
  assert.equal(tooHiRes.allowed, false);
  assert.match(tooHiRes.reason ?? '', /720p/);

  const tooBig = checkAiVideoLimits({ width: 720, height: 1280, duration: 10, size: 101 * 1024 * 1024 });
  assert.equal(tooBig.allowed, false);
  assert.match(tooBig.reason ?? '', /100 MB/);
});

test('computeFrameSchedule handles fractional fps (29.97, 59.94, 59.74) and VFR PTS accurately', () => {
  for (const fps of [29.97, 59.94, 59.74]) {
    const sched = computeFrameSchedule(2.0, fps);
    assert.equal(sched.length, Math.round(2.0 * fps));
    assert.equal(sched[0].timestampUs, 0);
    const last = sched[sched.length - 1];
    const totalSec = (last.timestampUs + last.durationUs) / 1_000_000;
    assert.ok(Math.abs(totalSec - 2.0) < 0.05, `total duration mismatch for ${fps}: ${totalSec}`);
  }

  // Variable frame rate (VFR) phone video timestamps
  const vfrPts = [0.1, 0.133, 0.183, 0.2, 0.25];
  const vfrSched = computeFrameSchedule(0.2, 42.5, vfrPts);
  assert.equal(vfrSched.length, 5);
  assert.equal(vfrSched[0].timestampUs, 0);
  assert.equal(vfrSched[1].timestampUs, 33000);
  assert.equal(vfrSched[2].timestampUs, 83000);
  assert.equal(vfrSched[1].durationUs, 50000);
});

test('detectTensorLayoutFromShape inspects NCHW vs NHWC from metadata', () => {
  assert.equal(detectTensorLayoutFromShape(['batch_size', 3, 'height', 'width']), 'NCHW');
  assert.equal(detectTensorLayoutFromShape([1, 192, 192, 3]), 'NHWC');
});

test('computeTileGrid covers entire frame with overlapping tiles without out-of-bounds', () => {
  const tiles = computeTileGrid(720, 1280, 192, 16);
  assert.ok(tiles.length > 1);
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.y >= 0);
    assert.ok(t.x + t.w <= 720);
    assert.ok(t.y + t.h <= 1280);
  }
  const maxX = Math.max(...tiles.map((t) => t.x + t.w));
  const maxY = Math.max(...tiles.map((t) => t.y + t.h));
  assert.equal(maxX, 720);
  assert.equal(maxY, 1280);
});

test('fixed-size padded tiles with crop and blend preserve exact uniform colors in NCHW and NHWC', () => {
  const inW = 64;
  const inH = 48;
  const fixedTile = 40; // smaller/padded edge tiles tested too
  const overlap = 8;
  const scale = 2;

  const rgba = new Uint8ClampedArray(inW * inH * 4);
  for (let i = 0; i < inW * inH; i++) {
    rgba[i * 4] = 120;
    rgba[i * 4 + 1] = 200;
    rgba[i * 4 + 2] = 40;
    rgba[i * 4 + 3] = 255;
  }

  for (const layout of ['NCHW', 'NHWC'] as const) {
    const tiles = computeTileGrid(inW, inH, fixedTile, overlap);
    const outW = inW * scale;
    const outH = inH * scale;
    const accumRgb = new Float32Array(outW * outH * 3);
    const accumWeight = new Float32Array(outW * outH);
    const fixedOutSize = fixedTile * scale;
    const fixedPlane = fixedOutSize * fixedOutSize;

    for (const tile of tiles) {
      const inBuf = extractFixedRgbaTileToTensor(
        rgba,
        inW,
        tile.x,
        tile.y,
        tile.w,
        tile.h,
        fixedTile,
        layout
      );
      assert.equal(inBuf.length, 3 * fixedTile * fixedTile);

      const outBuf = new Float32Array(3 * fixedPlane);
      if (layout === 'NCHW') {
        outBuf.fill(120 / 255, 0, fixedPlane);
        outBuf.fill(200 / 255, fixedPlane, fixedPlane * 2);
        outBuf.fill(40 / 255, fixedPlane * 2, fixedPlane * 3);
      } else {
        for (let p = 0; p < fixedPlane; p++) {
          outBuf[p * 3] = 120 / 255;
          outBuf[p * 3 + 1] = 200 / 255;
          outBuf[p * 3 + 2] = 40 / 255;
        }
      }

      blendFixedUpscaledTileIntoAccum(
        outBuf,
        tile.x,
        tile.y,
        tile.w,
        tile.h,
        inW,
        inH,
        fixedTile,
        scale,
        overlap,
        layout,
        accumRgb,
        accumWeight
      );
    }

    const finalRgba = new Uint8ClampedArray(outW * outH * 4);
    finalizeAccumToRgba(accumRgb, accumWeight, finalRgba);

    for (let i = 0; i < outW * outH; i++) {
      assert.equal(finalRgba[i * 4], 120);
      assert.equal(finalRgba[i * 4 + 1], 200);
      assert.equal(finalRgba[i * 4 + 2], 40);
      assert.equal(finalRgba[i * 4 + 3], 255);
    }
  }
});
