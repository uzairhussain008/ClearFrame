import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    atOptions?: {
      key: string;
      format: string;
      height: number;
      width: number;
      params: Record<string, unknown>;
    };
  }
}

let bannerLoadQueue: Promise<void> = Promise.resolve();

interface AdBannerSlotProps {
  adKey: string;
  scriptSrc: string;
  width: number;
  height: number;
  className?: string;
}

export const AdBannerSlot: React.FC<AdBannerSlotProps> = ({
  adKey,
  scriptSrc,
  width,
  height,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || el.dataset.adLoaded === adKey) {
      return;
    }
    el.dataset.adLoaded = adKey;

    let cancelled = false;

    bannerLoadQueue = bannerLoadQueue
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (cancelled || !containerRef.current) {
              resolve();
              return;
            }

            window.atOptions = {
              key: adKey,
              format: 'iframe',
              height,
              width,
              params: {},
            };

            const script = document.createElement('script');
            script.src = scriptSrc;
            script.async = false;

            const timer = window.setTimeout(resolve, 4000);
            script.onload = () => {
              window.clearTimeout(timer);
              resolve();
            };
            script.onerror = () => {
              window.clearTimeout(timer);
              resolve();
            };

            containerRef.current.appendChild(script);
          })
      );

    return () => {
      cancelled = true;
    };
  }, [adKey, scriptSrc, width, height]);

  return (
    <div
      ref={containerRef}
      data-ad-key={adKey}
      className={`flex max-w-full items-center justify-center overflow-hidden ${className}`}
    />
  );
};
