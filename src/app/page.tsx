import { getAllQuestions } from '@/lib/questions';
import HomeClient from '@/components/HomeClient';

export default function Page() {
  // Full questions are passed to the client so the modal can render the
  // complete answer without a runtime fetch. This is a static page, so all
  // answers are compiled into the HTML at build time.
  const questions = getAllQuestions();
  return <HomeClient questions={questions} />;
}
