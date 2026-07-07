'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { ALGO_LABELS } from '@/lib/config';
import { exportProgress, exportWrongBook } from '@/lib/exporters';
import { showToast } from './Toast';
import type { Algorithm, Question } from '@/lib/types';

interface Props {
  onClose: () => void;
  questions: Question[];
}

export default function SettingsPanel({ onClose, questions }: Props) {
  const store = useStore();
  const [confirmReset, setConfirmReset] = useState<null | 'progress' | 'review'>(null);

  const algos: Algorithm[] = ['sm2', 'leitner', 'ebbinghaus'];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9500, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '380px', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '17px' }}>⚙️ 设置</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'var(--text-tertiary)' }}>×</button>
        </div>

        <Section title="遗忘曲线算法">
          {algos.map((a) => (
            <button
              key={a}
              onClick={() => { store.setReviewAlgorithm(a); showToast(`已切换到 ${ALGO_LABELS[a]}`); }}
              style={optionStyle(store.reviewAlgorithm === a)}
            >
              {store.reviewAlgorithm === a ? '● ' : '○ '}{ALGO_LABELS[a]}
            </button>
          ))}
        </Section>

        <Section title="每日复习上限">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={() => store.setDailyReviewLimit(store.dailyReviewLimit - 5)} style={stepBtn}>−</button>
            <span style={{ minWidth: '40px', textAlign: 'center', fontWeight: 600 }}>{store.dailyReviewLimit}</span>
            <button onClick={() => store.setDailyReviewLimit(store.dailyReviewLimit + 5)} style={stepBtn}>+</button>
          </div>
        </Section>

        <Section title="今日目标">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={() => store.setDailyGoal(store.dailyGoal - 5)} style={stepBtn}>−</button>
            <span style={{ minWidth: '40px', textAlign: 'center', fontWeight: 600 }}>{store.dailyGoal}</span>
            <button onClick={() => store.setDailyGoal(store.dailyGoal + 5)} style={stepBtn}>+</button>
          </div>
        </Section>

        <Section title="复习提醒">
          <Toggle on={store.reviewNotification} onClick={() => {
            store.toggleReviewNotification();
            if (!store.reviewNotification && 'Notification' in window && Notification.permission === 'default') {
              Notification.requestPermission();
            }
          }} />
        </Section>

        <Section title="自动注册新题">
          <Toggle on={store.autoEnroll} onClick={() => store.toggleAutoEnroll()} />
        </Section>

        <Section title="导出">
          <button onClick={() => { exportProgress(questions); showToast('进度已导出'); }} style={{ ...actionBtn, display: 'block', marginBottom: '6px' }}>📤 导出学习进度 + 备份</button>
          <button onClick={() => { exportWrongBook(questions); showToast('错题本已导出'); }} style={{ ...actionBtn, display: 'block', marginBottom: '6px' }}>📕 导出错题本</button>
        </Section>

        <Section title="数据管理">
          {confirmReset === 'progress' ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => { store.resetProgress(); setConfirmReset(null); showToast('已看记录已清空'); }} style={{ ...actionBtn, color: 'var(--danger)' }}>确认清空已看</button>
              <button onClick={() => setConfirmReset(null)} style={actionBtn}>取消</button>
            </div>
          ) : confirmReset === 'review' ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => { store.resetReview(); setConfirmReset(null); showToast('复习数据已清空'); }} style={{ ...actionBtn, color: 'var(--danger)' }}>确认清空复习</button>
              <button onClick={() => setConfirmReset(null)} style={actionBtn}>取消</button>
            </div>
          ) : (
            <>
              <button onClick={() => setConfirmReset('progress')} style={{ ...actionBtn, display: 'block', marginBottom: '6px' }}>清空"已看"记录</button>
              <button onClick={() => setConfirmReset('review')} style={{ ...actionBtn, display: 'block', color: 'var(--danger)' }}>清空复习数据</button>
            </>
          )}
        </Section>

        <div style={{ marginTop: '24px', fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
          JD 面试题库 v1.0 · Next.js + Markdown
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>{title}</div>
      {children}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: '44px', height: '26px', borderRadius: '13px', background: on ? 'var(--success)' : 'var(--border-strong)', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s' }}>
      <span style={{ position: 'absolute', top: '3px', left: on ? '21px' : '3px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
    </button>
  );
}

const optionStyle = (active: boolean): React.CSSProperties => ({
  display: 'block', width: '100%', textAlign: 'left', background: active ? 'var(--bg-soft)' : 'transparent',
  border: active ? '1px solid var(--primary)' : '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px',
  cursor: 'pointer', color: 'var(--text)', fontSize: '13px', marginBottom: '6px',
});
const stepBtn: React.CSSProperties = { background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '16px', color: 'var(--text)' };
const actionBtn: React.CSSProperties = { background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', color: 'var(--text)', fontSize: '13px', width: '100%' };
