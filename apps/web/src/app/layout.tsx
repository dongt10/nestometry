import type { ReactNode } from 'react';
import '../styles/globals.css';

export const metadata = {
  title: 'nestometry',
  description: 'source-backed dorm rooms for planning in 2d and 3d.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
