import React from 'react';

interface ClearFrameLogoProps {
  variant?: 'dark' | 'light';
  size?: 'sm' | 'md';
}

export const ClearFrameLogo: React.FC<ClearFrameLogoProps> = ({
  variant = 'dark',
  size = 'md',
}) => {
  const iconDim = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const textClass =
    variant === 'light'
      ? 'text-slate-950'
      : 'text-slate-50';

  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <svg
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${iconDim} shrink-0`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="cf-grad" x1="4" y1="4" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38BDF8" />
            <stop offset="100%" stopColor="#0284C7" />
          </linearGradient>
        </defs>
        <rect
          x="2"
          y="2"
          width="32"
          height="32"
          rx="8"
          fill={variant === 'light' ? '#0B1120' : '#0F172A'}
          stroke="url(#cf-grad)"
          strokeWidth="2"
        />
        {/* Inner clean video frame corners */}
        <path
          d="M9.5 14V11.5C9.5 10.3954 10.3954 9.5 11.5 9.5H14M22 9.5H24.5C25.6046 9.5 26.5 10.3954 26.5 11.5V14M26.5 22V24.5C26.5 25.6046 25.6046 26.5 24.5 26.5H22M14 26.5H11.5C10.3954 26.5 9.5 25.6046 9.5 24.5V22"
          stroke="#E2E8F0"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Clean play / frame aperture triangle */}
        <path
          d="M15.5 13.75L22.5 18L15.5 22.25V13.75Z"
          fill="url(#cf-grad)"
        />
        {/* Subtle clean-sweep spark dot on top-right corner */}
        <circle cx="25.5" cy="10.5" r="2" fill="#38BDF8" />
      </svg>
      <span className={`font-display text-lg font-bold tracking-tight ${textClass}`}>
        ClearFrame
      </span>
    </span>
  );
};
