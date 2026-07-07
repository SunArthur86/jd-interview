'use client';

import { useEffect, useState } from 'react';

let _setMsg: ((m: string) => void) | null = null;

export function showToast(msg: string) {
  _setMsg?.(msg);
}

export default function Toast() {
  const [msg, setMsg] = useState('');

  useEffect(() => {
    _setMsg = setMsg;
    return () => {
      _setMsg = null;
    };
  }, []);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), 2500);
    return () => clearTimeout(t);
  }, [msg]);

  if (!msg) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 'calc(env(safe-area-inset-bottom, 0) + 24px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--text)',
        color: 'var(--bg)',
        padding: '10px 20px',
        borderRadius: '999px',
        fontSize: '14px',
        zIndex: 10000,
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        maxWidth: '90vw',
        textAlign: 'center',
      }}
    >
      {msg}
    </div>
  );
}
