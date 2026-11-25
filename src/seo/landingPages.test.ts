import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LANDING_PAGES,
  LAST_MODIFIED,
  buildRobotsTxt,
  buildSitemapXml,
  countLandingPageWords,
  getLandingPageByPath,
  injectLandingPageSeo,
} from './landingPages';

test('buildSitemapXml uses fixed SITE_URL, static LAST_MODIFIED, exact 3 URLs, and no changefreq/priority', () => {
  const xml = buildSitemapXml('https://clearframe.ai.studio', LAST_MODIFIED);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<loc>https://clearframe.ai.studio/</loc>'));
  assert.ok(xml.includes('<loc>https://clearframe.ai.studio/remove-video-watermark</loc>'));
  assert.ok(xml.includes('<loc>https://clearframe.ai.studio/4k-video-upscaler</loc>'));
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  assert.equal((xml.match(new RegExp(`<lastmod>${LAST_MODIFIED}</lastmod>`, 'g')) || []).length, 3);
  assert.equal(xml.includes('changefreq'), false);
  assert.equal(xml.includes('priority'), false);
});

test('buildRobotsTxt includes User-agent, Allow, and Sitemap', () => {
  const txt = buildRobotsTxt('https://clearframe.ai.studio');
  assert.equal(
    txt,
    'User-agent: *\nAllow: /\nSitemap: https://clearframe.ai.studio/sitemap.xml\n'
  );
});

test('both landing pages satisfy word count (300-500), FAQ count (4-5), unique meta, and required keywords/facts', () => {
  const pages = [LANDING_PAGES['/remove-video-watermark'], LANDING_PAGES['/4k-video-upscaler']];
  assert.notEqual(pages[0].title, pages[1].title);
  assert.notEqual(pages[0].description, pages[1].description);

  for (const page of pages) {
    const words = countLandingPageWords(page);
    assert.ok(words >= 300 && words <= 500, `${page.path} word count ${words} must be 300-500`);
    assert.ok(page.faqs.length >= 4 && page.faqs.length <= 5, `${page.path} FAQ count must be 4-5`);
    const fullText = JSON.stringify(page).toLowerCase();
    for (const token of ['mp4', 'mov', 'webm', 'mkv', '300 mb', 'no signup', 'no export watermark']) {
      assert.ok(fullText.includes(token), `${page.path} missing ${token}`);
    }
  }

  assert.ok(
    JSON.stringify(pages[0]).toLowerCase().includes('remove watermark from video free')
  );
  assert.ok(
    JSON.stringify(pages[1]).toLowerCase().includes('upscale video to 4k online free')
  );
});

test('injectLandingPageSeo injects per-route title, meta, canonical, og:image, single H1, and CTA into index.html', () => {
  const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
  const page = getLandingPageByPath('/4k-video-upscaler');
  assert.ok(page);
  const rendered = injectLandingPageSeo(indexHtml, page, 'https://clearframe.ai.studio');

  assert.ok(rendered.includes(`<title>${page.title}</title>`));
  assert.ok(rendered.includes(`<meta name="description" content="${page.description}" />`));
  assert.ok(rendered.includes('<link rel="canonical" href="https://clearframe.ai.studio/4k-video-upscaler" />'));
  assert.ok(rendered.includes('<meta property="og:url" content="https://clearframe.ai.studio/4k-video-upscaler" />'));
  assert.ok(rendered.includes('<meta property="og:image" content="https://clearframe.ai.studio/og-card.png" />'));
  assert.equal((rendered.match(/<h1\b/g) || []).length, 1);
  assert.ok(rendered.includes('href="/"'));
  assert.ok(rendered.includes(page.h1));
});
