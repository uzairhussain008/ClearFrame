import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_PHOTO_SIZE_BYTES,
  applyMatchedSurroundingGrain,
  computeFeatheredMaskAlpha,
  dilateBinaryMask,
  inpaintPhotoPatchBased,
  teleaInpaintRgba,
  validatePhotoFile,
} from './photoInpaint';
import {
  MAX_PHOTO_OUTPUT_DIM,
  checkPhotoUpscaleDimensions,
  lanczosUpscaleRgba,
} from './photoUpscaler';
import {
  PHOTO_PAGES,
  getPhotoPageByPath,
  injectPhotoPageSeo,
} from '../seo/photoPages';
import {
  LAMA_MODEL_SIZE_BYTES,
  LAMA_MODEL_URL,
  validateLamaModelBytes,
} from './lamaInpaint';

test('validatePhotoFile accepts JPG/PNG/WebP up to 25 MB and rejects oversized or invalid types', () => {
  assert.equal(validatePhotoFile({ name: 'pic.jpg', size: 1024, type: 'image/jpeg' }).valid, true);
  assert.equal(validatePhotoFile({ name: 'pic.png', size: MAX_PHOTO_SIZE_BYTES, type: 'image/png' }).valid, true);
  assert.equal(validatePhotoFile({ name: 'pic.webp', size: 5000, type: 'image/webp' }).valid, true);
  assert.equal(validatePhotoFile({ name: 'big.png', size: MAX_PHOTO_SIZE_BYTES + 1, type: 'image/png' }).valid, false);
  assert.equal(validatePhotoFile({ name: 'anim.gif', size: 1000, type: 'image/gif' }).valid, false);
  assert.equal(validatePhotoFile({ name: 'empty.png', size: 0, type: 'image/png' }).valid, false);
});

test('teleaInpaintRgba fills masked watermark pixels cleanly while leaving unmasked pixels untouched', () => {
  const w = 16;
  const h = 16;
  const src = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);

  // Solid teal background (30, 140, 180) with a bright white watermark patch in center (6..9, 6..9)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const off = idx * 4;
      const inBox = x >= 6 && x <= 9 && y >= 6 && y <= 9;
      src[off] = inBox ? 255 : 30;
      src[off + 1] = inBox ? 255 : 140;
      src[off + 2] = inBox ? 255 : 180;
      src[off + 3] = 255;
      if (inBox) mask[idx] = 1;
    }
  }

  const dilated = dilateBinaryMask(mask, w, h, 1);
  assert.ok(dilated[5 * w + 6] === 1);

  const out = teleaInpaintRgba(src, mask, w, h, 4);
  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    if (mask[i] === 0) {
      assert.equal(out[off], src[off]);
      assert.equal(out[off + 1], src[off + 1]);
      assert.equal(out[off + 2], src[off + 2]);
    } else {
      assert.ok(Math.abs(out[off] - 30) <= 5, `R=${out[off]} should match surrounding 30`);
      assert.ok(Math.abs(out[off + 1] - 140) <= 5, `G=${out[off + 1]} should match surrounding 140`);
      assert.ok(Math.abs(out[off + 2] - 180) <= 5, `B=${out[off + 2]} should match surrounding 180`);
    }
  }
});

test('inpaintPhotoPatchBased copies real texture patches, preserves outside pixels exactly, and uses Telea fallback for tiny masks', () => {
  const w = 96;
  const h = 96;
  const src = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);

  // Textured fabric/weave pattern (periodic 4px stripes + variation) with white watermark box (38..56, 38..56)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const off = idx * 4;
      const stripe = ((x >> 2) + (y >> 2)) % 2 === 0 ? 155 : 75;
      const inBox = x >= 38 && x <= 56 && y >= 38 && y <= 56;
      src[off] = inBox ? 255 : stripe;
      src[off + 1] = inBox ? 255 : Math.min(255, stripe + 15);
      src[off + 2] = inBox ? 255 : Math.max(0, stripe - 20);
      src[off + 3] = 255;
      if (inBox) mask[idx] = 1;
    }
  }

  const dilatePx = 2;
  const dilated = dilateBinaryMask(mask, w, h, dilatePx);
  const progressEvents: number[] = [];
  const res = inpaintPhotoPatchBased({
    srcRgba: src,
    mask,
    width: w,
    height: h,
    dilatePx,
    featherPx: 4,
    addGrain: true,
    onProgress: (pct) => progressEvents.push(pct),
  });

  assert.equal(res.engineUsed, 'patchmatch');
  assert.ok(progressEvents.length >= 3);
  assert.equal(progressEvents[progressEvents.length - 1], 100);

  // Every pixel outside the dilated mask must stay bit-for-bit identical
  for (let i = 0; i < w * h; i++) {
    if (dilated[i] === 0) {
      const off = i * 4;
      assert.equal(res.rgba[off], src[off]);
      assert.equal(res.rgba[off + 1], src[off + 1]);
      assert.equal(res.rgba[off + 2], src[off + 2]);
      assert.equal(res.rgba[off + 3], src[off + 3]);
    }
  }

  // Interior must recover contrast/texture rather than collapsing to flat white (255)
  let minR = 255;
  let maxR = 0;
  for (let y = 41; y <= 53; y++) {
    for (let x = 41; x <= 53; x++) {
      const r = res.rgba[(y * w + x) * 4];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      assert.ok(r < 220, `Interior pixel (${x},${y}) R=${r} should not remain white watermark`);
    }
  }
  assert.ok(maxR - minR >= 25, `PatchMatch should preserve texture variation (range=${maxR - minR})`);

  // Tiny mask (< 28 px) uses fast Telea fallback
  const tinyMask = new Uint8Array(w * h);
  for (let y = 46; y <= 48; y++) {
    for (let x = 46; x <= 48; x++) {
      tinyMask[y * w + x] = 1;
    }
  }
  const tinyRes = inpaintPhotoPatchBased({
    srcRgba: src,
    mask: tinyMask,
    width: w,
    height: h,
    dilatePx: 0,
    featherPx: 3,
    addGrain: false,
  });
  assert.equal(tinyRes.engineUsed, 'telea-fallback');
});

test('computeFeatheredMaskAlpha and applyMatchedSurroundingGrain preserve outside pixels and match grain', () => {
  const w = 48;
  const h = 48;
  const mask = new Uint8Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const off = idx * 4;
      const inMask = x >= 16 && x <= 31 && y >= 16 && y <= 31;
      if (inMask) mask[idx] = 1;
      // Surrounding area has perceptible +/- 12 grain; masked center is perfectly flat 128
      const grain = inMask ? 0 : (((x * 17 + y * 31) % 25) - 12);
      const val = Math.max(0, Math.min(255, 128 + grain));
      rgba[off] = val;
      rgba[off + 1] = val;
      rgba[off + 2] = val;
      rgba[off + 3] = 255;
    }
  }

  const alpha = computeFeatheredMaskAlpha(mask, w, h, 4);
  assert.equal(alpha[0], 0);
  assert.ok(alpha[16 * w + 16] > 0 && alpha[16 * w + 16] < 1, 'boundary pixel should be feathered');
  assert.equal(alpha[23 * w + 23], 1, 'deep interior pixel should be opaque 1');

  const grained = applyMatchedSurroundingGrain(rgba, mask, w, h);
  let centerSpread = 0;
  for (let y = 18; y <= 29; y++) {
    for (let x = 18; x <= 29; x++) {
      centerSpread += Math.abs(grained[(y * w + x) * 4] - 128);
    }
  }
  assert.ok(centerSpread > 50, 'Grain should be injected into smooth filled region');
  // Unmasked pixel untouched
  assert.equal(grained[0], rgba[0]);
});

test('checkPhotoUpscaleDimensions enforces 8000px max side limit cleanly', () => {
  const ok2x = checkPhotoUpscaleDimensions(3000, 2000, 2);
  assert.equal(ok2x.allowed, true);
  assert.equal(ok2x.outputWidth, 6000);
  assert.equal(ok2x.outputHeight, 4000);

  const okMax = checkPhotoUpscaleDimensions(2000, 1500, 4);
  assert.equal(okMax.allowed, true);
  assert.equal(okMax.outputWidth, MAX_PHOTO_OUTPUT_DIM);

  const tooBig = checkPhotoUpscaleDimensions(2500, 1500, 4);
  assert.equal(tooBig.allowed, false);
  assert.ok(tooBig.reason?.includes('8,000 px'));
});

test('lanczosUpscaleRgba scales 2x and 4x cleanly', () => {
  const src = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < src.length; i += 4) {
    src[i] = 48;
    src[i + 1] = 160;
    src[i + 2] = 220;
    src[i + 3] = 255;
  }
  const out2x = lanczosUpscaleRgba(src, 4, 4, 8, 8);
  assert.equal(out2x.length, 8 * 8 * 4);
  assert.ok(Math.abs(out2x[0] - 48) <= 2);
  assert.ok(Math.abs(out2x[1] - 160) <= 2);
  assert.ok(Math.abs(out2x[2] - 220) <= 2);

  const out4x = lanczosUpscaleRgba(src, 4, 4, 16, 16);
  assert.equal(out4x.length, 16 * 16 * 4);
});

test('photoPages SEO helpers produce unique raw HTML meta, single H1, 4 exact FAQs, SoftwareApplication JSON-LD without ratings, and internal links', () => {
  const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
  const pages = [PHOTO_PAGES['/remove-photo-watermark'], PHOTO_PAGES['/photo-upscaler']];
  assert.notEqual(pages[0].title, pages[1].title);
  assert.notEqual(pages[0].description, pages[1].description);

  for (const page of pages) {
    assert.ok(getPhotoPageByPath(page.path));
    assert.equal(page.faqs.length, 4);
    const rendered = injectPhotoPageSeo(indexHtml, page);
    assert.ok(rendered.includes(`<title>${page.title}</title>`));
    assert.ok(rendered.includes(`<meta name="description" content="${page.description}" />`));
    assert.ok(rendered.includes(`<link rel="canonical" href="https://clearframe.ai.studio${page.path}" />`));
    assert.ok(rendered.includes('<meta property="og:image" content="https://clearframe.ai.studio/og-card.png" />'));
    assert.equal((rendered.match(/<h1>/g) || []).length, 1);
    assert.ok(rendered.includes(`<h1>${page.h1}</h1>`));
    assert.ok(rendered.includes('<noscript>'));
    assert.ok(rendered.includes('"@type":"SoftwareApplication"'));
    assert.ok(rendered.includes('"@type":"FAQPage"'));
    assert.equal(rendered.toLowerCase().includes('aggregaterating'), false);
    for (const faq of page.faqs) {
      assert.ok(rendered.includes(faq.question));
      assert.ok(rendered.includes(faq.answer));
    }
    for (const href of [
      'href="/"',
      'href="/remove-video-watermark"',
      'href="/4k-video-upscaler"',
      'href="/remove-photo-watermark"',
      'href="/photo-upscaler"',
    ]) {
      assert.ok(rendered.includes(href), `${page.path} missing ${href}`);
    }
  }
});

test('LAMA_MODEL_URL config and validateLamaModelBytes enforce expected file size and ONNX ModelProto format', () => {
  assert.equal(
    LAMA_MODEL_URL,
    'https://huggingface.co/othytenk/lama-int4-int8/resolve/main/lama_int4_int8_r4.onnx'
  );

  // Reject wrong sizes immediately
  assert.equal(validateLamaModelBytes(new Uint8Array(0)).valid, false);
  assert.equal(validateLamaModelBytes(new Uint8Array(1024)).valid, false);
  assert.equal(validateLamaModelBytes(new Uint8Array(LAMA_MODEL_SIZE_BYTES + 2_000_000)).valid, false);

  // Valid size with HTML/JSON/corrupt bytes must be rejected
  const htmlBytes = new Uint8Array(LAMA_MODEL_SIZE_BYTES);
  htmlBytes.set(Buffer.from('<!doctype html><html>error</html>'));
  assert.equal(validateLamaModelBytes(htmlBytes).valid, false);

  const randomBadBytes = new Uint8Array(LAMA_MODEL_SIZE_BYTES);
  randomBadBytes.fill(0xff);
  assert.equal(validateLamaModelBytes(randomBadBytes).valid, false);

  // Valid size with ONNX ModelProto protobuf header (ir_version=8, producer="pytorch")
  const validOnnxBytes = new Uint8Array(LAMA_MODEL_SIZE_BYTES);
  const header = [0x08, 0x08, 0x12, 0x07, 0x70, 0x79, 0x74, 0x6f, 0x72, 0x63, 0x68];
  validOnnxBytes.set(header, 0);
  assert.equal(validateLamaModelBytes(validOnnxBytes, 'application/octet-stream').valid, true);
  assert.equal(validateLamaModelBytes(validOnnxBytes, 'text/html').valid, false);
});

test('photo watermark static HTML includes permission notice in #root and noscript without altering FAQs', () => {
  const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
  const rendered = injectPhotoPageSeo(indexHtml, PHOTO_PAGES['/remove-photo-watermark']);
  const matches = rendered.match(
    /Use this tool only on photos you own or have <a href="\/terms\.html">permission<\/a> to edit\./g
  );
  assert.equal(matches?.length, 2, 'Expected notice once in #root and once in noscript');

  const upscalerRendered = injectPhotoPageSeo(indexHtml, PHOTO_PAGES['/photo-upscaler']);
  assert.equal(upscalerRendered.includes('Use this tool only on photos'), false);
});
