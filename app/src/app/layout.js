import { ClerkProvider, UserButton } from '@clerk/nextjs';
import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const display = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '600', '700', '800'], variable: '--font-display' });
const serif = Newsreader({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-serif' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' });

export const metadata = {
  title: { default: 'Content-Story', template: '%s · Content-Story' },
  description: 'What creators and their audiences are saying about the same story, across platforms.',
  robots: { index: false, follow: false },
};

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout({ children }) {
  const shell = (
    <div className="wrap">
      <header className="topbar">
        <Link href="/" className="brand">
          Content-Story · preview
        </Link>
        <div className="topbar-actions">{publishableKey ? <UserButton /> : <span>sign-in not configured</span>}</div>
      </header>
      {children}
    </div>
  );

  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${mono.variable}`}>
      <body>{publishableKey ? <ClerkProvider publishableKey={publishableKey}>{shell}</ClerkProvider> : shell}</body>
    </html>
  );
}
