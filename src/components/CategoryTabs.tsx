'use client';

import type { CategoryConfig } from '@/lib/config';

interface Props {
  categories: Record<string, CategoryConfig>;
  current: string;
  counts: Record<string, number>;
  onChange: (c: string) => void;
}

export default function CategoryTabs({ categories, current, counts, onChange }: Props) {
  return (
    <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', padding: '4px 0', flexWrap: 'wrap' }}>
      {Object.entries(categories).map(([key, cfg]) => {
        const active = current === key;
        const count = counts[key] || 0;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              background: active ? (cfg.color || 'var(--primary)') : 'var(--bg-soft)',
              color: active ? '#fff' : 'var(--text)',
              border: '1px solid',
              borderColor: active ? (cfg.color || 'var(--primary)') : 'var(--border)',
              borderRadius: '999px',
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: '13px',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span>{cfg.icon}</span>
            <span>{cfg.label}</span>
            <span style={{ opacity: 0.8, fontSize: '11px' }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
