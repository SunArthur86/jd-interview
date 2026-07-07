'use client';

import { useEffect } from 'react';
import { useStore, migrateLegacyStorage } from '@/lib/store';
import Toast from './Toast';

export default function ClientBootstrap({ children }: { children: React.ReactNode }) {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  useEffect(() => {
    migrateLegacyStorage();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // expose theme toggle globally for any component that needs it without prop drilling
  useEffect(() => {
    (window as unknown as { __toggleTheme?: () => void }).__toggleTheme = toggleTheme;
  }, [toggleTheme]);

  // register service worker (PWA / offline)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (process.env.NODE_ENV !== 'production') return;
    const basePath = '/jd-interview';
    navigator.serviceWorker?.register(`${basePath}/sw.js`).catch(() => {});
  }, []);

  return (
    <>
      {children}
      <Toast />
    </>
  );
}
