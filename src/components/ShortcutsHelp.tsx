'use client';

interface Props {
  onClose: () => void;
}

const SHORTCUTS: [string, string][] = [
  ['/', '搜索题目'],
  ['⌘/Ctrl + K', '聚焦搜索'],
  ['?', '显示/隐藏快捷键'],
  ['L', '随机一题'],
  ['R', '开始遗忘复习'],
  ['S', '开始顺序学习'],
  ['1-7', '切换分类'],
  ['← / →', '上一题 / 下一题（详情）'],
  ['Esc', '关闭弹窗'],
  ['空格 / Enter', '学习/复习中查看答案'],
  ['1-3', '学习评分：会了/模糊/不会'],
  ['1-4', '复习评分：忘了/模糊/记住/轻松'],
];

export default function ShortcutsHelp({ onClose }: Props) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '14px', padding: '20px', maxWidth: '400px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>⌨️ 快捷键</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '22px', cursor: 'pointer', color: 'var(--text-tertiary)' }}>×</button>
        </div>
        {SHORTCUTS.map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{desc}</span>
            <kbd style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: '5px', padding: '2px 8px', fontSize: '12px', fontFamily: 'monospace' }}>{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
