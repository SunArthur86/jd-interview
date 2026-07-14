'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import type { Question } from '@/lib/types';
import { APP_CONFIG, getSubcatGroup } from '@/lib/config';
import { useStore } from '@/lib/store';
import QuestionCard from './QuestionCard';
import QuestionModal from './QuestionModal';
import SearchBar from './SearchBar';
import FilterBar from './FilterBar';
import ProgressRing from './ProgressRing';
import DifficultyBars from './DifficultyBars';
import CategoryTabs from './CategoryTabs';
import StudyDashboard from './StudyDashboard';
import ReviewDashboard from './ReviewDashboard';
import StudyMode from './StudyMode';
import ReviewMode from './ReviewMode';
import SettingsPanel from './SettingsPanel';
import ShortcutsHelp from './ShortcutsHelp';

const DIFF_ORDER: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };
const PAGE_SIZE = 48;

type View = 'list' | 'study' | 'review';

export default function HomeClient({ questions }: { questions: Question[] }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const store = useStore();
  const [view, setView] = useState<View>('list');
  const [studyMode, setStudyMode] = useState<'sequential' | 'random' | 'wrong-only'>('sequential');
  const [currentCategory, setCurrentCategory] = useState<string>('all');
  const [difficulty, setDifficulty] = useState<string>('all');
  const [subcategory, setSubcategory] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [renderedCount, setRenderedCount] = useState(PAGE_SIZE);
  const [modalId, setModalId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: questions.length };
    for (const q of questions) {
      for (const c of q.categories) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [questions]);

  // filter + sort
  const filtered = useMemo(() => {
    let list = questions;
    if (currentCategory !== 'all') {
      list = list.filter((q) => q.categories.includes(currentCategory));
    }
    if (difficulty !== 'all') {
      list = list.filter((q) => q.difficulty === difficulty);
    }
    if (subcategory !== 'all') {
      list = list.filter((q) => getSubcatGroup(q.subcategory) === subcategory);
    }
    if (selectedTags.length > 0) {
      list = list.filter((q) => selectedTags.every((t) => q.tags.includes(t)));
    }
    if (favOnly) {
      list = list.filter((q) => store.favorites.includes(q.id));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (item) =>
          item.question.toLowerCase().includes(q) ||
          item.tags.some((t) => t.toLowerCase().includes(q)) ||
          (item.subcategory || '').toLowerCase().includes(q) ||
          item.answer.toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (store.sortOrder === 'easy-first') {
      sorted.sort((a, b) => (DIFF_ORDER[a.difficulty] || 9) - (DIFF_ORDER[b.difficulty] || 9));
    } else if (store.sortOrder === 'hard-first') {
      sorted.sort((a, b) => (DIFF_ORDER[b.difficulty] || 0) - (DIFF_ORDER[a.difficulty] || 0));
    } else if (store.sortOrder === 'newest-first') {
      sorted.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } else if (store.sortOrder === 'oldest-first') {
      sorted.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    }
    return sorted;
  }, [questions, currentCategory, difficulty, subcategory, selectedTags, favOnly, searchQuery, store.favorites, store.sortOrder]);

  // difficulty distribution
  const diffDist = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const q of filtered) counts[q.difficulty] = (counts[q.difficulty] || 0) + 1;
    return counts;
  }, [filtered]);

  // tag cloud (top 20, scoped to current category)
  const tagCloud = useMemo(() => {
    const scoped = currentCategory === 'all' ? questions : questions.filter((q) => q.categories.includes(currentCategory));
    const counts: Record<string, number> = {};
    for (const q of scoped) for (const t of q.tags) counts[t] = (counts[t] || 0) + 1;
    return Object.entries(counts)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, n]) => ({ tag, n }));
  }, [questions, currentCategory]);

  const subcatGroups = useMemo(() => {
    const scoped = currentCategory === 'all' ? questions : questions.filter((q) => q.categories.includes(currentCategory));
    const counts: Record<string, number> = {};
    for (const q of scoped) {
      const g = getSubcatGroup(q.subcategory);
      counts[g] = (counts[g] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [questions, currentCategory]);

  useEffect(() => {
    setRenderedCount(PAGE_SIZE);
  }, [filtered]);

  // virtual scroll sentinel
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setRenderedCount((c) => Math.min(c + PAGE_SIZE, filtered.length));
        }
      },
      { rootMargin: '300px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [filtered.length]);

  const visible = filtered.slice(0, renderedCount);

  // modal navigation
  const modalIndex = modalId ? filtered.findIndex((q) => q.id === modalId) : -1;
  const openModal = useCallback((id: string) => setModalId(id), []);
  const closeModal = useCallback(() => setModalId(null), []);
  const navModal = useCallback(
    (dir: number) => {
      if (modalIndex < 0) return;
      const next = modalIndex + dir;
      if (next >= 0 && next < filtered.length) setModalId(filtered[next].id);
    },
    [modalIndex, filtered]
  );

  // deep link via hash
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/q=([^&]+)/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (questions.some((q) => q.id === id)) setModalId(id);
      }
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [questions]);

  useEffect(() => {
    if (modalId) {
      window.history.replaceState(null, '', `#q=${modalId}`);
    } else if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [modalId]);

  const randomQuestion = useCallback(() => {
    const pool = filtered.length ? filtered : questions;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) setModalId(pick.id);
  }, [filtered, questions]);

  // keyboard shortcuts (list view only)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (view !== 'list') return;
      if (e.key === '/' && !inField) {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      } else if (e.key === '?' && !inField) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if ((e.key === 'l' || e.key === 'L') && !inField && !modalId) {
        e.preventDefault();
        randomQuestion();
      } else if ((e.key === 'r' || e.key === 'R') && !inField && !modalId) {
        e.preventDefault();
        setView('review');
      } else if ((e.key === 's' || e.key === 'S') && !inField && !modalId) {
        e.preventDefault();
        setStudyMode('sequential');
        setView('study');
      } else if (/^[1-7]$/.test(e.key) && !inField && !modalId) {
        e.preventDefault();
        const cats = Object.keys(APP_CONFIG.categories);
        const idx = parseInt(e.key, 10);
        if (idx < cats.length) setCurrentCategory(cats[idx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, modalId, randomQuestion, store]);

  const sortOptions: { value: typeof store.sortOrder; label: string }[] = [
    { value: 'easy-first', label: '↑ 由浅入深' },
    { value: 'hard-first', label: '↓ 由深入浅' },
    { value: 'newest-first', label: '🕐 最新优先' },
    { value: 'oldest-first', label: '🕐 最旧优先' },
    { value: 'default', label: '↕ 默认' },
  ];

  if (view === 'study') {
    return <StudyMode pool={filtered} mode={studyMode} allQuestions={questions} onExit={() => setView('list')} />;
  }
  if (view === 'review') {
    return <ReviewMode allQuestions={questions} onExit={() => setView('list')} />;
  }

  const viewedCount = hydrated ? store.viewed.length : 0;
  const favCount = hydrated ? store.favorites.length : 0;

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '12px 16px calc(env(safe-area-inset-bottom, 0) + 24px)' }}>
      {/* top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '22px', fontWeight: 700, flex: 1, minWidth: '120px', letterSpacing: '-0.02em' }}>
          {APP_CONFIG.appIcon} {APP_CONFIG.appName}
        </div>
        <SearchBar
          value={searchQuery}
          onChange={(v) => {
            setSearchQuery(v);
            store.addSearchHistory(v);
          }}
          history={hydrated ? store.searchHistory : []}
          onClearHistory={() => store.clearSearchHistory()}
          onPickHistory={(h) => setSearchQuery(h)}
        />
        <select
          value={store.sortOrder}
          onChange={(e) => store.setSortOrder(e.target.value as typeof store.sortOrder)}
          title="排序"
          style={{ ...iconBtn, cursor: 'pointer', appearance: 'auto' }}
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button onClick={() => setFavOnly((v) => !v)} title="仅看收藏" style={iconBtnActive(favOnly)}>
          {favOnly ? '★' : '☆'}
        </button>
        <button onClick={() => store.toggleTheme()} title="切换主题" style={iconBtn}>
          {hydrated && store.theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button onClick={() => setShowSettings(true)} title="设置" style={iconBtn}>⚙️</button>
      </div>

      {/* mode buttons */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button
          onClick={() => { setStudyMode('sequential'); setView('study'); }}
          style={modeBtn('var(--success)')}
        >📖 顺序学习</button>
        <button
          onClick={() => { setStudyMode('random'); setView('study'); }}
          style={modeBtn('var(--accent)')}
        >🎲 随机学习</button>
        <button onClick={() => setView('review')} style={modeBtn('var(--danger)')}>🔁 遗忘复习</button>
      </div>

      <StudyDashboard />
      <ReviewDashboard onStartReview={() => setView('review')} />

      {/* category tabs */}
      <CategoryTabs
        categories={APP_CONFIG.categories}
        current={currentCategory}
        counts={categoryCounts}
        onChange={(c) => {
          setCurrentCategory(c);
          setSubcategory('all');
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '12px 0', flexWrap: 'wrap' }}>
        <ProgressRing viewed={viewedCount} total={questions.length} favorites={favCount} shown={filtered.length} onReset={() => store.resetProgress()} />
        <DifficultyBars dist={diffDist} />
      </div>

      <FilterBar
        difficulty={difficulty}
        onDifficulty={setDifficulty}
        subcatGroups={subcatGroups}
        subcategory={subcategory}
        onSubcategory={setSubcategory}
        tagCloud={tagCloud}
        selectedTags={selectedTags}
        onToggleTag={(t) =>
          setSelectedTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
        }
        onClearTags={() => setSelectedTags([])}
      />

      {visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🔍</div>
          没有找到匹配的题目
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '12px', marginTop: '14px' }}>
          {visible.map((q) => (
            <QuestionCard
              key={q.id}
              q={q}
              isFav={hydrated && store.favorites.includes(q.id)}
              isViewed={hydrated && store.viewed.includes(q.id)}
              rating={hydrated ? store.ratings[q.id] : undefined}
              highlight={searchQuery}
              onOpen={() => openModal(q.id)}
              onToggleFav={() => store.toggleFavorite(q.id)}
              onTagClick={(t) => setSearchQuery(t)}
            />
          ))}
        </div>
      )}

      {renderedCount < filtered.length && (
        <div ref={sentinelRef} style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
          滚动加载更多 · 已显示 {renderedCount} / {filtered.length} 题
        </div>
      )}

      {modalId && modalIndex >= 0 && (
        <QuestionModal
          q={filtered[modalIndex]}
          index={modalIndex}
          total={filtered.length}
          onPrev={() => navModal(-1)}
          onNext={() => navModal(1)}
          onClose={closeModal}
          onFollowUp={(text) => {
            closeModal();
            setSearchQuery(text);
          }}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} questions={questions} />}
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'var(--bg-soft)',
  border: '1px solid var(--border)',
  borderRadius: '999px',
  padding: '7px 12px',
  cursor: 'pointer',
  color: 'var(--text)',
  fontSize: '13px',
  fontWeight: 500,
  boxShadow: 'var(--shadow-sm)',
};
function iconBtnActive(active: boolean): React.CSSProperties {
  return { ...iconBtn, background: active ? 'var(--warning)' : 'var(--bg-soft)', color: active ? '#fff' : 'var(--text)', borderColor: active ? 'var(--warning)' : 'var(--border)' };
}
function modeBtn(color: string): React.CSSProperties {
  return {
    background: 'var(--bg-soft)',
    border: `1px solid ${color}`,
    color: 'var(--text)',
    borderRadius: '999px',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    boxShadow: 'var(--shadow-sm)',
  };
}
