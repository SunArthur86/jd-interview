'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Question, ReviewItem } from '@/lib/types';
import { useStore } from '@/lib/store';
import { review, previewInterval, formatInterval, isMastered, isDue, getBoxLabel, todayISO } from '@/lib/algorithms';
import QuestionContent from './QuestionContent';
import { showToast } from './Toast';

interface Props {
  allQuestions: Question[];
  onExit: () => void;
}

const QUALITY_META: { q: number; icon: string; label: string }[] = [
  { q: 0, icon: '😵', label: '完全忘了' },
  { q: 1, icon: '🤔', label: '很模糊' },
  { q: 2, icon: '✅', label: '记住了' },
  { q: 3, icon: '🌟', label: '很轻松' },
];
const QUALITY_TO_RATING: Record<number, 'know' | 'fuzzy' | 'dont'> = { 0: 'dont', 1: 'fuzzy', 2: 'know', 3: 'know' };

export default function ReviewMode({ allQuestions, onExit }: Props) {
  const store = useStore();

  const queue = useMemo(() => {
    const due = allQuestions.filter((q) => {
      const it = store.reviewData[q.id];
      if (it) return isDue(it);
      return store.autoEnroll; // not enrolled -> due if autoEnroll
    });
    // sort: enrolled due by nextDate asc, lapses desc; unenrolled last
    due.sort((a, b) => {
      const ia = store.reviewData[a.id];
      const ib = store.reviewData[b.id];
      if (!ia && !ib) return 0;
      if (!ia) return 1;
      if (!ib) return -1;
      if (ia.nextDate !== ib.nextDate) return ia.nextDate.localeCompare(ib.nextDate);
      return ib.lapses - ia.lapses;
    });
    return due.slice(0, store.dailyReviewLimit).map((q) => q.id);
  }, [allQuestions, store.reviewData, store.autoEnroll, store.dailyReviewLimit]);

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (queue.length === 0) {
      showToast('今日复习已完成 🎉');
      setDone(true);
    }
  }, [queue.length]);

  const currentId = queue[index];
  const q = allQuestions.find((x) => x.id === currentId);
  const item = currentId ? store.reviewData[currentId] : undefined;

  const advance = useCallback(() => {
    setRevealed(false);
    if (index < queue.length - 1) setIndex((i) => i + 1);
    else setDone(true);
  }, [index, queue.length]);

  const rate = useCallback(
    (quality: number) => {
      if (!q) return;
      const base = item || store.ensureReview(q.id);
      const updated = review(base, quality);
      store.upsertReview(q.id, updated);
      // sync to study ratings + daily log
      const r = QUALITY_TO_RATING[quality];
      const prevR = store.ratings[q.id];
      store.setRating(q.id, r);
      store.logStudy(r, prevR);
      setTimeout(advance, 400);
    },
    [q, item, store, advance]
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
      if (e.key === 'ArrowRight') advance();
      else if (e.key === 'ArrowLeft' && index > 0) { setRevealed(false); setIndex((i) => i - 1); }
      else if ((e.key === ' ' || e.key === 'Enter') && !revealed) { e.preventDefault(); setRevealed(true); }
      else if (revealed && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); rate(parseInt(e.key, 10) - 1); }
      else if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, revealed, advance, rate, onExit, index]);

  if (done) {
    const all = Object.values(store.reviewData);
    const mastered = all.filter(isMastered).length;
    const stillDue = all.filter(isDue).length;
    // 7-day forecast
    const today = new Date();
    const forecast = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const iso = d.toISOString().split('T')[0];
      const count = all.filter((it) => it.nextDate === iso).length;
      return { iso, count, label: i === 0 ? '今' : ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] };
    });
    return (
      <div style={{ maxWidth: '600px', margin: '0 auto', padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: '60px', marginBottom: '12px' }}>🔁</div>
        <h2 style={{ fontSize: '22px', marginBottom: '20px' }}>复习完成！本次复习了 {queue.length} 道题</h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', flexWrap: 'wrap', marginBottom: '24px' }}>
          <Stat label="已注册" value={all.length} />
          <Stat label="✅ 已掌握" value={mastered} color="var(--success)" />
          <Stat label="学习中" value={all.length - mastered} color="var(--warning)" />
          <Stat label="待复习" value={stillDue} color="var(--danger)" />
        </div>
        {/* forecast */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: '8px', height: '100px', marginBottom: '24px' }}>
          {forecast.map((f) => (
            <div key={f.iso} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '12px' }}>{f.count}</span>
              <div style={{ width: '24px', height: `${Math.min(80, f.count * 8 + 4)}px`, background: f.label === '今' ? 'var(--primary)' : 'var(--accent)', borderRadius: '4px 4px 0 0' }} />
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{f.label}</span>
            </div>
          ))}
        </div>
        <button onClick={onExit} style={{ ...btnPrimary, padding: '12px 32px' }}>返回列表</button>
      </div>
    );
  }

  if (!q) return null;

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '12px 16px calc(env(safe-area-inset-bottom, 0) + 24px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <button onClick={onExit} style={btnGhost}>← 返回</button>
        <div style={{ flex: 1, fontWeight: 600 }}>🔁 遗忘曲线复习 ({index + 1}/{queue.length})</div>
      </div>
      <div style={{ height: '4px', background: 'var(--border)', borderRadius: '2px', marginBottom: '16px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${((index + 1) / queue.length) * 100}%`, background: 'var(--danger)', transition: 'width 0.3s' }} />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px' }}>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: '5px', padding: '1px 6px', fontSize: '11px' }}>{q.difficulty}</span>
          {item && (
            <>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{getBoxLabel(item)}</span>
              {item.reps > 0 && <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>✓ 复习{item.reps}次</span>}
              {item.lapses > 0 && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>🔁 {item.lapses}次遗忘</span>}
            </>
          )}
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 12px' }}>{q.question}</h2>

        {!revealed ? (
          <button onClick={() => setRevealed(true)} style={{ ...btnPrimary, width: '100%', padding: '14px' }}>👁️ 点击查看答案 (空格键)</button>
        ) : (
          <>
            <QuestionContent q={q} showNotes={false} />
            <div style={{ display: 'flex', gap: '6px', marginTop: '16px' }}>
              {QUALITY_META.map((m) => {
                const base = item || store.ensureReview(q.id);
                const days = previewInterval(base, m.q);
                return (
                  <button key={m.q} onClick={() => rate(m.q)} style={{ ...btnGhost, flex: 1, padding: '12px 4px' }}>
                    <div style={{ fontSize: '20px' }}>{m.icon}</div>
                    <div style={{ fontSize: '12px', marginTop: '2px' }}>{m.label}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{formatInterval(days)}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}
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

const btnPrimary: React.CSSProperties = { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '14px' };
const btnGhost: React.CSSProperties = { background: 'var(--bg-soft)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '14px' };
