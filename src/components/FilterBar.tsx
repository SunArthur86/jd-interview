'use client';

interface Props {
  difficulty: string;
  onDifficulty: (d: string) => void;
  subcatGroups: [string, number][];
  subcategory: string;
  onSubcategory: (s: string) => void;
  tagCloud: { tag: string; n: number }[];
  selectedTags: string[];
  onToggleTag: (t: string) => void;
  onClearTags: () => void;
}

const chipBase: React.CSSProperties = {
  background: 'var(--bg-soft)',
  border: '1px solid var(--border)',
  borderRadius: '999px',
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: '12px',
  color: 'var(--text)',
};

export default function FilterBar({ difficulty, onDifficulty, subcatGroups, subcategory, onSubcategory, tagCloud, selectedTags, onToggleTag, onClearTags }: Props) {
  const diffs = ['all', 'L1', 'L2', 'L3', 'L4', 'L5'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '8px 0' }}>
      {/* difficulty */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', minWidth: '40px' }}>难度</span>
        {diffs.map((d) => (
          <button
            key={d}
            onClick={() => onDifficulty(d)}
            style={{
              ...chipBase,
              background: difficulty === d ? 'var(--primary)' : 'var(--bg-soft)',
              color: difficulty === d ? '#fff' : 'var(--text)',
              borderColor: difficulty === d ? 'var(--primary)' : 'var(--border)',
            }}
          >
            {d === 'all' ? '全部' : d}
          </button>
        ))}
      </div>

      {/* subcategory groups */}
      {subcatGroups.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', minWidth: '40px' }}>分组</span>
          <button
            onClick={() => onSubcategory('all')}
            style={{ ...chipBase, background: subcategory === 'all' ? 'var(--primary)' : 'var(--bg-soft)', color: subcategory === 'all' ? '#fff' : 'var(--text)', borderColor: subcategory === 'all' ? 'var(--primary)' : 'var(--border)' }}
          >
            全部
          </button>
          {subcatGroups.map(([g, n]) => (
            <button
              key={g}
              onClick={() => onSubcategory(g)}
              style={{
                ...chipBase,
                background: subcategory === g ? 'var(--primary)' : 'var(--bg-soft)',
                color: subcategory === g ? '#fff' : 'var(--text)',
                borderColor: subcategory === g ? 'var(--primary)' : 'var(--border)',
              }}
            >
              {g} ({n})
            </button>
          ))}
        </div>
      )}

      {/* tag cloud */}
      {tagCloud.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', minWidth: '40px' }}>标签</span>
          {tagCloud.map(({ tag, n }) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => onToggleTag(tag)}
                style={{
                  ...chipBase,
                  background: active ? 'var(--accent)' : 'var(--bg-soft)',
                  color: active ? '#fff' : 'var(--text)',
                  borderColor: active ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {tag} ({n})
              </button>
            );
          })}
          {selectedTags.length > 0 && (
            <button onClick={onClearTags} style={{ ...chipBase, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              ✕ 清除 ({selectedTags.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
