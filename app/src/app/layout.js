import { ClerkProvider } from '@clerk/nextjs';
import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import './globals.css';

const display = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '600', '700', '800'], variable: '--font-display' });
const serif = Newsreader({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-serif' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' });

export const metadata = {
  title: { default: 'Content-Story', template: '%s · Content-Story' },
  description: 'What creators and their audiences are saying about the same story, across X, YouTube, LinkedIn, Instagram, TikTok and Reddit.',
  robots: { index: false, follow: false },
};

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const clerkAppearance = { variables: { colorPrimary: '#141b24', borderRadius: '6px' } };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        {publishableKey ? (
          <ClerkProvider
            publishableKey={publishableKey}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/feed"
            signUpFallbackRedirectUrl="/feed"
            appearance={clerkAppearance}
          >
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
