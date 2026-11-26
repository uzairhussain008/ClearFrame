import React from 'react';
import { Footer } from './InfoSections';
import type { PhotoPageData } from '../seo/photoPages';

interface PhotoPageSeoSectionsProps {
  page: PhotoPageData;
}

export const PhotoPageSeoSections: React.FC<PhotoPageSeoSectionsProps> = ({ page }) => {
  return (
    <div className="mt-16 space-y-14 border-t border-slate-800/80 pt-14">
      <section aria-labelledby="photo-how-it-works" className="scroll-mt-8">
        <h2
          id="photo-how-it-works"
          className="font-display text-2xl font-bold tracking-tight text-slate-50"
        >
          How it works
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
          {page.steps.map((step) => (
            <article key={step.num} className="rounded-xl border border-slate-800 bg-[#111A2E] p-6">
              <span className="font-mono text-sm font-semibold text-sky-400 tabular-nums">
                {step.num}
              </span>
              <h3 className="mt-2 font-display text-base font-semibold text-slate-50">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{step.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="photo-faq-heading" className="scroll-mt-8">
        <h2
          id="photo-faq-heading"
          className="font-display text-2xl font-bold tracking-tight text-slate-50"
        >
          Frequently asked questions
        </h2>
        <div className="mt-6 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-[#111A2E]">
          {page.faqs.map((item) => (
            <div key={item.question} className="px-6 py-5">
              <h3 className="text-sm font-semibold text-slate-100">{item.question}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{item.answer}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="all-tools-heading" className="rounded-xl border border-slate-800 bg-[#111A2E] p-6">
        <h2
          id="all-tools-heading"
          className="font-display text-lg font-semibold tracking-tight text-slate-50"
        >
          More free ClearFrame tools
        </h2>
        <div className="mt-4 flex flex-wrap gap-3 text-sm font-medium">
          <a
            href="/"
            className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2 text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
          >
            Video Studio Home
          </a>
          <a
            href="/remove-video-watermark"
            className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2 text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
          >
            Remove Video Watermark
          </a>
          <a
            href="/4k-video-upscaler"
            className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2 text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
          >
            4K Video Upscaler
          </a>
          <a
            href="/remove-photo-watermark"
            className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2 text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
          >
            Photo Watermark Remover
          </a>
          <a
            href="/photo-upscaler"
            className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2 text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-300"
          >
            Photo Upscaler
          </a>
        </div>
      </section>
    </div>
  );
};

export { Footer };
