export interface Feynman {
  essence?: string;
  analogy?: string;
  key_points?: string[];
  first_principle?: string;
  socratic?: string[];
}
export interface FirstPrinciple {
  problem?: string;
  axioms?: string[];
  rebuild?: string;
}
export interface Question {
  id: string;
  question: string;
  answer: string;
  difficulty: string;
  category: string;
  categories: string[];
  subcategory?: string;
  tags: string[];
  images: string[];
  follow_up: string[];
  feynman?: Feynman;
  first_principle?: FirstPrinciple;
  memory_points?: string[];
  createdAt?: string;
}

export type Rating = 'know' | 'fuzzy' | 'dont';
export type Algorithm = 'sm2' | 'leitner' | 'ebbinghaus';

export interface ReviewItem {
  algo: Algorithm;
  ease: number;
  interval: number;
  reps: number;
  lapses: number;
  box: number;
  phase: number;
  nextDate: string;
  lastDate: string;
  createdAt: string;
  history: { d: string; q: number }[];
}
