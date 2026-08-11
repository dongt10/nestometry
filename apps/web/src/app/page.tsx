import { Suspense } from 'react';
import { DormSelector } from '../components/DormSelector';

export default function HomePage() {
  // useSearchParams (inside DormSelector) requires a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<main className="app-stage" />}>
      <DormSelector />
    </Suspense>
  );
}
