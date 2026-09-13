import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { getPlanState } from '../../../lib/accounts.js';
import { getBalance } from '../../../lib/credits.js';
import { fmtNum } from '../../../lib/format.js';
import { clerkConfigured, devPreviewEmail, requireSession } from '../../../lib/session.js';
import NavLinks from '../components/nav-links.js';
import SiteFooter from '../components/site-footer.js';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }) {
  const session = await requireSession();
  const [credits, plan] = await Promise.all([getBalance(session.workspace.id), getPlanState(session.workspace.id)]);
  const low = credits.available < plan.allowance * 0.2;
  const previewing = devPreviewEmail() === session.user.email;
  const links = [
    { href: '/feed', label: 'Feed' },
    { href: '/watchlist', label: 'Watchlist' },
    { href: '/reports', label: 'Reports' },
    { href: '/billing', label: 'Billing' },
    { href: '/settings', label: 'Settings' },
    ...(session.isAdmin ? [{ href: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <div className="appshell">
      <header className="appbar">
        <div className="appbar-in">
          <Link href="/feed" className="wordmark">
            Content-Story
          </Link>
          <NavLinks links={links} />
          <div className="appbar-end">
            <Link
              href="/billing"
              className={`credits${low ? ' low' : ''}`}
              title={`${fmtNum(credits.available)} credits available${credits.held ? `, ${fmtNum(credits.held)} held for reports` : ''}`}
            >
              <b>{fmtNum(credits.available)}</b> credits
            </Link>
            {previewing ? <span className="pill">dev preview</span> : clerkConfigured ? <UserButton /> : null}
          </div>
        </div>
        {low ? (
          <p className="lowbar">
            {fmtNum(credits.available)} credits left on {plan.name}. <Link href="/billing">Top up or choose a plan</Link> to keep your watchlist and reports running.
          </p>
        ) : null}
      </header>
      <div className="wrap">{children}</div>
      <SiteFooter />
    </div>
  );
}
