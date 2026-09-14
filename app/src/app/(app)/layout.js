import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { getPlanState } from '../../../lib/accounts.js';
import { getBalance } from '../../../lib/credits.js';
import { fmtNum } from '../../../lib/format.js';
import { clerkConfigured, devPreviewEmail, requireSession } from '../../../lib/session.js';
import { listFollowing } from '../../../lib/watchlist.js';
import Brand from '../components/brand-mark.js';
import Face from '../components/face.js';
import NavLinks from '../components/nav-links.js';
import SiteFooter from '../components/site-footer.js';

export const dynamic = 'force-dynamic';

const SIDEBAR_FOLLOWS = 8;

export default async function AppLayout({ children }) {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [credits, plan, following] = await Promise.all([getBalance(workspaceId), getPlanState(workspaceId), listFollowing(workspaceId)]);
  const low = credits.available < plan.allowance * 0.2;
  const previewing = devPreviewEmail() === session.user.email;
  const shown = following.slice(0, SIDEBAR_FOLLOWS);

  const primary = [
    { href: '/stories', label: 'Stories', icon: 'stories' },
    { href: '/following', label: 'Following', icon: 'following', count: following.length || null },
    { href: '/reports', label: 'Reports', icon: 'reports' },
  ];
  const account = [
    { href: '/billing', label: 'Billing', icon: 'billing' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
    ...(session.isAdmin ? [{ href: '/admin', label: 'Admin', icon: 'admin' }] : []),
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand href="/stories" />
          <div className="me">
            <Link href="/billing" className={`mobile-credits${low ? ' low' : ''}`}>
              {fmtNum(credits.available)} credits
            </Link>
            {previewing ? (
              <span className="avatar sm t7" title={session.user.email}>
                PV
              </span>
            ) : clerkConfigured ? (
              <UserButton />
            ) : null}
          </div>
        </div>

        <NavLinks links={primary} label="Main" />

        <div className="side-follows">
          <p className="side-label">Following</p>
          {shown.length ? (
            <ul>
              {shown.map((t) => (
                <li key={t.id}>
                  <Link href={`/stories?follow=${t.id}`} title={`Stories involving ${t.name}`}>
                    <Face name={t.name} kind={t.kind} photo={t.photo} size="xs" />
                    <span>{t.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="side-empty">Follow creators and brands to build your stories.</p>
          )}
          <Link href="/following" className="side-more">
            {following.length > shown.length ? `See all ${following.length}` : shown.length ? 'Manage' : 'Choose who to follow'}
          </Link>
        </div>

        <div className="sidebar-foot">
          <Link href="/billing" className={`creditcard${low ? ' low' : ''}`}>
            <span className="cc-top">
              <span>Credits</span>
              <span>{plan.name}</span>
            </span>
            <b>{fmtNum(credits.available)}</b>
            <span className="cc-note">{low ? 'Running low · top up' : credits.held ? `${fmtNum(credits.held)} held for reports` : 'Top up any time'}</span>
          </Link>
          <NavLinks links={account} label="Account" className="navlist quiet" />
        </div>
      </aside>

      <div className="content">
        <main className="content-main">{children}</main>
        <SiteFooter />
      </div>
    </div>
  );
}
