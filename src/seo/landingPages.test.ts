import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LANDING_PAGES,
  LAST_MODIFIED,
  SITE_URL,
  buildRobotsTxt,
  buildSitemapXml,
  countLandingPageWords,
  getLandingPageByPath,
  injectLandingPageSeo,
} from './landingPages';

test('SITE_URL is hardcoded to https://clearframe.ai.studio and ignores process.env.APP_URL', () => {
  const prevAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://clearframe-751876293904.asia-south1.run.app';
  try {
    assert.equal(SITE_URL, 'https://clearframe.ai.studio');
    const xml = buildSitemapXml();
    const robots = buildRobotsTxt();
    assert.equal(xml.includes('run.app'), false);
    assert.equal(robots.includes('run.app'), false);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<loc>https://clearframe.ai.studio/</loc>'));
    assert.ok(xml.includes('<loc>https://clearframe.ai.studio/remove-video-watermark</loc>'));
    assert.ok(xml.includes('<loc>https://clearframe.ai.studio/4k-video-upscaler</loc>'));
    assert.equal((xml.match(/<url>/g) || []).length, 3);
    assert.equal((xml.match(new RegExp(`<lastmod>${LAST_MODIFIED}</lastmod>`, 'g')) || []).length, 3);
    assert.equal(xml.includes('changefreq'), false);
    assert.equal(xml.includes('priority'), false);
    assert.equal(
      robots,
      'User-agent: *\nAllow: /\nSitemap: https://clearframe.ai.studio/sitemap.xml\n'
    );
  } finally {
    if (prevAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = prevAppUrl;
    }
  }
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

test('injectLandingPageSeo injects hardcoded https://clearframe.ai.studio URLs and ignores APP_URL', () => {
  const prevAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://clearframe-751876293904.asia-south1.run.app';
  try {
    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
    for (const routePath of ['/remove-video-watermark', '/4k-video-upscaler'] as const) {
      const page = getLandingPageByPath(routePath);
      assert.ok(page);
      const rendered = injectLandingPageSeo(indexHtml, page);

      assert.equal(rendered.includes('run.app'), false);
      assert.ok(rendered.includes(`<title>${page.title}</title>`));
      assert.ok(rendered.includes(`<meta name="description" content="${page.description}" />`));
      assert.ok(rendered.includes(`<link rel="canonical" href="https://clearframe.ai.studio${routePath}" />`));
      assert.ok(rendered.includes(`<meta property="og:url" content="https://clearframe.ai.studio${routePath}" />`));
      assert.ok(rendered.includes('<meta property="og:image" content="https://clearframe.ai.studio/og-card.png" />'));
      assert.equal((rendered.match(/<h1\b/g) || []).length, 1);
      assert.ok(rendered.includes('href="/"'));
      assert.ok(rendered.includes(page.h1));
    }
  } finally {
    if (prevAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = prevAppUrl;
    }
  }
});
