import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComfyUpscaleWorkflow,
  extractGpuStats,
  isPublicIpAddress,
  parseComfyOutputFromHistory,
  validateComfyUrlFormat,
} from './comfyUrlGuard';

test('validateComfyUrlFormat accepts valid HTTPS tunnel URLs and normalizes origin', () => {
  const valid = validateComfyUrlFormat('  https://bright-fox-demo.trycloudflare.com/  ');
  assert.deepEqual(valid, {
    valid: true,
    origin: 'https://bright-fox-demo.trycloudflare.com',
    hostname: 'bright-fox-demo.trycloudflare.com',
  });
});

test('validateComfyUrlFormat rejects non-HTTPS, IP literals, internal hosts, creds, custom ports, and paths', () => {
  assert.equal(validateComfyUrlFormat('http://demo.trycloudflare.com').valid, false);
  assert.equal(validateComfyUrlFormat('https://localhost').valid, false);
  assert.equal(validateComfyUrlFormat('https://service.internal').valid, false);
  assert.equal(validateComfyUrlFormat('https://127.0.0.1').valid, false);
  assert.equal(validateComfyUrlFormat('https://169.254.169.254').valid, false);
  assert.equal(validateComfyUrlFormat('https://[::1]').valid, false);
  assert.equal(validateComfyUrlFormat('https://user:pass@demo.trycloudflare.com').valid, false);
  assert.equal(validateComfyUrlFormat('https://demo.trycloudflare.com:8188').valid, false);
  assert.equal(validateComfyUrlFormat('https://demo.trycloudflare.com/prompt').valid, false);
});

test('isPublicIpAddress blocks private, loopback, link-local/metadata, CGNAT, and mapped private IPs', () => {
  assert.equal(isPublicIpAddress('127.0.0.1'), false);
  assert.equal(isPublicIpAddress('10.20.0.5'), false);
  assert.equal(isPublicIpAddress('172.16.5.1'), false);
  assert.equal(isPublicIpAddress('192.168.1.50'), false);
  assert.equal(isPublicIpAddress('169.254.169.254'), false);
  assert.equal(isPublicIpAddress('100.64.0.1'), false);
  assert.equal(isPublicIpAddress('::1'), false);
  assert.equal(isPublicIpAddress('fe80::1'), false);
  assert.equal(isPublicIpAddress('fd12:3456::1'), false);
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicIpAddress('::ffff:169.254.169.254'), false);

  assert.equal(isPublicIpAddress('104.16.132.229'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('extractGpuStats detects NVIDIA CUDA GPU and rejects CPU-only responses', () => {
  const withT4 = extractGpuStats({
    system: { comfyui_version: '0.3.18' },
    devices: [
      { name: 'cuda:0 Tesla T4 : cudaMallocAsync', type: 'cuda', vram_total: 15835660288 },
    ],
  });
  assert.equal(withT4.hasGpu, true);
  assert.match(withT4.gpuName ?? '', /Tesla T4/);
  assert.equal(withT4.vramGb, 14.7);
  assert.equal(withT4.comfyVersion, '0.3.18');

  const cpuOnly = extractGpuStats({
    system: { comfyui_version: '0.3.18' },
    devices: [{ name: 'cpu', type: 'cpu', vram_total: 0 }],
  });
  assert.equal(cpuOnly.hasGpu, false);
});

test('buildComfyUpscaleWorkflow builds exact aspect-safe VHS + RealESRGAN workflow', () => {
  const wf = buildComfyUpscaleWorkflow({
    inputFilename: 'clip.mp4',
    modelName: 'RealESRGAN_x2plus.pth',
    targetWidth: 2160,
    targetHeight: 3840,
    frameRate: 30,
    filenamePrefix: 'cf_out_123',
    framesPerBatch: 16,
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

  assert.equal(wf['1'].class_type, 'VHS_BatchManager');
  assert.equal(wf['2'].inputs.model_name, 'RealESRGAN_x2plus.pth');
  assert.equal(wf['3'].class_type, 'VHS_LoadVideo');
  assert.equal(wf['3'].inputs.video, 'clip.mp4');
  assert.equal(wf['4'].class_type, 'ImageUpscaleWithModel');
  assert.equal(wf['5'].class_type, 'ImageScale');
  assert.equal(wf['5'].inputs.width, 2160);
  assert.equal(wf['5'].inputs.height, 3840);
  assert.equal(wf['6'].class_type, 'VHS_VideoCombine');
  assert.equal(wf['6'].inputs.format, 'video/h264-mp4');
  assert.equal(wf['6'].inputs.frame_rate, 30);
});

test('parseComfyOutputFromHistory skips unfinished batches and extracts final output mp4', () => {
  const unfinished = {
    outputs: {
      '6': { unfinished_batch: [true] },
    },
  };
  assert.equal(parseComfyOutputFromHistory(unfinished, 'cf_out_123'), null);

  const finished = {
    outputs: {
      '6': {
        gifs: [
          {
            filename: 'cf_out_123_00001.mp4',
            subfolder: '',
            type: 'output',
          },
        ],
      },
    },
  };
  assert.deepEqual(parseComfyOutputFromHistory(finished, 'cf_out_123'), {
    filename: 'cf_out_123_00001.mp4',
    subfolder: '',
    type: 'output',
  });
});
