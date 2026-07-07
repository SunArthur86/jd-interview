interface Props {
  dist: Record<string, number>;
}

const COLORS: Record<string, string> = {
  L1: '#34c759',
  L2: '#007aff',
  L3: '#ff9500',
  L4: '#ff3b30',
  L5: '#af52de',
};

export default function DifficultyBars({ dist }: Props) {
  const levels = ['L1', 'L2', 'L3', 'L4', 'L5'];
  const max = Math.max(1, ...levels.map((l) => dist[l] || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '44px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '6px 10px' }}>
      {levels.map((l) => {
        const n = dist[l] || 0;
        const h = (n / max) * 100;
        return (
          <div key={l} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end', minWidth: '16px' }}>
            <div title={`${l}: ${n}题`} style={{ width: '10px', height: `${Math.max(2, h * 0.7)}px`, background: COLORS[l], borderRadius: '3px' }} />
            <span style={{ fontSize: '9px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}
