'use client';

import { useState } from 'react';
import type { Question } from '@/lib/types';
import { APP_CONFIG } from '@/lib/config';
import { useStore } from '@/lib/store';
import Markdown from './Markdown';
import FeynmanCard from './FeynmanCard';
import FirstPrincipleCard from './FirstPrincipleCard';
import { showToast } from './Toast';

interface Props {
  q: Question;
  onFollowUp?: (text: string) => void;
  showNotes?: boolean;
}

export default function QuestionContent({ q, onFollowUp, showNotes = true }: Props) {
  const note = useStore((s) => (s.notes[q.id] !== undefined ? s.notes[q.id] : ''));
  const setNote = useStore((s) => s.setNote);
  const [fullscreenImg, setFullscreenImg] = useState<string | null>(null);
  const catCfg = APP_CONFIG.categories[q.category] || APP_CONFIG.categories['all'];
  const basePath = process.env.NODE_ENV === 'production' ? '/jd-interview' : '';

  return (
    <div>
      {/* meta row */}
      <div className="q-meta">
        <span className="q-meta-id">{q.id}</span>
        <span className="q-meta-diff">{q.difficulty}</span>
        <span className="q-meta-cat" style={{ background: catCfg.color }}>{catCfg.icon} {catCfg.label}</span>
        {q.subcategory && <span className="q-meta-sub">{q.subcategory}</span>}
        <style>{`
          .q-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; align-items: center; }
          .q-meta-id { background: var(--card-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 2px 9px; font-size: 12px; color: var(--text-tertiary); font-family: "SF Mono", monospace; }
          .q-meta-diff { background: var(--primary); color: #fff; border-radius: 6px; padding: 2px 9px; font-size: 12px; font-weight: 600; }
          .q-meta-cat { color: #fff; border-radius: 6px; padding: 2px 9px; font-size: 12px; font-weight: 500; }
          .q-meta-sub { background: var(--card-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 2px 9px; font-size: 12px; color: var(--text-secondary); }
        `}</style>
      </div>

      <FeynmanCard feynman={q.feynman || {}} />

      {/* answer */}
      <div style={{ margin: '10px 0' }}>
        <Markdown>{q.answer || '*暂无答案*'}</Markdown>
      </div>

      <FirstPrincipleCard fp={q.first_principle || {}} />

      {/* memory points */}
      {q.memory_points && q.memory_points.length > 0 && (
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(52,199,89,0.06), rgba(52,199,89,0.02))',
            border: '1px solid var(--border)',
            borderLeft: '4px solid #34c759',
            borderRadius: 'var(--radius-md)',
            padding: '16px 18px',
            margin: '14px 0',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '10px', color: 'var(--text)', letterSpacing: '-0.01em' }}>
            📌 记忆要点
          </div>
          <ul style={{ margin: '0', paddingLeft: '20px', fontSize: '14px', lineHeight: '1.7' }}>
            {q.memory_points.map((p, i) => (
              <li key={i} style={{ marginBottom: '4px' }}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* images */}
      {q.images.length > 0 && (
        <div style={{ margin: '12px 0' }}>
          {q.images.map((img, i) => (
            <img
              key={i}
              src={`${basePath}/images/${img}`}
              alt={img}
              loading={i === 0 ? 'eager' : 'lazy'}
              onClick={() => setFullscreenImg(`${basePath}/images/${img}`)}
              style={{ width: '100%', borderRadius: '10px', margin: '6px 0', cursor: 'zoom-in', border: '1px solid var(--border)' }}
            />
          ))}
        </div>
      )}

      {/* follow-ups */}
      {q.follow_up.length > 0 && (
        <div style={{ margin: '12px 0' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>❓ 延伸追问</div>
          {q.follow_up.map((fu, i) => (
            <button
              key={i}
              onClick={() => onFollowUp?.(fu)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px', margin: '4px 0', cursor: 'pointer', color: 'var(--text)', fontSize: '14px' }}
            >
              {fu}
            </button>
          ))}
        </div>
      )}

      {/* notes */}
      {showNotes && (
        <div style={{ margin: '16px 0 8px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>📝 我的笔记</div>
          <textarea
            value={note}
            onChange={(e) => {
              setNote(q.id, e.target.value);
              showToast(e.target.value.trim() ? '笔记已保存' : '笔记已删除');
            }}
            placeholder="在这里记录你的理解和补充…"
            style={{ width: '100%', minHeight: '90px', background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 12px', color: 'var(--text)', fontSize: '14px', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      )}

      {fullscreenImg && (
        <div
          onClick={() => setFullscreenImg(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: '20px' }}
        >
          <img src={fullscreenImg} alt="fullscreen" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}
    </div>
  );
}
