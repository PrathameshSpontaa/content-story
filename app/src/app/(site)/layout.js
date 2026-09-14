import { DM_Mono, Fraunces, Source_Serif_4 } from 'next/font/google';
import Link from 'next/link';
import { isSignedIn } from '../../../lib/session.js';
import SiteFooter from '../components/site-footer.js';

// The public site reads like a paper: Fraunces for headlines, Source Serif for text, DM Mono for
// the small print. The app keeps its own faces.
const display = Fraunces({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['SOFT', 'WONK', 'opsz'], variable: '--font-display' });
const body = Source_Serif_4({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['opsz'], variable: '--font-body' });
const mono = DM_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono-site' });

const dateline = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());

export default async function SiteLayout({ children }) {
  const signedIn = await isSignedIn();
  return (
    <div className={`site ${display.variable} ${body.variable} ${mono.variable}`}>
      <header className="mast">
        <div className="mast-in">
          <Link href="/" className="masthead">
            Content<em>-</em>Story
          </Link>
          <span className="mast-date hide-sm">{dateline()} · Beta edition</span>
          <nav className="mastnav" aria-label="Site">
            <Link href="/#story" className="hide-sm">
              This week
            </Link>
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
        </div>
      </header>
      {children}
      <SiteFooter />
    </div>
  );
}
