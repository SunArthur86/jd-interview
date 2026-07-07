'use client';

import { useStore } from '@/lib/store';

const todayISO = () => new Date().toISOString().split('T')[0];

export default function StudyDashboard() {
  const dailyLog = useStore((s) => s.dailyLog);
  const streak = useStore((s) => s.streak);
  const dailyGoal = useStore((s) => s.dailyGoal);
  const ratings = useStore((s) => s.ratings);

  const today = dailyLog[todayISO()] || { studied: 0, know: 0, fuzzy: 0, dont: 0 };
  const allRatings = Object.values(ratings);
  const know = allRatings.filter((r) => r === 'know').length;
  const fuzzy = allRatings.filter((r) => r === 'fuzzy').length;
  const dont = allRatings.filter((r) => r === 'dont').length;
  const total = know + fuzzy + dont;
  const accuracy = total > 0 ? Math.round((know / total) * 100) : 0;
  const wrong = fuzzy + dont;
  const goalPct = dailyGoal > 0 ? Math.min(100, Math.round((today.studied / dailyGoal) * 100)) : 0;

  const cards = [
    { icon: '📅', label: '今日刷题', value: today.studied },
    { icon: '🔥', label: '连续天数', value: streak },
    { icon: '🎯', label: '掌握率', value: `${accuracy}%` },
    { icon: '📕', label: '错题本', value: wrong },
  ];

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        {cards.map((c) => (
          <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '20px' }}>{c.icon}</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '16px', fontWeight: 600 }}>{c.value}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{c.label}</span>
            </div>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: '120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '2px' }}>
            <span>{goalPct >= 100 ? '🏆' : '🎯'} 今日目标{goalPct >= 100 ? ' 已达成！' : ''}</span>
            <span>{today.studied}/{dailyGoal}</span>
          </div>
          <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${goalPct}%`, background: goalPct >= 100 ? 'var(--success)' : 'var(--primary)', transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
