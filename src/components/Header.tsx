import React from 'react';
import { ClearFrameLogo } from './ClearFrameLogo';

interface HeaderProps {
  onUploadClick: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onUploadClick }) => {
  return (
    <header className="border-b border-slate-800/80 bg-[#0B1120]">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-4 py-4 sm:px-6">
        <a
          href="#workspace"
          aria-label="ClearFrame Home"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 whitespace-nowrap shrink-0"
        >
          <ClearFrameLogo variant="dark" size="md" />
        </a>

        <nav
          aria-label="Primary navigation"
          className="hidden lg:flex items-center gap-5 text-sm font-medium text-slate-300"
        >
          <a
            href="#workspace"
            className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            Workspace
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
          <a
            href="#faq"
            className="hover:text-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            FAQ
          </a>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onUploadClick}
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Upload Video
          </button>
        </div>
      </div>
    </header>
  );
};
