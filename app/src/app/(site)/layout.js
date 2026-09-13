import Link from 'next/link';
import { isSignedIn } from '../../../lib/session.js';
import SiteFooter from '../components/site-footer.js';

export default async function SiteLayout({ children }) {
  const signedIn = await isSignedIn();
  return (
    <div className="site">
      <header className="sitebar">
        <Link href="/" className="wordmark">
          Content-Story
        </Link>
        <nav className="sitenav" aria-label="Site">
          <Link href="/#how">How it works</Link>
          <Link href="/#pricing">Pricing</Link>
          {signedIn ? (
            <Link href="/feed" className="btn primary sm">
              Open your feed
            </Link>
          ) : (
            <>
              <Link href="/sign-in">Sign in</Link>
              <Link href="/sign-up" className="btn primary sm">
                Start free
              </Link>
            </>
          )}
        </nav>
      </header>
      {children}
      <SiteFooter />
    </div>
  );
}
