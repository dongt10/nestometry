import type { ReactNode } from 'react';
import '../styles/globals.css';

export const metadata = {
  title: 'Nestometry',
  description: 'Source-backed dorm rooms in 2D and 3D.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
