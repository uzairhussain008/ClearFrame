export interface LandingPageFaq {
  question: string;
  answer: string;
}

export interface LandingPageSection {
  heading: string;
  paragraphs: string[];
}

export interface LandingPageData {
  path: '/remove-video-watermark' | '/4k-video-upscaler';
  title: string;
  description: string;
  navLabel: string;
  eyebrow: string;
  h1: string;
  lead: string;
  ctaLabel: string;
  sections: LandingPageSection[];
  faqs: LandingPageFaq[];
}

export const SITE_URL = 'https://clearframe.ai.studio';
export const LAST_MODIFIED = '2026-11-25';

export const LANDING_PAGES: Record<'/remove-video-watermark' | '/4k-video-upscaler', LandingPageData> = {
  '/remove-video-watermark': {
    path: '/remove-video-watermark',
    title: 'Remove Watermark from Video Free Online | ClearFrame',
    description:
      'Remove watermark from video free online up to 300 MB. Cleanly erase logos and text from MP4, MOV, WebM, and MKV files with no signup and no export watermark.',
    navLabel: 'Remove Watermark',
    eyebrow: 'Free Online Video Watermark Remover',
    h1: 'Remove Watermark from Video Free Without Quality Loss',
    lead: 'Erase unwanted logos, timestamps, subtitles, and corner watermarks from clips up to 300 MB in seconds with no signup and no export watermark.',
    ctaLabel: 'Open Watermark Remover',
    sections: [
      {
        heading: 'How it works',
        paragraphs: [
          'ClearFrame makes it straightforward to remove watermark from video free directly in your browser. Open the workspace, upload any MP4, MOV, WebM, or MKV file up to 300 MB, and enable watermark removal. Draw one or more selection boxes around the logo or overlay, pick Smart Inpaint, Soft Blur, or Mosaic, and set optional start and end timestamps when a mark only appears briefly. Once processing finishes, verify results using the side-by-side comparison slider and download a clean MP4 with original audio intact.',
        ],
      },
      {
        heading: 'Why use ClearFrame',
        paragraphs: [
          'Many online editors cap free uploads at tiny file sizes, require an account, or stamp their own badge over finished exports. ClearFrame removes those barriers completely: there is no signup, no credit counter, and no export watermark added to your video. Every file is processed with high-profile H.264 encoding so edges around removed overlays blend naturally without blurring the rest of the frame, and temporary uploads automatically expire after 15 minutes.',
        ],
      },
    ],
    faqs: [
      {
        question: 'Can I remove a watermark from video free without creating an account?',
        answer:
          'Yes. ClearFrame requires no signup, no subscription, and adds no export watermark to your downloaded MP4.',
      },
      {
        question: 'What video formats and file sizes are supported?',
        answer:
          'You can upload MP4, MOV, WebM, and MKV videos up to 300 MB per file directly from your device.',
      },
      {
        question: 'Which watermark removal mode gives the cleanest result?',
        answer:
          'Smart Inpaint works best for corner logos and static text because it reconstructs pixels from surrounding textures, while Soft Blur and Mosaic suit fast-moving backgrounds.',
      },
      {
        question: 'Can I remove a logo that appears only during part of the clip?',
        answer:
          'Yes. Each selection box supports start and end timestamps in seconds so removal runs only when the watermark is visible.',
      },
      {
        question: 'Does ClearFrame keep my original audio track?',
        answer:
          'Yes. Your source audio stream is preserved and synced in the final exported MP4 file.',
      },
    ],
  },
  '/4k-video-upscaler': {
    path: '/4k-video-upscaler',
    title: 'Upscale Video to 4K Online Free | ClearFrame',
    description:
      'Upscale video to 4K online free up to 300 MB. Enhance video resolution to 1080p, 2K, or 4K UHD across MP4, MOV, WebM, and MKV with no signup or watermark.',
    navLabel: '4K Upscaler',
    eyebrow: 'Free Online 4K Video Upscaler',
    h1: 'Upscale Video to 4K Online Free with Sharp Detail',
    lead: 'Transform low-resolution clips into crisp 1080p Full HD, 2K QHD, or 4K UHD MP4 videos up to 300 MB with no signup and no export watermark.',
    ctaLabel: 'Open 4K Video Upscaler',
    sections: [
      {
        heading: 'How it works',
        paragraphs: [
          'ClearFrame lets you upscale video to 4K online free in three fast steps. Open the workspace, upload an MP4, MOV, WebM, or MKV clip up to 300 MB, and choose your target resolution: 1080p, 2K, or 4K UHD. Select either the built-in CPU pipeline using edge-directed NNEDI3 reconstruction, Lanczos resampling, and balanced sharpening, or WebGPU AI upscaling on supported browsers. Inspect the upgraded clarity with the interactive split slider before saving your MP4.',
        ],
      },
      {
        heading: 'Why use ClearFrame',
        paragraphs: [
          'Traditional resizers stretch pixels blindly, leaving compressed mobile clips blocky or overly soft. ClearFrame reduces compression artifacts first, preserves your original aspect ratio, and encodes at high-profile H.264 settings while keeping the source audio track intact. Better yet, you get full 300 MB uploads with no signup, no paid credits, and no export watermark stamped onto your finished footage.',
        ],
      },
    ],
    faqs: [
      {
        question: 'Is it really free to upscale video to 4K online?',
        answer:
          'Yes. ClearFrame lets you upscale clips up to 300 MB to 1080p, 2K, or 4K UHD with no signup and no export watermark.',
      },
      {
        question: 'What video formats can I upload for 4K upscaling?',
        answer:
          'ClearFrame supports MP4, MOV, WebM, and MKV videos up to 300 MB, and outputs a compatible H.264 MP4.',
      },
      {
        question: 'Will upscaling distort portrait or square videos?',
        answer:
          'No. Resolution presets scale along the appropriate dimension so vertical, square, and widescreen aspect ratios remain accurate.',
      },
      {
        question: 'Should I choose Built-in CPU or AI Upscaler mode?',
        answer:
          'Built-in CPU mode works reliably on every device up to 300 MB, while AI Upscaler uses browser WebGPU acceleration on supported hardware for shorter clips.',
      },
      {
        question: 'What happens if my uploaded video is already 4K?',
        answer:
          'ClearFrame never downscales footage that already meets or exceeds your chosen target resolution.',
      },
    ],
  },
};

export function getLandingPageByPath(pathname: string): LandingPageData | null {
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (normalized === '/remove-video-watermark' || normalized === '/4k-video-upscaler') {
    return LANDING_PAGES[normalized];
  }
  return null;
}

export function buildSitemapXml(siteUrl: string = SITE_URL, lastMod: string = LAST_MODIFIED): string {
  const cleanBase = siteUrl.replace(/\/$/, '');
  const paths = ['/', '/remove-video-watermark', '/4k-video-upscaler'];
  const urlsXml = paths
    .map(
      (routePath) =>
        `  <url>\n    <loc>${cleanBase}${routePath}</loc>\n    <lastmod>${lastMod}</lastmod>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlsXml}\n</urlset>\n`;
}

export function buildRobotsTxt(siteUrl: string = SITE_URL): string {
  const cleanBase = siteUrl.replace(/\/$/, '');
  return ['User-agent: *', 'Allow: /', `Sitemap: ${cleanBase}/sitemap.xml`].join('\n') + '\n';
}

export function countLandingPageWords(page: LandingPageData): number {
  const chunks = [
    page.h1,
    page.lead,
    ...page.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    'Frequently asked questions',
    ...page.faqs.flatMap((faq) => [faq.question, faq.answer]),
  ];
  return chunks
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderLandingPageHtml(page: LandingPageData, useH1: boolean = true): string {
  const sectionsHtml = page.sections
    .map(
      (section) => `
        <section class="rounded-xl border border-slate-800 bg-[#111A2E] p-6 sm:p-8">
          <h2 class="font-display text-2xl font-bold tracking-tight text-slate-50">${escapeHtml(section.heading)}</h2>
          <div class="mt-4 space-y-4 text-base leading-relaxed text-slate-300">
            ${section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
          </div>
        </section>`
    )
    .join('');

  const faqsHtml = page.faqs
    .map(
      (faq, idx) => `
        <details${idx === 0 ? ' open' : ''} class="group">
          <summary class="flex w-full min-h-[52px] list-none items-center justify-between gap-4 px-6 py-4 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/40 cursor-pointer">
            <span>${escapeHtml(faq.question)}</span>
          </summary>
          <div class="px-6 pb-5 text-sm leading-relaxed text-slate-300">${escapeHtml(faq.answer)}</div>
        </details>`
    )
    .join('');

  const usageNoticeHtml =
    page.path === '/remove-video-watermark'
      ? `\n      <p class="mx-auto mt-3 max-w-2xl text-xs text-slate-400">Use this tool only on videos you own or have <a href="/terms.html" class="text-slate-300 underline underline-offset-2 hover:text-sky-400">permission</a> to edit.</p>`
      : '';

  const headingTag = useH1
    ? `<h1 class="mt-3 font-display font-bold tracking-tight text-slate-50 text-center" style="font-size: clamp(2.2rem, 4.2vw, 3.25rem); line-height: 1.1;">${escapeHtml(page.h1)}</h1>`
    : `<p class="mt-3 font-display font-bold tracking-tight text-slate-50 text-center"><strong>${escapeHtml(page.h1)}</strong></p>`;

  return `<div class="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
  <header class="border-b border-slate-800/80 bg-[#0B1120]">
    <div class="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-4 py-4 sm:px-6">
      <a href="/" aria-label="ClearFrame Home" class="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
        <span class="font-display text-lg font-bold tracking-tight text-slate-50">ClearFrame</span>
      </a>
      <nav aria-label="Primary navigation" class="hidden xl:flex items-center gap-7 text-sm font-medium text-slate-300">
        <a href="/" class="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0">Workspace</a>
        <a href="/remove-video-watermark" class="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0">Remove Watermark</a>
        <a href="/4k-video-upscaler" class="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0">4K Upscaler</a>
      </nav>
      <div class="shrink-0">
        <a href="/" class="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 whitespace-nowrap shrink-0">${escapeHtml(page.ctaLabel)}</a>
      </div>
    </div>
  </header>
  <main class="mx-auto w-full max-w-[960px] flex-1 px-4 py-12 sm:px-6 sm:py-16">
    <section class="mx-auto max-w-3xl text-center">
      <p class="text-xs font-semibold uppercase tracking-wider text-sky-400">${escapeHtml(page.eyebrow)}</p>
      ${headingTag}
      <p class="mx-auto mt-4 max-w-2xl text-base sm:text-lg leading-relaxed text-slate-300">${escapeHtml(page.lead)}</p>${usageNoticeHtml}
      <div class="mt-8 flex flex-wrap items-center justify-center gap-4">
        <a href="/" class="inline-flex min-h-[48px] items-center justify-center rounded-lg bg-sky-500 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-sky-400">${escapeHtml(page.ctaLabel)}</a>
      </div>
    </section>
    <div class="mt-12 space-y-8">${sectionsHtml}</div>
    <section aria-labelledby="landing-faq-heading" class="mt-12">
      <h2 id="landing-faq-heading" class="font-display text-2xl font-bold tracking-tight text-slate-50">Frequently asked questions</h2>
      <div class="mt-6 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-[#111A2E]">${faqsHtml}</div>
    </section>
    <div class="mt-12 rounded-xl border border-slate-800 bg-[#111A2E] p-6 sm:p-8 text-center">
      <a href="/" class="inline-flex min-h-[48px] items-center justify-center rounded-lg bg-sky-500 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-sky-400">${escapeHtml(page.ctaLabel)}</a>
    </div>
  </main>
  <footer class="mt-20 border-t border-slate-200 bg-white text-slate-950">
    <div class="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div class="space-y-1.5">
        <a href="/" class="inline-flex min-h-[44px] items-center font-display text-lg font-bold tracking-tight text-slate-950">ClearFrame</a>
        <p class="text-sm text-slate-600">Free 4K video watermark remover &amp; upscaler · Up to 300 MB · No external APIs</p>
      </div>
      <nav aria-label="Footer navigation" class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium text-slate-700">
        <a href="/#workspace" class="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950">Workspace</a>
        <a href="/remove-video-watermark" class="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950">Remove Watermark</a>
        <a href="/4k-video-upscaler" class="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950">4K Upscaler</a>
        <span class="inline-flex min-h-[44px] items-center text-slate-500">© 2026 ClearFrame</span>
      </nav>
    </div>
  </footer>
</div>`;
}

export function injectLandingPageSeo(
  htmlTemplate: string,
  page: LandingPageData,
  siteUrl: string = SITE_URL
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
        '@type': 'WebPage',
        '@id': `${canonicalUrl}#webpage`,
        url: canonicalUrl,
        name: page.title,
        description: page.description,
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
  const staticReplacement = `<div id="root">${renderLandingPageHtml(page, true)}</div>\n    <noscript>${renderLandingPageHtml(page, false)}</noscript>`;
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
