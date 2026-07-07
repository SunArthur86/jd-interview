import { getAllQuestions, getQuestionById } from '@/lib/questions';
import { APP_CONFIG } from '@/lib/config';
import { notFound } from 'next/navigation';
import QuestionContent from '@/components/QuestionContent';
import type { Metadata } from 'next';

export function generateStaticParams() {
  return getAllQuestions().map((q) => ({ id: q.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const q = getQuestionById(id);
  if (!q) return { title: 'JD 面试题库' };
  return {
    title: `${q.question} - JD 面试题库`,
    description: q.feynman?.essence || q.answer.slice(0, 120).replace(/[#*`>]/g, ''),
    openGraph: { title: q.question, description: q.feynman?.essence || '' },
  };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = getQuestionById(id);
  if (!q) notFound();
  const catCfg = APP_CONFIG.categories[q.category] || APP_CONFIG.categories['all'];
  return (
    <main style={{ maxWidth: '760px', margin: '0 auto', padding: '16px', minHeight: '100vh' }}>
      <a
        href="../../"
        style={{ display: 'inline-block', marginBottom: '12px', color: 'var(--primary)', fontSize: '14px', textDecoration: 'none' }}
      >
        ← 返回题库
      </a>
      <h1 style={{ fontSize: '22px', fontWeight: 600, margin: '0 0 4px' }}>
        <span style={{ marginRight: '6px' }}>{catCfg.icon}</span>
        {q.question}
      </h1>
      <QuestionContent q={q} />
    </main>
  );
}
