import type { FirstPrinciple } from '@/lib/types';

export default function FirstPrincipleCard({ fp }: { fp: FirstPrinciple }) {
  if (!fp || (!fp.problem && !fp.axioms?.length && !fp.rebuild)) return null;
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(175,82,222,0.06), rgba(175,82,222,0.02))',
        border: '1px solid var(--border)',
        borderLeft: '4px solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        padding: '16px 18px',
        margin: '14px 0',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '10px', color: 'var(--text)', letterSpacing: '-0.01em' }}>
        🏗️ 第一性原理
      </div>
      {fp.problem && (
        <div style={{ marginBottom: '6px', fontSize: '14px' }}>
          ❓ <strong>根本问题：</strong>
          {fp.problem}
        </div>
      )}
      {fp.axioms && fp.axioms.length > 0 && (
        <div style={{ marginBottom: '6px', fontSize: '14px' }}>
          🧱 <strong>核心公理：</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: '20px' }}>
            {fp.axioms.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {fp.rebuild && (
        <div style={{ fontSize: '14px' }}>
          ⚙️ <strong>从零重建：</strong>
          {fp.rebuild}
        </div>
      )}
    </div>
  );
}
