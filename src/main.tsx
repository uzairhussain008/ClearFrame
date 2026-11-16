import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Dynamically set canonical and OpenGraph URL per applet-seo guidelines
const canonicalUrl = `${window.location.origin}${window.location.pathname}`;
if (!document.querySelector('link[rel="canonical"]')) {
  const link = document.createElement('link');
  link.rel = 'canonical';
  link.href = canonicalUrl;
  document.head.appendChild(link);
}
if (!document.querySelector('meta[property="og:url"]')) {
  const meta = document.createElement('meta');
  meta.setAttribute('property', 'og:url');
  meta.content = canonicalUrl;
  document.head.appendChild(meta);
}

createRoot(document.getElementById('root')!).render(<App />);
