'use client';

import { useState } from 'react';

interface Props {
  viewed: number;
  total: number;
  favorites: number;
  shown: number;
  onReset: () => void;
}

export default function ProgressRing({ viewed, total, favorites, shown, onReset }: Props) {
  const [confirming, setConfirming] = useState(false);
  const pct = total > 0 ? Math.round((viewed / total) * 100) : 0;
  const r = 22;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '8px 12px' }}>
      <div style={{ position: 'relative', width: '54px', height: '54px' }}>
        <svg width="54" height="54" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="27" cy="27" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
          <circle cx="27" cy="27" r={r} fill="none" stroke="var(--success)" strokeWidth="5" strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600 }}>{pct}%</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <span>📚 共 <strong style={{ color: 'var(--text)' }}>{total}</strong></span>
        <span>✅ 已看 <strong style={{ color: 'var(--text)' }}>{viewed}</strong></span>
        <span>★ 收藏 <strong style={{ color: 'var(--text)' }}>{favorites}</strong> · 当前 {shown}</span>
      </div>
      {confirming ? (
        <span style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' }}>
          <button onClick={() => { onReset(); setConfirming(false); }} style={{ background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer' }}>确认重置</button>
          <button onClick={() => setConfirming(false)} style={{ ...chip }}>取消</button>
        </span>
      ) : (
        <button onClick={() => setConfirming(true)} title="重置已看" style={{ ...chip }}>重置</button>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  background: 'var(--bg-soft)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: '11px',
  color: 'var(--text-secondary)',
};
