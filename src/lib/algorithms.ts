import type { Algorithm, ReviewItem } from './types';

export const ALGO_PARAMS = {
  sm2: { initialEase: 2.5, minEase: 1.3 },
  leitner: { intervals: [1, 3, 7, 14, 30], maxBox: 4 },
  ebbinghaus: { intervals: [1, 2, 4, 7, 15, 30] },
};

// quality 0..3 -> SM-2 0..5 scale
const QMAP = [1, 3, 4, 5];

export function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

export function calcInterval(item: ReviewItem, quality: number): number {
  const algo = item.algo;
  if (algo === 'sm2') {
    const { minEase } = ALGO_PARAMS.sm2;
    const q5 = QMAP[quality];
    if (q5 < 3) return 1;
    const delta = 0.1 - (5 - q5) * (0.08 + (5 - q5) * 0.02);
    item.ease = Math.max(minEase, item.ease + delta);
    if (item.reps === 0) return 1;
    if (item.reps === 1) return 3;
    return Math.round(item.interval * item.ease);
  }
  if (algo === 'leitner') {
    const iv = ALGO_PARAMS.leitner.intervals;
    if (quality === 0) return iv[Math.max(0, item.box)];
    const nb = Math.min(ALGO_PARAMS.leitner.maxBox, item.box + 1);
    return iv[nb] ?? 30;
  }
  // ebbinghaus
  const iv = ALGO_PARAMS.ebbinghaus.intervals;
  if (quality === 0) return iv[0];
  const np = Math.min(iv.length - 1, item.phase + 1);
  return iv[np];
}

export function review(item: ReviewItem, quality: number): ReviewItem {
  const next: ReviewItem = { ...item, ease: item.ease, history: item.history.slice(-19) };
  let interval = calcInterval(next, quality);
  if (interval > 1) {
    interval = Math.max(1, Math.round(interval * (0.9 + Math.random() * 0.2)));
  }
  if (quality === 0) {
    next.lapses += 1;
    if (next.algo === 'leitner') next.box = Math.max(0, next.box - 1);
    if (next.algo === 'ebbinghaus') next.phase = 0;
  }
  next.interval = interval;
  next.reps += 1;
  next.lastDate = todayISO();
  next.nextDate = addDays(todayISO(), interval);
  next.history = [...next.history, { d: todayISO(), q: quality }].slice(-20);
  return next;
}

export function newItem(algo: Algorithm): ReviewItem {
  const today = todayISO();
  return {
    algo,
    ease: ALGO_PARAMS.sm2.initialEase,
    interval: 0,
    reps: 0,
    lapses: 0,
    box: 0,
    phase: 0,
    nextDate: today,
    lastDate: today,
    createdAt: today,
    history: [],
  };
}

export function isMastered(it: ReviewItem): boolean {
  if (it.algo === 'leitner') return it.box >= 4;
  if (it.algo === 'ebbinghaus') return it.phase >= 5;
  return it.interval >= 21;
}

export function isDue(it: ReviewItem): boolean {
  return it.nextDate <= todayISO();
}

/** Preview next interval without committing (for rating-button hints). */
export function previewInterval(item: ReviewItem, quality: number): number {
  return calcInterval({ ...item }, quality);
}

export function formatInterval(days: number): string {
  if (days <= 0 || days === 1) return '明天';
  if (days < 7) return `${days}天`;
  if (days < 30) return `${Math.round(days / 7)}周`;
  if (days < 365) return `${Math.round(days / 30)}个月`;
  return `${Math.round(days / 365)}年`;
}

export function getBoxLabel(it: ReviewItem): string {
  if (it.algo === 'leitner') return `📦 L${it.box + 1}`;
  if (it.algo === 'ebbinghaus') return `📈 第${it.phase + 1}轮`;
  return `E${it.ease.toFixed(1)}`;
}
