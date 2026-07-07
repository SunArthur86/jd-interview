import type { Feynman } from '@/lib/types';

export default function FeynmanCard({ feynman }: { feynman: Feynman }) {
  if (!feynman || (!feynman.essence && !feynman.analogy && !feynman.key_points?.length && !feynman.first_principle)) return null;
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(52,199,89,0.06), rgba(52,199,89,0.02))',
        border: '1px solid var(--border)',
        borderLeft: '4px solid var(--success)',
        borderRadius: 'var(--radius-md)',
        padding: '16px 18px',
        margin: '14px 0',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '10px', color: 'var(--text)', letterSpacing: '-0.01em' }}>
        🎓 费曼快记
      </div>
      {feynman.essence && (
        <div style={{ marginBottom: '6px', fontSize: '14px' }}>
          🎯 <strong>一句话本质：</strong>
          {feynman.essence}
        </div>
      )}
      {feynman.analogy && (
        <div style={{ marginBottom: '6px', fontSize: '14px' }}>
          🧒 <strong>大白话：</strong>
          {feynman.analogy}
        </div>
      )}
      {feynman.key_points && feynman.key_points.length > 0 && (
        <div style={{ fontSize: '14px' }}>
          💡 <strong>关键点：</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: '20px' }}>
            {feynman.key_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
