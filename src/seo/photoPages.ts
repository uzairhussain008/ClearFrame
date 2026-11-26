export interface PhotoPageFaq {
  question: string;
  answer: string;
}

export interface PhotoPageStep {
  num: string;
  title: string;
  description: string;
}

export interface PhotoPageData {
  path: '/remove-photo-watermark' | '/photo-upscaler';
  title: string;
  description: string;
  softwareName: string;
  eyebrow: string;
  h1: string;
  intro: string;
  featureList: string[];
  steps: PhotoPageStep[];
  faqs: PhotoPageFaq[];
}

export const PHOTO_SITE_URL = 'https://clearframe.ai.studio';

export const PHOTO_PAGES: Record<'/remove-photo-watermark' | '/photo-upscaler', PhotoPageData> = {
  '/remove-photo-watermark': {
    path: '/remove-photo-watermark',
    title: 'Remove Watermark from Photo Free Online | ClearFrame',
    description:
      'Remove watermarks, logos, and text from JPG, PNG, and WebP photos free in your browser. Up to 25 MB, no upload, no signup, instant PNG download.',
    softwareName: 'ClearFrame Photo Watermark Remover',
    eyebrow: '100% Client-Side Browser Tool',
    h1: 'Free Photo Watermark Remover',
    intro:
      'Paint a brush mask or draw a rectangle over unwanted logos, date stamps, or text overlays and remove them cleanly right inside your browser. Supports JPG, PNG, and WebP photos up to 25 MB with zero server uploads, no signup, and full-resolution PNG export.',
    featureList: [
      '100% browser-based photo watermark removal with zero server uploads',
      'Supports JPG, PNG, and WebP photos up to 25 MB',
      'Adjustable brush mask and rectangle selection with undo, clear, and zoom',
      'Before/after comparison slider and full-resolution PNG download with no watermark',
    ],
    steps: [
      {
        num: '01.',
        title: 'Drop your photo',
        description: 'Choose or drag a JPG, PNG, or WebP photo up to 25 MB directly into your browser.',
      },
      {
        num: '02.',
        title: 'Paint or box the watermark',
        description:
          'Use the adjustable brush or rectangle tool with zoom and undo to mark the watermark area.',
      },
      {
        num: '03.',
        title: 'Compare & download PNG',
        description:
          'Inspect the Telea inpainted result with the before/after slider and download your clean PNG.',
      },
    ],
    faqs: [
      {
        question: 'Which photo formats are supported?',
        answer:
          'You can load JPG, PNG, and WebP images directly from your device and export the cleaned photo as a full-resolution PNG.',
      },
      {
        question: 'What is the file size limit for photos?',
        answer: 'ClearFrame supports photos up to 25 MB per image for watermark removal.',
      },
      {
        question: 'Is the Photo Watermark Remover completely free?',
        answer:
          'Yes. It is 100% free with no account, no signup, no credits, and no watermark added to your downloaded PNG.',
      },
      {
        question: 'Are photos uploaded to a server or processed in the browser?',
        answer:
          'Your photos are processed 100% locally in your browser using client-side Telea inpainting and are never uploaded to any server.',
      },
    ],
  },
  '/photo-upscaler': {
    path: '/photo-upscaler',
    title: 'Free AI Photo Upscaler (2x and 4x) Online | ClearFrame',
    description:
      'Upscale JPG, PNG, and WebP photos 2x or 4x free in your browser with AI WebGPU or Lanczos fallback. Up to 25 MB, no signup, and PNG or JPG export.',
    softwareName: 'ClearFrame AI Photo Upscaler',
    eyebrow: '100% Client-Side Browser Tool',
    h1: 'Free AI Photo Upscaler (2x and 4x)',
    intro:
      'Enhance and enlarge JPG, PNG, and WebP images by 2x or 4x right in your browser using client-side AI super-resolution with automatic Lanczos fallback when WebGPU is unavailable. Supports photos up to 25 MB with zero uploads, no signup, and crisp PNG or JPG downloads.',
    featureList: [
      '2x and 4x client-side AI photo upscaling via WebGPU/WASM with Lanczos-3 fallback',
      'Supports JPG, PNG, and WebP photos up to 25 MB with 8,000 px max dimension protection',
      '100% browser processing — photos never leave your device',
      'Before/after comparison slider and lossless PNG or JPG download with no watermark',
    ],
    steps: [
      {
        num: '01.',
        title: 'Select a photo up to 25 MB',
        description: 'Drag and drop or pick any JPG, PNG, or WebP file directly on your device.',
      },
      {
        num: '02.',
        title: 'Choose 2x or 4x upscale',
        description:
          'Pick 2x or 4x enlargement up to 8,000 px max side and run WebGPU AI or Lanczos processing.',
      },
      {
        num: '03.',
        title: 'Compare & download PNG or JPG',
        description:
          'Check sharpness with the before/after slider and save your enlarged photo as PNG or JPG.',
      },
    ],
    faqs: [
      {
        question: 'Which photo formats does the upscaler accept?',
        answer:
          'You can upscale JPG, PNG, and WebP images up to 8,000 px on the longest side and download as PNG or JPG.',
      },
      {
        question: 'What is the maximum photo file size?',
        answer: 'You can open photos up to 25 MB per file directly inside your browser.',
      },
      {
        question: 'Is the AI Photo Upscaler free without signup?',
        answer:
          'Yes. Photo upscaling at both 2x and 4x is 100% free with no signup, no credits, and no export watermark.',
      },
      {
        question: 'Are photos uploaded to a server or processed in the browser?',
        answer:
          'Photos stay completely on your device. Both AI WebGPU/WASM inference and Lanczos fallback upscaling run locally in your browser without uploading your image.',
      },
    ],
  },
};

export function getPhotoPageByPath(pathname: string): PhotoPageData | null {
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (normalized === '/remove-photo-watermark' || normalized === '/photo-upscaler') {
    return PHOTO_PAGES[normalized];
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPhotoStaticBody(page: PhotoPageData, useH1: boolean): string {
  const headingTag = useH1
    ? `<h1>${escapeHtml(page.h1)}</h1>`
    : `<p><strong>${escapeHtml(page.h1)}</strong></p>`;

  const stepsHtml = page.steps
    .map((step) => `<li><strong>${escapeHtml(step.title)}:</strong> ${escapeHtml(step.description)}</li>`)
    .join('');

  const faqsHtml = page.faqs
    .map(
      (faq) =>
        `<h3>${escapeHtml(faq.question)}</h3><p>${escapeHtml(faq.answer)}</p>`
    )
    .join('');

  return `<div class="cf-static">
  <header>
    <a href="/"><strong>ClearFrame</strong></a>
    <nav aria-label="Tool navigation">
      <a href="/">Home</a> ·
      <a href="/remove-video-watermark">Remove Video Watermark</a> ·
      <a href="/4k-video-upscaler">4K Video Upscaler</a> ·
      <a href="/remove-photo-watermark">Photo Watermark Remover</a> ·
      <a href="/photo-upscaler">Photo Upscaler</a>
    </nav>
  </header>
  <main>
    <section>
      <p>${escapeHtml(page.eyebrow)}</p>
      ${headingTag}
      <p>${escapeHtml(page.intro)}</p>
    </section>
    <section>
      <h2>How It Works</h2>
      <ol>${stepsHtml}</ol>
    </section>
    <section>
      <h2>Frequently Asked Questions</h2>
      ${faqsHtml}
    </section>
  </main>
  <footer>
    <span>ClearFrame</span>
    <nav aria-label="Footer links">
      <a href="/">Home</a> ·
      <a href="/remove-video-watermark">Video Watermark</a> ·
      <a href="/4k-video-upscaler">4K Video Upscaler</a> ·
      <a href="/remove-photo-watermark">Photo Watermark</a> ·
      <a href="/photo-upscaler">Photo Upscaler</a> ·
      <a href="/privacy.html">Privacy</a> ·
      <a href="/terms.html">Terms</a> ·
      <a href="/about.html">About &amp; Contact</a>
    </nav>
  </footer>
</div>`;
}

export function injectPhotoPageSeo(
  htmlTemplate: string,
  page: PhotoPageData,
  siteUrl: string = PHOTO_SITE_URL
): string {
  const cleanBase = siteUrl.replace(/\/$/, '');
  const canonicalUrl = `${cleanBase}${page.path}`;
  const ogImageUrl = `${cleanBase}/og-card.png`;
  const escapedTitle = escapeHtml(page.title);
  const escapedDescription = escapeHtml(page.description);
  const escapedCanonical = escapeHtml(canonicalUrl);
  const escapedImage = escapeHtml(ogImageUrl);

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${canonicalUrl}#app`,
        name: page.softwareName,
        url: canonicalUrl,
        image: ogImageUrl,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Web',
        description: page.description,
        featureList: page.featureList,
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: page.faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: faq.answer,
          },
        })),
      },
    ],
  }).replaceAll('<', '\\u003c');

  let html = htmlTemplate;
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`);
  html = html.replace(
    /<meta\s+name="description"[^>]*>/i,
    `<meta name="description" content="${escapedDescription}" />`
  );
  html = html.replace(
    /<link\s+rel="canonical"[^>]*>/i,
    `<link rel="canonical" href="${escapedCanonical}" />`
  );
  html = html.replace(
    /<meta\s+property="og:url"[^>]*>/i,
    `<meta property="og:url" content="${escapedCanonical}" />`
  );
  html = html.replace(
    /<meta\s+property="og:title"[^>]*>/i,
    `<meta property="og:title" content="${escapedTitle}" />`
  );
  html = html.replace(
    /<meta\s+property="og:description"[^>]*>/i,
    `<meta property="og:description" content="${escapedDescription}" />`
  );
  html = html.replace(
    /<meta\s+property="og:image"[^>]*>/i,
    `<meta property="og:image" content="${escapedImage}" />`
  );
  html = html.replace(
    /<meta\s+name="twitter:title"[^>]*>/i,
    `<meta name="twitter:title" content="${escapedTitle}" />`
  );
  html = html.replace(
    /<meta\s+name="twitter:description"[^>]*>/i,
    `<meta name="twitter:description" content="${escapedDescription}" />`
  );
  html = html.replace(
    /<meta\s+name="twitter:image"[^>]*>/i,
    `<meta name="twitter:image" content="${escapedImage}" />`
  );
  html = html.replace(
    /<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/i,
    `<script type="application/ld+json">${jsonLd}</script>`
  );

  const staticReplacement = `<div id="root">${renderPhotoStaticBody(page, true)}</div>\n    <noscript>${renderPhotoStaticBody(page, false)}</noscript>`;
  if (/<div\s+id="root">[\s\S]*?<\/noscript>\s*(?=<script\s+type="module")/i.test(html)) {
    html = html.replace(
      /<div\s+id="root">[\s\S]*?<\/noscript>\s*(?=<script\s+type="module")/i,
      `${staticReplacement}\n    `
    );
  } else {
    html = html.replace(/<div\s+id="root">[\s\S]*?<\/div>/i, staticReplacement);
  }

  return html;
}
