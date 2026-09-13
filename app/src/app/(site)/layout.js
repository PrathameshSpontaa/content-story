import Link from 'next/link';
import { isSignedIn } from '../../../lib/session.js';
import Brand from '../components/brand-mark.js';
import SiteFooter from '../components/site-footer.js';

export default async function SiteLayout({ children }) {
  const signedIn = await isSignedIn();
  return (
    <div className="site">
      <header className="sitebar">
        <Brand href="/" />
        <nav className="sitenav" aria-label="Site">
          <Link href="/#how" className="hide-sm">
            How it works
          </Link>
          <Link href="/#pricing" className="hide-sm">
            Pricing
          </Link>
          {signedIn ? (
            <Link href="/stories" className="btn primary sm">
              Open your stories
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
