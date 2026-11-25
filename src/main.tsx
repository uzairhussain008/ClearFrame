import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { LandingPageView } from './components/LandingPageView.tsx';
import { getLandingPageByPath } from './seo/landingPages.ts';
import './index.css';

const landingPage = getLandingPageByPath(window.location.pathname);

if (!landingPage) {
  // Dynamically align canonical and OpenGraph URLs with the active origin
  const canonicalUrl = `${window.location.origin}${window.location.pathname}`;
  const existingCanonical = document.querySelector('link[rel="canonical"]');
  if (existingCanonical) {
    existingCanonical.setAttribute('href', canonicalUrl);
  } else {
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = canonicalUrl;
    document.head.appendChild(link);
  }
  const existingOgUrl = document.querySelector('meta[property="og:url"]');
  if (existingOgUrl) {
    existingOgUrl.setAttribute('content', canonicalUrl);
  } else {
    const meta = document.createElement('meta');
    meta.setAttribute('property', 'og:url');
    meta.content = canonicalUrl;
    document.head.appendChild(meta);
  }
}

createRoot(document.getElementById('root')!).render(
  landingPage ? <LandingPageView page={landingPage} /> : <App />
);
