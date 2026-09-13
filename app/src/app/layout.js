import { ClerkProvider } from '@clerk/nextjs';
import { Newsreader, Schibsted_Grotesk } from 'next/font/google';
import './globals.css';

const sans = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-sans' });
const serif = Newsreader({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-serif' });

export const metadata = {
  title: { default: 'Content-Story', template: '%s · Content-Story' },
  description: 'What creators and their audiences are saying about the same story, across X, YouTube, LinkedIn, Instagram, TikTok and Reddit.',
  robots: { index: false, follow: false },
};

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const clerkAppearance = { variables: { colorPrimary: '#0e1420', borderRadius: '8px', fontFamily: 'var(--font-sans), system-ui, sans-serif' } };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        {publishableKey ? (
          <ClerkProvider
            publishableKey={publishableKey}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/stories"
            signUpFallbackRedirectUrl="/welcome"
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
