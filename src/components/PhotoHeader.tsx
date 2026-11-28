import React, { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { ClearFrameLogo } from './ClearFrameLogo';

interface PhotoHeaderProps {
  activePath: '/remove-photo-watermark' | '/photo-upscaler';
  actionLabel: string;
  onActionClick: () => void;
}

const PHOTO_MOBILE_NAV_LINKS = [
  { label: 'Workspace', href: '/#workspace' },
  { label: 'Video Watermark', href: '/remove-video-watermark' },
  { label: '4K Upscaler', href: '/4k-video-upscaler' },
  { label: 'Photo Watermark', href: '/remove-photo-watermark' },
  { label: 'Photo Upscaler', href: '/photo-upscaler' },
  { label: 'FAQ', href: '/#faq' },
] as const;

export const PhotoHeader: React.FC<PhotoHeaderProps> = ({
  activePath,
  actionLabel,
  onActionClick,
}) => {
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
          <a href="/" className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0">
            Video Studio
          </a>
          <a
            href="/remove-video-watermark"
            className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            Video Watermark
          </a>
          <a
            href="/4k-video-upscaler"
            className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            4K Video Upscaler
          </a>
          <a
            href="/remove-photo-watermark"
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activePath === '/remove-photo-watermark' ? 'text-sky-400' : 'hover:text-sky-400'
            }`}
          >
            Photo Watermark
          </a>
          <a
            href="/photo-upscaler"
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activePath === '/photo-upscaler' ? 'text-sky-400' : 'hover:text-sky-400'
            }`}
          >
            Photo Upscaler
          </a>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onActionClick}
            className="hidden sm:inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {actionLabel}
          </button>

          <button
            ref={menuButtonRef}
            type="button"
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
            aria-controls="photo-mobile-menu"
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
          id="photo-mobile-menu"
          aria-label="Mobile navigation"
          className="xl:hidden border-t border-slate-800/80 bg-[#0B1120] px-4 py-3 sm:px-6"
        >
          <div className="mx-auto flex max-w-[1200px] flex-col gap-1">
            {PHOTO_MOBILE_NAV_LINKS.map((item) => {
              const isActive = item.href === activePath;
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
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onActionClick();
              }}
              className="mt-2 sm:hidden flex min-h-[44px] w-full items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 cursor-pointer"
            >
              {actionLabel}
            </button>
          </div>
        </nav>
      )}
    </header>
  );
};
