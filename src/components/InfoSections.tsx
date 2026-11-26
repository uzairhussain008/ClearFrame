import React from 'react';
import { ChevronDown } from 'lucide-react';
import { ClearFrameLogo } from './ClearFrameLogo';

const STEPS = [
  {
    num: '01.',
    title: 'Upload up to 300 MB',
    description:
      'Drop MP4, MOV, WebM, MKV, or AVI files directly from your device with zero sign-up.',
  },
  {
    num: '02.',
    title: 'Mark & choose up to 4K',
    description:
      'Draw boxes over logos or text overlays, and optionally upscale to 1080p, 2K, or 4K.',
  },
  {
    num: '03.',
    title: 'Compare & download MP4',
    description:
      'Check Before/After frames with the split slider and save your clean video with audio.',
  },
];

const SPECS = [
  { label: 'Max upload size', value: '300 MB per video (100% free)' },
  { label: 'Supported formats', value: 'MP4, MOV, WebM, MKV, AVI, M4V' },
  { label: 'Removal engines', value: 'Smart Inpaint (Delogo), Soft Blur, Mosaic' },
  { label: 'Upscale targets', value: 'Original, 1080p, 2K, 4K UHD (NNEDI3 + CAS)' },
  { label: 'Audio & privacy', value: 'Original audio preserved · Auto-deleted in 15 min' },
];

const FAQS = [
  {
    q: 'Is ClearFrame completely free for videos up to 300 MB?',
    a: 'Yes. You can upload, remove watermarks, and upscale videos up to 300 MB to 4K completely free with no account, no credits, and no export watermark.',
  },
  {
    q: 'Does upscaling to 4K degrade the original video quality?',
    a: 'No. ClearFrame uses NNEDI3 neural edge-directed reconstruction, deblocking, Lanczos resampling, and balanced adaptive sharpening with high-profile H.264 MP4 encoding (CRF 16–18), and never downscales if your source is already 4K or higher.',
  },
  {
    q: 'Which watermark removal method works best?',
    a: 'Smart Inpaint reconstructs pixels from surrounding edges for corner logos and static text, while Soft Blur and Mosaic work well over fast-moving or complex textured backgrounds.',
  },
  {
    q: 'Can I remove watermarks that appear only during certain seconds?',
    a: 'Yes. Each watermark box supports optional Start and End timestamps in seconds so removal only runs while the watermark is visible.',
  },
  {
    q: 'How long are uploaded videos stored?',
    a: 'Temporary uploaded and processed video files are automatically deleted after 15 minutes or immediately when you switch videos.',
  },
];

export const InfoSections: React.FC = () => {
  return (
    <div className="space-y-16 border-t border-slate-800/80 pt-14">
      {/* Minimal Breathable 3-Step Flow */}
      <section id="how-it-works" aria-labelledby="how-it-works-heading" className="cv-auto scroll-mt-8">
        <h2
          id="how-it-works-heading"
          className="font-display text-2xl font-bold tracking-tight text-slate-50"
        >
          How it works
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((step) => (
            <article
              key={step.num}
              className="rounded-xl border border-slate-800 bg-[#111A2E] p-6"
            >
              <span className="font-mono text-sm font-semibold text-sky-400 tabular-nums">
                {step.num}
              </span>
              <h3 className="mt-2 font-display text-base font-semibold text-slate-50">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                {step.description}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Clean Minimal Specs */}
      <section id="specs" aria-labelledby="specs-heading" className="cv-auto scroll-mt-8">
        <h2
          id="specs-heading"
          className="font-display text-2xl font-bold tracking-tight text-slate-50"
        >
          Supported formats &amp; limits
        </h2>
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-800 bg-[#111A2E]">
          <dl className="divide-y divide-slate-800">
            {SPECS.map((item) => (
              <div
                key={item.label}
                className="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-[240px_1fr] sm:gap-6"
              >
                <dt className="text-sm font-medium text-slate-400">{item.label}</dt>
                <dd className="text-sm font-medium text-slate-100 tabular-nums">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* AEO / GEO-Structured FAQ: native details keeps all answers crawlable in DOM */}
      <section id="faq" aria-labelledby="faq-heading" className="cv-auto scroll-mt-8">
        <h2
          id="faq-heading"
          className="font-display text-2xl font-bold tracking-tight text-slate-50"
        >
          Frequently asked questions
        </h2>
        <div className="mt-6 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-[#111A2E]">
          {FAQS.map((item, idx) => (
            <details key={item.q} open={idx === 0} className="group">
              <summary className="flex w-full min-h-[52px] list-none items-center justify-between gap-4 px-6 py-4 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/40 cursor-pointer [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="px-6 pb-5 text-sm leading-relaxed text-slate-300">
                {item.a}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
};

export const Footer: React.FC = () => {
  return (
    <footer className="cv-auto mt-20 border-t border-slate-200 bg-white text-slate-950">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="space-y-1.5">
          <a
            href="/#workspace"
            aria-label="ClearFrame Top"
            className="inline-flex min-h-[44px] items-center rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-600"
          >
            <ClearFrameLogo variant="light" size="md" />
          </a>
          <p className="text-sm text-slate-600">
            Free 4K video watermark remover &amp; upscaler · Up to 300 MB · No external APIs
          </p>
        </div>

        <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium text-slate-700">
          <a href="/#workspace" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Workspace
          </a>
          <a href="/remove-video-watermark" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Remove Watermark
          </a>
          <a href="/4k-video-upscaler" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            4K Upscaler
          </a>
          <a href="/remove-photo-watermark" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Photo Watermark
          </a>
          <a href="/photo-upscaler" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Photo Upscaler
          </a>
          <a href="/#how-it-works" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            How It Works
          </a>
          <a href="/#specs" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Specs
          </a>
          <a href="/#faq" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            FAQ
          </a>
          <a href="/privacy.html" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Privacy
          </a>
          <a href="/terms.html" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            Terms
          </a>
          <a href="/about.html" className="inline-flex min-h-[44px] items-center px-1 hover:text-slate-950 transition-colors whitespace-nowrap">
            About
          </a>
          <span className="inline-flex min-h-[44px] items-center text-slate-500 whitespace-nowrap">© 2026 ClearFrame</span>
        </nav>
      </div>
    </footer>
  );
};
