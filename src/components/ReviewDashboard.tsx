'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { ALGO_LABELS } from '@/lib/config';
import { isDue, isMastered } from '@/lib/algorithms';

interface Props {
  onStartReview: () => void;
}

const todayISO = () => new Date().toISOString().split('T')[0];

export default function ReviewDashboard({ onStartReview }: Props) {
  const reviewData = useStore((s) => s.reviewData);
  const algorithm = useStore((s) => s.reviewAlgorithm);

  const stats = useMemo(() => {
    const all = Object.values(reviewData);
    const due = all.filter(isDue).length;
    const mastered = all.filter(isMastered).length;
    const total = all.length;
    return { due, mastered, learning: total - mastered, total };
  }, [reviewData]);

  const hero = stats.due > 0 ? { icon: '🔔', title: `${stats.due} 道题需要复习`, clickable: true } : { icon: '✅', title: '今日复习已完成', clickable: false };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
      <div
        onClick={() => hero.clickable && onStartReview()}
        style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: hero.clickable ? 'pointer' : 'default' }}
      >
        <span style={{ fontSize: '24px' }}>{hero.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{hero.title}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            算法：{ALGO_LABELS[algorithm]} · 已掌握 {stats.mastered} / {stats.total}
          </div>
        </div>
      </div>
      {stats.total > 0 && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '2px' }}>
            <span>掌握进度</span>
            <span>{stats.mastered}/{stats.total} ({stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0}%)</span>
          </div>
          <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${stats.total > 0 ? (stats.mastered / stats.total) * 100 : 0}%`, background: 'var(--success)', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
    </div>
  );
}
