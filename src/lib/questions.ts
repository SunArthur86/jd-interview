import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import matter from 'gray-matter';
import type { Question } from './types';

const QUESTIONS_DIR = path.join(process.cwd(), 'questions');

/** 获取文件的最后 git 提交时间（ISO 字符串），git 不可用时回退到文件 mtime */
function getCreatedAt(filePath: string): string {
  try {
    const rel = path.relative(process.cwd(), filePath);
    const out = execSync(`git log -1 --format=%cI -- "${rel}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // git 不可用或文件未被跟踪，回退到 mtime
  }
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return '';
  }
}

function loadAll(): Question[] {
  if (!fs.existsSync(QUESTIONS_DIR)) return [];
  const out: Question[] = [];
  const catDirs = fs.readdirSync(QUESTIONS_DIR).sort();
  for (const catDir of catDirs) {
    const full = path.join(QUESTIONS_DIR, catDir);
    if (!fs.statSync(full).isDirectory()) continue;
    const files = fs.readdirSync(full).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const absPath = path.join(full, file);
      const raw = fs.readFileSync(absPath, 'utf-8');
      const { data, content } = matter(raw);
      const lines = content.split('\n');
      let question = '';
      let answerStart = 0;
      const firstNonEmpty = lines.findIndex((l) => l.trim() !== '');
      if (firstNonEmpty >= 0 && lines[firstNonEmpty].startsWith('# ')) {
        question = lines[firstNonEmpty].slice(2).trim();
        answerStart = firstNonEmpty + 1;
      }
      const answer = lines.slice(answerStart).join('\n').trim();
      const feynman = data.feynman || undefined;
      // 兼容两种第一性原理写法：顶层 first_principle 对象 或 feynman.first_principle 字符串
      const first_principle = data.first_principle ||
        (feynman && typeof feynman.first_principle === 'string'
          ? { problem: String(feynman.first_principle) }
          : undefined);
      out.push({
        id: String(data.id || file.replace(/\.md$/, '')),
        question,
        answer,
        difficulty: String(data.difficulty || 'L1'),
        category: String(data.category || catDir),
        categories: Array.isArray(data.categories)
          ? data.categories.map(String)
          : [String(data.category || catDir)],
        subcategory: data.subcategory || undefined,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        images: Array.isArray(data.images) ? data.images.map(String) : [],
        follow_up: Array.isArray(data.follow_up) ? data.follow_up.map(String) : [],
        feynman,
        first_principle,
        memory_points: Array.isArray(data.memory_points)
          ? data.memory_points.map(String)
          : [],
        createdAt: getCreatedAt(absPath),
      });
    }
  }
  return out;
}

let _cache: Question[] | null = null;

export function getAllQuestions(): Question[] {
  if (_cache) return _cache;
  _cache = loadAll();
  return _cache;
}

export function getQuestionById(id: string): Question | undefined {
  return getAllQuestions().find((q) => q.id === id);
}

export function getAllIds(): string[] {
  return getAllQuestions().map((q) => q.id);
}
