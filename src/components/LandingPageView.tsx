import React from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { ClearFrameLogo } from './ClearFrameLogo';
import { Footer } from './InfoSections';
import type { LandingPageData } from '../seo/landingPages';

interface LandingPageViewProps {
  page: LandingPageData;
}

export const LandingPageView: React.FC<LandingPageViewProps> = ({ page }) => {
  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <header className="border-b border-slate-800/80 bg-[#0B1120]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-4 py-4 sm:px-6">
          <a
            href="/"
            aria-label="ClearFrame Home"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
          >
            <ClearFrameLogo variant="dark" size="md" />
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-300"
          >
            <a
              href="/"
              className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              Workspace
            </a>
            <a
              href="/remove-video-watermark"
              className={`transition-colors whitespace-nowrap shrink-0 ${
                page.path === '/remove-video-watermark'
                  ? 'text-sky-400'
                  : 'hover:text-sky-400'
              }`}
            >
              Remove Watermark
            </a>
            <a
              href="/4k-video-upscaler"
              className={`transition-colors whitespace-nowrap shrink-0 ${
                page.path === '/4k-video-upscaler'
                  ? 'text-sky-400'
                  : 'hover:text-sky-400'
              }`}
            >
              4K Upscaler
            </a>
            <a
              href="/remove-photo-watermark"
              className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              Photo Watermark
            </a>
            <a
              href="/photo-upscaler"
              className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              Photo Upscaler
            </a>
          </nav>

          <div className="shrink-0">
            <a
              href="/"
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
            >
              {page.ctaLabel}
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[960px] flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <section className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-sky-400">
            {page.eyebrow}
          </p>
          <h1
            className="mt-3 font-display font-bold tracking-tight text-slate-50 text-center"
            style={{ fontSize: 'clamp(2.2rem, 4.2vw, 3.25rem)', lineHeight: 1.1, textWrap: 'balance' }}
          >
            {page.h1}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-center text-base sm:text-lg leading-relaxed text-slate-300">
            {page.lead}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a
              href="/"
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              <span>{page.ctaLabel}</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>

        <div className="mt-12 space-y-8">
          {page.sections.map((section) => (
            <section
              key={section.heading}
              className="rounded-xl border border-slate-800 bg-[#111A2E] p-6 sm:p-8"
            >
              <h2 className="font-display text-2xl font-bold tracking-tight text-slate-50">
                {section.heading}
              </h2>
              <div className="mt-4 space-y-4 text-base leading-relaxed text-slate-300">
                {section.paragraphs.map((paragraph, idx) => (
                  <p key={idx}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <section aria-labelledby="landing-faq-heading" className="mt-12">
          <h2
            id="landing-faq-heading"
            className="font-display text-2xl font-bold tracking-tight text-slate-50"
          >
            Frequently asked questions
          </h2>
          <div className="mt-6 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-[#111A2E]">
            {page.faqs.map((item, idx) => (
              <details key={item.question} open={idx === 0} className="group">
                <summary className="flex w-full min-h-[52px] list-none items-center justify-between gap-4 px-6 py-4 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/40 cursor-pointer [&::-webkit-details-marker]:hidden">
                  <span>{item.question}</span>
                  <ChevronDown
                    className="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <div className="px-6 pb-5 text-sm leading-relaxed text-slate-300">
                  {item.answer}
                </div>
              </details>
            ))}
          </div>
        </section>

        <div className="mt-12 rounded-xl border border-slate-800 bg-[#111A2E] p-6 sm:p-8 text-center">
          <a
            href="/"
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-sky-500 px-6 py-3 text-base font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            <span>{page.ctaLabel}</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </main>

      <Footer />
    </div>
  );
};
