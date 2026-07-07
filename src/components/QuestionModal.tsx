'use client';

import { useEffect, useCallback } from 'react';
import type { Question } from '@/lib/types';
import { APP_CONFIG } from '@/lib/config';
import { useStore } from '@/lib/store';
import QuestionContent from './QuestionContent';
import { showToast } from './Toast';

interface Props {
  q: Question;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onFollowUp: (text: string) => void;
}

export default function QuestionModal({ q, index, total, onPrev, onNext, onClose, onFollowUp }: Props) {
  const favorites = useStore((s) => s.favorites);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const markViewed = useStore((s) => s.markViewed);
  const isFav = favorites.includes(q.id);
  const basePath = process.env.NODE_ENV === 'production' ? '/jd-interview' : '';

  useEffect(() => {
    markViewed(q.id);
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [q.id, markViewed]);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowLeft') onPrev();
    else if (e.key === 'ArrowRight') onNext();
  }, [onClose, onPrev, onNext]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const handleCopy = () => {
    const text = `Q: ${q.question}\n\nA: ${q.answer.replace(/[#*`>]/g, '').slice(0, 2000)}\n\n来源: ${APP_CONFIG.githubUrl}`;
    navigator.clipboard?.writeText(text).then(() => showToast('答案已复制到剪贴板'));
  };

  const handleShare = () => {
    const url = `${window.location.origin}${basePath}/question/${q.id}/`;
    const essence = q.feynman?.essence ? `\n\n${q.feynman.essence.slice(0, 80)}` : '';
    const shareText = `${q.question}${essence}\n\n${url}`;
    if (navigator.share) {
      navigator.share({ title: q.question, text: shareText, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(shareText).then(() => showToast('分享链接已复制'));
    }
  };

  const handleReport = () => {
    const title = `[题目纠错] ${q.id} ${q.question.slice(0, 30)}`;
    const body = `**题目ID**: ${q.id}\n**题目**: ${q.question}\n**难度**: ${q.difficulty}\n\n**问题描述/建议**:\n\n`;
    window.open(`${APP_CONFIG.repoUrl}/issues/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent('题目纠错')}&body=${encodeURIComponent(body)}`, '_blank');
  };

  return (
    <div onClick={onClose} className="modal-overlay">
      <div onClick={(e) => e.stopPropagation()} className="modal-sheet">
        {/* Frosted header */}
        <div className="modal-header">
          <div className="modal-grabber" />
          <h2 className="modal-title">{q.question}</h2>
          <button onClick={onClose} aria-label="关闭" className="modal-close">×</button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <QuestionContent q={q} onFollowUp={onFollowUp} />
        </div>

        {/* Footer toolbar */}
        <div className="modal-footer">
          <div className="modal-actions">
            <button onClick={() => toggleFavorite(q.id)} className={`pill ${isFav ? 'pill-active' : ''}`}>
              {isFav ? '♥' : '♡'} {isFav ? '已收藏' : '收藏'}
            </button>
            <button onClick={handleCopy} className="pill">📋 复制</button>
            <button onClick={handleShare} className="pill">🔗 分享</button>
            <button onClick={handleReport} className="pill">🐛 纠错</button>
          </div>
          <div className="modal-nav">
            <button onClick={onPrev} disabled={index <= 0} className="nav-btn">‹</button>
            <span className="nav-pos">{index + 1} / {total}</span>
            <button onClick={onNext} disabled={index >= total - 1} className="nav-btn">›</button>
          </div>
        </div>
      </div>
      <style>{`
        .modal-overlay {
          position: fixed; inset: 0; z-index: 9000;
          background: rgba(0,0,0,0.4);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex; align-items: flex-end; justify-content: center;
          padding-top: 24px;
          animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .modal-sheet {
          background: var(--bg-soft);
          width: 100%; max-width: 800px;
          height: calc(100% - 24px);
          border-radius: var(--radius-xl) var(--radius-xl) 0 0;
          display: flex; flex-direction: column; overflow: hidden;
          box-shadow: var(--shadow-lg);
          animation: slideUp 0.28s cubic-bezier(0.32, 0.72, 0, 1);
          padding-bottom: env(safe-area-inset-bottom);
        }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .modal-header {
          display: flex; align-items: center; gap: 12px;
          padding: 14px 20px 12px;
          background: var(--bg-elevated);
          backdrop-filter: var(--blur);
          -webkit-backdrop-filter: var(--blur);
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
          position: relative;
        }
        .modal-grabber {
          position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
          width: 36px; height: 5px; border-radius: 3px;
          background: var(--border-strong);
        }
        .modal-title {
          margin: 0; font-size: 17px; font-weight: 600;
          flex: 1; padding-right: 8px;
          letter-spacing: -0.02em; line-height: 1.35;
        }
        .modal-close {
          background: var(--card-secondary); border: none;
          width: 30px; height: 30px; border-radius: 50%;
          font-size: 20px; line-height: 1; cursor: pointer;
          color: var(--text-secondary);
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .modal-close:hover { background: var(--border); }
        .modal-body { flex: 1; overflow-y: auto; padding: 20px 22px; }
        .modal-footer {
          flex-shrink: 0;
          background: var(--bg-elevated);
          backdrop-filter: var(--blur);
          -webkit-backdrop-filter: var(--blur);
          border-top: 1px solid var(--border);
          padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .modal-actions { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
        .pill {
          background: var(--card-secondary); color: var(--text);
          border: 1px solid var(--border); border-radius: 999px;
          padding: 7px 14px; font-size: 13px; cursor: pointer;
          font-weight: 500; white-space: nowrap;
        }
        .pill:hover { background: var(--border); }
        .pill-active { background: var(--danger); color: #fff; border-color: var(--danger); }
        .modal-nav { display: flex; align-items: center; gap: 4px; }
        .nav-btn {
          background: var(--card-secondary); color: var(--text);
          border: 1px solid var(--border); border-radius: 50%;
          width: 32px; height: 32px; font-size: 20px; line-height: 1;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
        }
        .nav-btn:hover:not(:disabled) { background: var(--primary-soft); color: var(--primary); }
        .nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .nav-pos { font-size: 13px; color: var(--text-tertiary); padding: 0 6px; font-variant-numeric: tabular-nums; }
        @media (max-width: 600px) {
          .modal-sheet { border-radius: var(--radius-xl) var(--radius-xl) 0 0; }
          .modal-body { padding: 16px; }
          .modal-footer { justify-content: center; }
          .modal-actions { width: 100%; justify-content: center; }
        }
      `}</style>
    </div>
  );
}
