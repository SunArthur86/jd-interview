'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Rating, Algorithm, ReviewItem } from './types';
import { APP_CONFIG } from './config';
import { newItem } from './algorithms';

const P = APP_CONFIG.storagePrefix;
const todayISO = () => new Date().toISOString().split('T')[0];

interface DailyLog {
  studied: number;
  know: number;
  fuzzy: number;
  dont: number;
}

const LEGACY_KEYS: [string, string][] = [
  ['favorites', 'favorites'],
  ['viewed', 'viewed'],
  ['notes', 'notes'],
  ['ratings', 'ratings'],
  ['theme', 'theme'],
  ['sortOrder', 'sortOrder'],
  ['searchHistory', 'searchHistory'],
  ['dailyLog', 'dailyLog'],
  ['lastStudyDate', 'lastStudyDate'],
  ['streak', 'streak'],
  ['dailyGoal', 'dailyGoal'],
  ['reviewData', 'reviewData'],
  ['reviewAlgorithm', 'reviewAlgorithm'],
  ['dailyReviewLimit', 'dailyReviewLimit'],
  ['reviewNotification', 'reviewNotification'],
  ['autoEnroll', 'autoEnroll'],
];

/** Migrate the legacy per-field localStorage keys into the single zustand persist blob. */
function migrateLegacyStorage() {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(P)) return; // already merged
  const state: Record<string, unknown> = {};
  for (const [lk, sk] of LEGACY_KEYS) {
    const raw = localStorage.getItem(P + '.' + lk);
    if (raw == null) continue;
    try {
      state[sk] = JSON.parse(raw);
    } catch {
      state[sk] = raw;
    }
  }
  if (Object.keys(state).length) {
    localStorage.setItem(P, JSON.stringify({ state, version: 0 }));
  }
}

// Run migration at module load (synchronously, BEFORE the persist middleware
// hydrates the store) so legacy per-field keys are merged into the blob the
// store reads from. Executes only in the browser.
if (typeof window !== 'undefined') {
  migrateLegacyStorage();
}

interface AppState {
  favorites: string[];
  viewed: string[];
  notes: Record<string, string>;
  ratings: Record<string, Rating>;
  theme: 'light' | 'dark';
  sortOrder: 'easy-first' | 'hard-first' | 'newest-first' | 'oldest-first' | 'default';
  searchHistory: string[];
  dailyLog: Record<string, DailyLog>;
  lastStudyDate: string | null;
  streak: number;
  dailyGoal: number;
  reviewData: Record<string, ReviewItem>;
  reviewAlgorithm: Algorithm;
  dailyReviewLimit: number;
  reviewNotification: boolean;
  autoEnroll: boolean;
  _hasHydrated: boolean;

  toggleFavorite: (id: string) => void;
  isFavorite: (id: string) => boolean;
  markViewed: (id: string) => void;
  setNote: (id: string, text: string) => void;
  getNote: (id: string) => string;
  setRating: (id: string, r: Rating) => void;
  toggleTheme: () => void;
  setSortOrder: (o: AppState['sortOrder']) => void;
  addSearchHistory: (q: string) => void;
  clearSearchHistory: () => void;
  logStudy: (r: Rating, prev: Rating | undefined) => void;
  setDailyGoal: (n: number) => void;
  upsertReview: (id: string, it: ReviewItem) => void;
  ensureReview: (id: string) => ReviewItem;
  setReviewAlgorithm: (a: Algorithm) => void;
  setDailyReviewLimit: (n: number) => void;
  toggleReviewNotification: () => void;
  toggleAutoEnroll: () => void;
  resetProgress: () => void;
  resetReview: () => void;
  setHydrated: (b: boolean) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      favorites: [],
      viewed: [],
      notes: {},
      ratings: {},
      theme: 'light',
      sortOrder: 'easy-first',
      searchHistory: [],
      dailyLog: {},
      lastStudyDate: null,
      streak: 0,
      dailyGoal: 20,
      reviewData: {},
      reviewAlgorithm: 'sm2',
      dailyReviewLimit: 50,
      reviewNotification: true,
      autoEnroll: true,
      _hasHydrated: false,

      toggleFavorite: (id) =>
        set((s) => {
          const has = s.favorites.includes(id);
          return {
            favorites: has ? s.favorites.filter((x) => x !== id) : [...s.favorites, id],
          };
        }),
      isFavorite: (id) => get().favorites.includes(id),
      markViewed: (id) =>
        set((s) => (s.viewed.includes(id) ? s : { viewed: [...s.viewed, id] })),
      setNote: (id, text) =>
        set((s) => {
          const notes = { ...s.notes };
          if (!text.trim()) delete notes[id];
          else notes[id] = text;
          return { notes };
        }),
      getNote: (id) => get().notes[id] || '',
      setRating: (id, r) => set((s) => ({ ratings: { ...s.ratings, [id]: r } })),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setSortOrder: (o) => set({ sortOrder: o }),
      addSearchHistory: (q) =>
        set((s) => {
          const trimmed = q.trim();
          if (trimmed.length < 2) return s;
          const hist = [trimmed, ...s.searchHistory.filter((x) => x !== trimmed)].slice(0, 8);
          return { searchHistory: hist };
        }),
      clearSearchHistory: () => set({ searchHistory: [] }),
      logStudy: (r, prev) =>
        set((s) => {
          const t = todayISO();
          const log = { ...s.dailyLog };
          const day: DailyLog = log[t] ? { ...log[t] } : { studied: 0, know: 0, fuzzy: 0, dont: 0 };
          if (!prev || prev !== r) {
            day.studied += 1;
            day[r] = (day[r] || 0) + 1;
            if (prev && day[prev] > 0) day[prev] -= 1;
          }
          log[t] = day;
          let streak = s.streak;
          let lastStudyDate = s.lastStudyDate;
          if (lastStudyDate !== t) {
            const y = new Date();
            y.setDate(y.getDate() - 1);
            const yIso = y.toISOString().split('T')[0];
            streak = lastStudyDate === yIso ? streak + 1 : 1;
            lastStudyDate = t;
          }
          return { dailyLog: log, streak, lastStudyDate };
        }),
      setDailyGoal: (n) => set({ dailyGoal: Math.max(5, Math.min(200, n)) }),
      upsertReview: (id, it) =>
        set((s) => ({ reviewData: { ...s.reviewData, [id]: it } })),
      ensureReview: (id) => {
        const existing = get().reviewData[id];
        if (existing) return existing;
        const it = newItem(get().reviewAlgorithm);
        get().upsertReview(id, it);
        return it;
      },
      setReviewAlgorithm: (a) =>
        set((s) => {
          const rd = { ...s.reviewData };
          for (const k of Object.keys(rd)) rd[k] = { ...rd[k], algo: a };
          return { reviewAlgorithm: a, reviewData: rd };
        }),
      setDailyReviewLimit: (n) => set({ dailyReviewLimit: Math.max(5, Math.min(500, n)) }),
      toggleReviewNotification: () => set((s) => ({ reviewNotification: !s.reviewNotification })),
      toggleAutoEnroll: () => set((s) => ({ autoEnroll: !s.autoEnroll })),
      resetProgress: () => set({ viewed: [] }),
      resetReview: () => set({ reviewData: {} }),
      setHydrated: (b) => set({ _hasHydrated: b }),
    }),
    {
      name: P,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        favorites: s.favorites,
        viewed: s.viewed,
        notes: s.notes,
        ratings: s.ratings,
        theme: s.theme,
        sortOrder: s.sortOrder,
        searchHistory: s.searchHistory,
        dailyLog: s.dailyLog,
        lastStudyDate: s.lastStudyDate,
        streak: s.streak,
        dailyGoal: s.dailyGoal,
        reviewData: s.reviewData,
        reviewAlgorithm: s.reviewAlgorithm,
        dailyReviewLimit: s.dailyReviewLimit,
        reviewNotification: s.reviewNotification,
        autoEnroll: s.autoEnroll,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    }
  )
);

export { migrateLegacyStorage };
