// Every user: their workspaces, credits, what they follow, their stories, saves, reports and
// refreshes, when they were last active, and the Apify and AI spend their workspace caused.
import Link from 'next/link';
import { listUsers } from '../../../../../lib/admin.js';
import { fmtAgo, fmtDay, fmtNum } from '../../../../../lib/format.js';
import { requireAdmin } from '../../../../../lib/session.js';
import AdminNav from '../admin-nav.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Users' };

const usd = (n) => (n ? `$${Number(n).toFixed(n < 1 ? 3 : 2)}` : '—');
const WEEK_MS = 7 * 86_400_000;

export default async function UsersPage() {
  await requireAdmin();
  const users = await listUsers(500);
  const now = Date.now();
  const within = (at) => at && now - new Date(at).getTime() < WEEK_MS;
  const newThisWeek = users.filter((u) => within(u.created_at)).length;
  const activeThisWeek = users.filter((u) => within(u.last_active_at)).length;
  const following = users.filter((u) => u.creators + u.communities + u.keywords > 0).length;

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Users</h1>
        <p className="dek">
          Everyone who signed up, newest first. Credits, follows, stories and spend are for their main workspace (the one they own); saves, reports, refreshes and last activity are their own.
          Spend is the last 30 days.
        </p>
      </header>
      <AdminNav current="users" />

      <dl className="stats">
        <div>
          <dt>Users</dt>
          <dd>{fmtNum(users.length)}</dd>
        </div>
        <div>
          <dt>New in the last 7 days</dt>
          <dd>{fmtNum(newThisWeek)}</dd>
        </div>
        <div>
          <dt>Active in the last 7 days</dt>
          <dd>{fmtNum(activeThisWeek)}</dd>
        </div>
        <div>
          <dt>Following something</dt>
          <dd>{fmtNum(following)}</dd>
        </div>
      </dl>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Workspace</th>
              <th className="num">Credits</th>
              <th className="num">Creators</th>
              <th className="num">Subreddits</th>
              <th className="num">Brands, topics</th>
              <th className="num">Stories in feed</th>
              <th className="num">Saved</th>
              <th className="num">Reports</th>
              <th className="num">Refreshes, 30 days</th>
              <th>Last active</th>
              <th className="num">Apify, 30 days</th>
              <th className="num">AI, 30 days</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.email}</b>
                  <span className="sub">
                    {u.name ? `${u.name} · ` : ''}joined {fmtDay(u.created_at)}
                  </span>
                </td>
                <td>
                  {u.workspaces.length ? (
                    u.workspaces.map((w) => (
                      <div key={w.id}>
                        <Link href={`/admin/workspaces/${w.id}`}>{w.name}</Link>
                        <span className="sub">{w.role}</span>
                      </div>
                    ))
                  ) : (
                    <span className="muted">No workspace</span>
                  )}
                </td>
                <td className="num">{u.workspace_id ? fmtNum(u.credits) : '—'}</td>
                <td className="num">{fmtNum(u.creators)}</td>
                <td className="num">{fmtNum(u.communities)}</td>
                <td className="num">{fmtNum(u.keywords)}</td>
                <td className="num">{fmtNum(u.stories)}</td>
                <td className="num">{fmtNum(u.saved)}</td>
                <td className="num">{fmtNum(u.reports)}</td>
                <td className="num">
                  {fmtNum(u.refreshes)}
                  {u.refreshes ? <span className="sub">{fmtNum(u.button_refreshes)} by button</span> : null}
                </td>
                <td>{u.last_active_at ? fmtAgo(u.last_active_at) : <span className="muted">Never</span>}</td>
                <td className="num">{usd(u.apify_usd)}</td>
                <td className="num">{usd(u.ai_usd)}</td>
              </tr>
            ))}
            {!users.length ? (
              <tr>
                <td colSpan={13} className="muted">
                  No users yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
