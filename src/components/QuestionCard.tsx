'use client';

import type { Question, Rating } from '@/lib/types';
import { APP_CONFIG } from '@/lib/config';

interface Props {
  q: Question;
  isFav: boolean;
  isViewed: boolean;
  rating?: Rating;
  highlight: string;
  onOpen: () => void;
  onToggleFav: () => void;
  onTagClick: (t: string) => void;
}

const RATING_BADGE: Record<Rating, { icon: string; label: string; color: string }> = {
  know: { icon: '✅', label: '已掌握', color: 'var(--success)' },
  fuzzy: { icon: '🤔', label: '待复习', color: 'var(--warning)' },
  dont: { icon: '❌', label: '不会', color: 'var(--danger)' },
};

export default function QuestionCard({ q, isFav, isViewed, rating, highlight, onOpen, onToggleFav, onTagClick }: Props) {
  const catCfg = APP_CONFIG.categories[q.category] || APP_CONFIG.categories['all'];

  const renderHighlight = (text: string) => {
    if (!highlight.trim()) return text;
    const q = highlight.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="search-hit">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <div
      onClick={onOpen}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '16px',
        cursor: 'pointer',
        position: 'relative',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s',
        boxShadow: 'var(--shadow-sm)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
        e.currentTarget.style.borderColor = 'var(--primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
        e.currentTarget.style.borderColor = 'var(--border)';
      }}
    >
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: '5px', padding: '1px 6px', fontSize: '11px' }}>{q.difficulty}</span>
        <span style={{ color: catCfg.color, fontSize: '12px' }}>{catCfg.icon} {catCfg.label}</span>
        {rating && (
          <span style={{ color: RATING_BADGE[rating].color, fontSize: '11px' }}>{RATING_BADGE[rating].icon} {RATING_BADGE[rating].label}</span>
        )}
        {isViewed && <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>✓ 已看</span>}
        {q.images.length > 0 && <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>🖼️ {q.images.length}</span>}
      </div>

      <div style={{ fontSize: '15px', fontWeight: 500, lineHeight: 1.4, marginBottom: '8px', paddingRight: '28px' }}>
        {renderHighlight(q.question)}
      </div>

      {q.tags.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {q.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              onClick={(e) => {
                e.stopPropagation();
                onTagClick(t);
              }}
              style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '5px', padding: '1px 7px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav();
        }}
        aria-label="收藏"
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          background: 'none',
          border: 'none',
          fontSize: '18px',
          cursor: 'pointer',
          color: isFav ? 'var(--danger)' : 'var(--text-tertiary)',
          lineHeight: 1,
        }}
      >
        {isFav ? '♥' : '♡'}
      </button>
    </div>
  );
}
