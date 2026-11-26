import React from 'react';
import { ClearFrameLogo } from './ClearFrameLogo';

interface PhotoHeaderProps {
  activePath: '/remove-photo-watermark' | '/photo-upscaler';
  actionLabel: string;
  onActionClick: () => void;
}

export const PhotoHeader: React.FC<PhotoHeaderProps> = ({
  activePath,
  actionLabel,
  onActionClick,
}) => {
  return (
    <header className="border-b border-slate-800/80 bg-[#0B1120]">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-6 px-4 py-4 sm:px-6">
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

        <div className="shrink-0">
          <button
            type="button"
            onClick={onActionClick}
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </header>
  );
};
