'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Question, Rating } from '@/lib/types';
import { useStore } from '@/lib/store';
import { APP_CONFIG } from '@/lib/config';
import QuestionContent from './QuestionContent';
import { showToast } from './Toast';

interface Props {
  pool: Question[];
  mode: 'sequential' | 'random' | 'wrong-only';
  allQuestions: Question[];
  onExit: () => void;
}

const RATING_META: { rating: Rating; icon: string; label: string; hint: string }[] = [
  { rating: 'know', icon: '✅', label: '会了', hint: '熟练掌握' },
  { rating: 'fuzzy', icon: '🤔', label: '有点模糊', hint: '需要复习' },
  { rating: 'dont', icon: '❌', label: '不会', hint: '加入错题本' },
];

export default function StudyMode({ pool, mode, allQuestions, onExit }: Props) {
  const store = useStore();

  const queue = useMemo(() => {
    let base: Question[];
    if (mode === 'wrong-only') {
      base = allQuestions.filter((q) => store.ratings[q.id] === 'dont' || store.ratings[q.id] === 'fuzzy');
    } else {
      base = pool;
    }
    if (mode === 'random') {
      const arr = [...base];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    return base;
  }, [pool, mode, allQuestions, store.ratings]);

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);

  // empty check
  useEffect(() => {
    if (queue.length === 0) {
      showToast(mode === 'wrong-only' ? '错题本为空' : '当前筛选条件下没有题目');
      onExit();
    }
  }, [queue.length, mode, onExit]);

  const q = queue[index];

  const next = useCallback(() => {
    setRevealed(false);
    if (index < queue.length - 1) setIndex((i) => i + 1);
    else setDone(true);
  }, [index, queue.length]);

  const prev = useCallback(() => {
    setRevealed(false);
    if (index > 0) setIndex((i) => i - 1);
  }, [index]);

  const rate = useCallback(
    (r: Rating) => {
      if (!q) return;
      const prevR = store.ratings[q.id];
      store.setRating(q.id, r);
      store.logStudy(r, prevR);
      showToast(`已记录：${RATING_META.find((m) => m.rating === r)?.label}`);
      setTimeout(next, 400);
    },
    [q, store, next]
  );

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done) {
        if (e.key === 'Escape') onExit();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prev(); }
      else if (e.key === ' ' || e.key === 'Enter') { if (!revealed) { e.preventDefault(); setRevealed(true); } }
      else if (revealed && e.key === '1') { e.preventDefault(); rate('know'); }
      else if (revealed && e.key === '2') { e.preventDefault(); rate('fuzzy'); }
      else if (revealed && e.key === '3') { e.preventDefault(); rate('dont'); }
      else if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, revealed, next, prev, rate, onExit]);

  if (done) {
    const rated = Object.entries(store.ratings);
    const know = rated.filter(([, r]) => r === 'know').length;
    const fuzzy = rated.filter(([, r]) => r === 'fuzzy').length;
    const dont = rated.filter(([, r]) => r === 'dont').length;
    const total = know + fuzzy + dont;
    const acc = total > 0 ? Math.round((know / total) * 100) : 0;
    const tier = acc >= 80 ? '🎉' : acc >= 50 ? '💪' : '📚';
    return (
      <div style={{ maxWidth: '600px', margin: '0 auto', padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: '60px', marginBottom: '12px' }}>{tier}</div>
        <h2 style={{ fontSize: '22px', marginBottom: '20px' }}>本轮学习完成！</h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
          <Stat label="本组" value={queue.length} />
          <Stat label="✅ 会了" value={know} color="var(--success)" />
          <Stat label="🤔 模糊" value={fuzzy} color="var(--warning)" />
          <Stat label="❌ 不会" value={dont} color="var(--danger)" />
          <Stat label="掌握率" value={`${acc}%`} />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => { setIndex(0); setDone(false); setRevealed(false); }} style={btnPrimary}>再来一轮</button>
          {(dont + fuzzy) > 0 && <button onClick={() => {/* parent handles mode change */ }} style={btnPrimary}>只刷错题</button>}
          <button onClick={onExit} style={btnGhost}>返回列表</button>
        </div>
      </div>
    );
  }

  if (!q) return null;

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '12px 16px calc(env(safe-area-inset-bottom, 0) + 24px)' }}>
      {/* topbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <button onClick={onExit} style={btnGhost}>← 返回</button>
        <div style={{ flex: 1, fontWeight: 600 }}>
          {mode === 'random' ? '🎲 随机' : mode === 'wrong-only' ? '📕 错题' : '📖 顺序'}学习 ({index + 1}/{queue.length})
        </div>
      </div>
      {/* progress */}
      <div style={{ height: '4px', background: 'var(--border)', borderRadius: '2px', marginBottom: '16px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${((index + 1) / queue.length) * 100}%`, background: 'var(--success)', transition: 'width 0.3s' }} />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px' }}>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: '5px', padding: '1px 6px', fontSize: '11px' }}>{q.difficulty}</span>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{q.tags.join(' · ')}</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => store.toggleFavorite(q.id)} style={btnGhost}>{store.favorites.includes(q.id) ? '♥' : '♡'}</button>
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 12px' }}>{q.question}</h2>

        {!revealed ? (
          <button onClick={() => setRevealed(true)} style={{ ...btnPrimary, width: '100%', padding: '14px' }}>👁️ 点击查看答案 (空格键)</button>
        ) : (
          <>
            <QuestionContent q={q} showNotes={false} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              {RATING_META.map((m) => (
                <button key={m.rating} onClick={() => rate(m.rating)} style={{ ...btnGhost, flex: 1, padding: '14px 8px', fontSize: '15px' }}>
                  <div>{m.icon}</div>
                  <div style={{ fontSize: '13px', marginTop: '2px' }}>{m.label}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button onClick={prev} disabled={index <= 0} style={{ ...btnGhost, opacity: index <= 0 ? 0.4 : 1 }}>← 上一题</button>
        <span style={{ flex: 1 }} />
        <button onClick={next} style={btnPrimary}>下一题 →</button>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ fontSize: '24px', fontWeight: 700, color: color || 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{label}</span>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '14px',
};
const btnGhost: React.CSSProperties = {
  background: 'var(--bg-soft)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '14px',
};
