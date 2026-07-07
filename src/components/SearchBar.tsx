'use client';

import { useState, useRef, useEffect } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  history: string[];
  onClearHistory: () => void;
  onPickHistory: (h: string) => void;
}

export default function SearchBar({ value, onChange, history, onClearHistory, onPickHistory }: Props) {
  const [focused, setFocused] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowHistory(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const show = showHistory && !value && history.length > 0;

  return (
    <div ref={ref} style={{ position: 'relative', flex: 2, minWidth: '180px' }}>
      <input
        id="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          setShowHistory(true);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          if (e.key === 'Enter') setShowHistory(false);
        }}
        placeholder="搜索题目、标签、答案…"
        style={{
          width: '100%',
          background: 'var(--bg-soft)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          padding: '8px 14px',
          color: 'var(--text)',
          fontSize: '14px',
          outline: 'none',
        }}
      />
      {show && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            zIndex: 100,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-tertiary)' }}>
            <span>最近搜索</span>
            <button onClick={onClearHistory} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '12px' }}>清空</button>
          </div>
          {history.map((h) => (
            <button
              key={h}
              onClick={() => {
                onPickHistory(h);
                setShowHistory(false);
              }}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 12px', cursor: 'pointer', color: 'var(--text)', fontSize: '14px' }}
            >
              🕐 {h}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
