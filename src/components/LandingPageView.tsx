import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, Menu, X } from 'lucide-react';
import { ClearFrameLogo } from './ClearFrameLogo';
import { Footer } from './InfoSections';
import type { LandingPageData } from '../seo/landingPages';

interface LandingPageViewProps {
  page: LandingPageData;
}

const LANDING_MOBILE_NAV_LINKS = [
  { label: 'Workspace', href: '/' },
  { label: 'Video Watermark', href: '/remove-video-watermark' },
  { label: '4K Upscaler', href: '/4k-video-upscaler' },
  { label: 'Photo Watermark', href: '/remove-photo-watermark' },
  { label: 'Photo Upscaler', href: '/photo-upscaler' },
  { label: 'FAQ', href: '/#faq' },
] as const;

export const LandingPageView: React.FC<LandingPageViewProps> = ({ page }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0B1120] text-slate-50">
      <header ref={headerRef} className="relative w-full border-b border-slate-800/80 bg-[#0B1120]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 xl:gap-6 px-4 py-4 sm:px-6">
          <a
            href="/"
            aria-label="ClearFrame Home"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
          >
            <ClearFrameLogo variant="dark" size="md" />
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden xl:flex items-center gap-6 text-sm font-medium text-slate-300"
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

          <div className="flex items-center gap-2.5 shrink-0">
            <a
              href="/"
              className="hidden sm:inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
            >
              {page.ctaLabel}
            </a>

            <button
              ref={menuButtonRef}
              type="button"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              aria-controls="landing-mobile-menu"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="xl:hidden inline-flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-slate-500/80 bg-slate-800/90 text-slate-50 transition-colors hover:border-sky-400 hover:text-sky-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 shrink-0 cursor-pointer"
            >
              {mobileMenuOpen ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <nav
            id="landing-mobile-menu"
            aria-label="Mobile navigation"
            className="xl:hidden border-t border-slate-800/80 bg-[#0B1120] px-4 py-3 sm:px-6"
          >
            <div className="mx-auto flex max-w-[1200px] flex-col gap-1">
              {LANDING_MOBILE_NAV_LINKS.map((item) => {
                const isActive = item.href === page.path;
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium transition-colors hover:bg-[#111A2E] hover:text-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                      isActive ? 'bg-[#111A2E] text-sky-400' : 'text-slate-200'
                    }`}
                  >
                    {item.label}
                  </a>
                );
              })}
              <a
                href="/"
                onClick={() => setMobileMenuOpen(false)}
                className="mt-2 sm:hidden flex min-h-[44px] w-full items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                {page.ctaLabel}
              </a>
            </div>
          </nav>
        )}
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
          {page.path === '/remove-video-watermark' && (
            <p className="mx-auto mt-3 max-w-2xl text-center text-xs text-slate-400 leading-relaxed">
              Use this tool only on videos you own or have{' '}
              <a
                href="/terms.html"
                className="text-slate-300 underline underline-offset-2 hover:text-sky-400 transition-colors"
              >
                permission
              </a>{' '}
              to edit.
            </p>
          )}
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
