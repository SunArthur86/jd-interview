import type { Question } from './types';
import { useStore } from './store';
import { ALGO_LABELS } from './config';

function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/** Comprehensive progress export (merges old app.js + study.js exportProgress). */
export function exportProgress(questions: Question[]) {
  const store = useStore.getState();
  const ratings = store.ratings;
  const viewed = store.viewed;
  const favorites = store.favorites;
  const notes = store.notes;
  const reviewData = store.reviewData;
  const reviewed = Object.keys(reviewData).length;
  const mastered = Object.values(reviewData).filter((it) => {
    if (it.algo === 'leitner') return it.box >= 4;
    if (it.algo === 'ebbinghaus') return it.phase >= 5;
    return it.interval >= 21;
  }).length;

  const lines: string[] = [];
  lines.push('========== 学习进度报告 ==========');
  lines.push(`导出时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`题目总数: ${questions.length}`);
  lines.push(`已看: ${viewed.length} (${questions.length > 0 ? Math.round((viewed.length / questions.length) * 100) : 0}%)`);
  lines.push(`收藏: ${favorites.length}`);
  lines.push(`评分题数: ${Object.keys(ratings).length}`);
  lines.push(`已掌握 (复习算法): ${mastered} / ${reviewed}`);
  lines.push(`复习算法: ${ALGO_LABELS[store.reviewAlgorithm]}`);
  lines.push(`笔记数: ${Object.keys(notes).length}`);
  lines.push('');
  lines.push('========== 我的笔记 ==========');
  for (const [id, text] of Object.entries(notes)) {
    const q = questions.find((x) => x.id === id);
    lines.push(`\n【${id}】${q?.question || ''}`);
    lines.push(text);
  }

  const content = lines.join('\n');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(content).then(() => {}, () => download(`study-progress-${todayStr()}.txt`, content));
  } else {
    download(`study-progress-${todayStr()}.txt`, content);
  }
  // also export full JSON backup (favorites/viewed/ratings/notes/review)
  const backup = {
    favorites, viewed, ratings, notes, dailyLog: store.dailyLog, streak: store.streak,
    dailyGoal: store.dailyGoal, reviewData, reviewAlgorithm: store.reviewAlgorithm, exportDate: new Date().toISOString(),
  };
  download(`interview-jd-backup-${todayStr()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

/** Wrong-answer book export. */
export function exportWrongBook(questions: Question[]) {
  const ratings = useStore.getState().ratings;
  const wrong = questions.filter((q) => ratings[q.id] === 'dont' || ratings[q.id] === 'fuzzy');
  if (wrong.length === 0) return;
  const byCat: Record<string, Question[]> = {};
  for (const q of wrong) (byCat[q.category] = byCat[q.category] || []).push(q);
  const lines: string[] = [`错题本 - ${todayStr()}（共 ${wrong.length} 题）`, ''];
  for (const [cat, qs] of Object.entries(byCat)) {
    lines.push(`\n### ${cat} (${qs.length})`);
    for (const q of qs) {
      lines.push(`\n【${q.id}】${q.question} [${q.difficulty}]`);
      lines.push(q.answer.replace(/[#*`>]/g, '').slice(0, 150));
    }
  }
  lines.push('\n\n💡 建议优先攻克 L1-L2 的错题，结合遗忘曲线复习。');
  download(`错题本-${todayStr()}.txt`, lines.join('\n'));
}
