// One workspace for an operator: account and members, credits with the full ledger and a grant form,
// payments, what it follows, its stories (following feed, saved, reports), its refreshes with what
// each cost, its spend in the last 30 days and the friends it referred.
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWorkspaceForAdmin } from '../../../../../../lib/admin.js';
import { PLATFORM_NAMES, fmtDay, fmtNum, fmtTime, plural } from '../../../../../../lib/format.js';
import { REPORT_STATUS } from '../../../../../../lib/reports.js';
import { requireAdmin } from '../../../../../../lib/session.js';
import ActionForm from '../../../../components/action-form.js';
import { grantCreditsAction } from '../../actions.js';
import AdminNav from '../../admin-nav.js';

export const dynamic = 'force-dynamic';
// A fixed title: metadata renders before the admin check, so it mustn't read the workspace.
export const metadata = { title: 'Workspace' };

const usd = (n) => `$${Number(n || 0).toFixed(n && n < 1 ? 3 : 2)}`;
const inr = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const duration = (s) => (s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const signed = (n) => `${n > 0 ? '+' : ''}${fmtNum(n)}`;
const platforms = (list) => (list ?? []).map((p) => PLATFORM_NAMES[p] ?? p).join(', ');

const FOLLOW_KIND = { creator: 'Creator', community: 'Subreddit', keyword: 'Brand or topic' };
const PAUSED = { out_of_credits: 'Paused: out of credits', paused_by_user: 'Paused by them' };
const REFRESH_REASON = { button: 'Refresh button', follow: 'After a follow' };
const REFRESH_CLASS = { done: 'ready', failed: 'failed', queued: 'queued', running: 'queued' };
const REFERRAL_STATUS = { joined: 'Joined', rewarded: 'Rewarded', capped: 'Joined (over the reward limit)' };

function Empty({ cols, children }) {
  return (
    <tr>
      <td colSpan={cols} className="muted">
        {children}
      </td>
    </tr>
  );
}

export default async function AdminWorkspacePage({ params }) {
  await requireAdmin();
  const { id } = await params;
  const w = await getWorkspaceForAdmin(id);
  if (!w) notFound();
  const sub = w.subscription;
  const planName = sub?.plan ?? 'Free trial';

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>{w.name}</h1>
        <p className="dek">
          {planName}
          {sub && sub.status !== 'active' ? ` (${sub.status.replace('_', ' ')})` : ''} · created {fmtDay(w.created_at)} · {plural(w.members.length, 'member')}
        </p>
      </header>
      <AdminNav />

      <dl className="stats">
        <div>
          <dt>Credits available</dt>
          <dd>{fmtNum(w.available)}</dd>
        </div>
        <div>
          <dt>Credits held</dt>
          <dd>{fmtNum(w.held)}</dd>
        </div>
        <div>
          <dt>Apify, last 30 days</dt>
          <dd>{usd(w.spend.apify)}</dd>
        </div>
        <div>
          <dt>AI, last 30 days</dt>
          <dd>
            {usd(w.spend.ai)} <small className="muted">{plural(w.spend.runs, 'run')}</small>
          </dd>
        </div>
      </dl>

      <div className="split">
        <section className="panel" aria-labelledby="account-h">
          <h2 id="account-h">Account</h2>
          <dl className="details">
            <div className="details-row">
              <dt>Plan</dt>
              <dd>
                {planName}
                {sub ? (
                  <span className="sub">
                    {sub.status.replace('_', ' ')}
                    {sub.current_period_end ? ` · period ends ${fmtDay(sub.current_period_end)}` : ''}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="details-row">
              <dt>Created</dt>
              <dd>{fmtTime(w.created_at)}</dd>
            </div>
            <div className="details-row">
              <dt>Set up</dt>
              <dd>{w.onboarded_at ? fmtTime(w.onboarded_at) : 'Not yet'}</dd>
            </div>
            <div className="details-row">
              <dt>Using it for</dt>
              <dd>{w.use_case ?? '—'}</dd>
            </div>
            <div className="details-row">
              <dt>Referral code</dt>
              <dd>{w.referral_code ?? '—'}</dd>
            </div>
            <div className="details-row">
              <dt>Referred by</dt>
              <dd>{w.referred_by ? <Link href={`/admin/workspaces/${w.referred_by.id}`}>{w.referred_by.name}</Link> : '—'}</dd>
            </div>
          </dl>
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="members-h">
            <h2 id="members-h">Members</h2>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {w.members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.email}
                        <span className="sub">
                          {m.name ? `${m.name} · ` : ''}joined {fmtDay(m.created_at)}
                        </span>
                      </td>
                      <td>{m.role}</td>
                    </tr>
                  ))}
                  {!w.members.length ? <Empty cols={2}>No members.</Empty> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" aria-labelledby="grant-h">
            <h2 id="grant-h">Add credits</h2>
            <ActionForm action={grantCreditsAction} submitLabel="Add credits" pendingLabel="Adding…">
              <input type="hidden" name="workspaceId" value={w.id} />
              <input type="hidden" name="nonce" value={randomUUID()} />
              <div className="field-row">
                <label className="field">
                  <span>Credits</span>
                  <input name="amount" type="number" min={1} max={100000} placeholder="500" required />
                </label>
                <label className="field">
                  <span>Reason</span>
                  <input name="note" maxLength={120} placeholder="Optional, shown in their ledger" />
                </label>
              </div>
            </ActionForm>
          </section>
        </div>
      </div>

      <h2 className="sect">
        Credit ledger{' '}
        <span>
          {w.ledger_count > w.ledger.length ? `newest ${fmtNum(w.ledger.length)} of ${fmtNum(w.ledger_count)}` : plural(w.ledger_count, 'entry', 'entries')}, newest first
        </span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th className="num">Credits</th>
              <th>Action</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {w.ledger.map((e) => (
              <tr key={e.id}>
                <td>{fmtTime(e.created_at)}</td>
                <td>{e.kind}</td>
                <td className={`num${e.amount > 0 ? ' plus' : ''}`}>{signed(e.amount)}</td>
                <td>{e.action ?? '—'}</td>
                <td>
                  {e.note ?? '—'}
                  {e.reference ? <span className="sub">{e.reference}</span> : null}
                </td>
              </tr>
            ))}
            {!w.ledger.length ? <Empty cols={5}>No credit entries.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Payments <span>{w.payments.length ? plural(w.payments.length, 'payment') : 'none yet'}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th className="num">Credits</th>
              <th>Invoice</th>
            </tr>
          </thead>
          <tbody>
            {w.payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtTime(p.created_at)}</td>
                <td>
                  {p.kind}
                  <span className="sub">{p.provider}</span>
                </td>
                <td>
                  <span className={`status ${p.status}`}>{p.status}</span>
                </td>
                <td className="num">
                  {inr(p.amount_paise)}
                  {p.tax_paise ? <span className="sub">{inr(p.tax_paise)} GST</span> : null}
                </td>
                <td className="num">{fmtNum(p.credits)}</td>
                <td>{p.invoice_number ?? '—'}</td>
              </tr>
            ))}
            {!w.payments.length ? <Empty cols={6}>No payments.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Following <span>{plural(w.follows.filter((t) => t.active).length, 'active follow')}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Kind</th>
              <th>Platforms</th>
              <th>State</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {w.follows.map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.kind === 'creator' ? (t.creator_name ?? 'Unknown creator') : t.query}</b>
                  {t.handles.length ? <span className="sub">{t.handles.map((h) => `${PLATFORM_NAMES[h.platform] ?? h.platform} ${h.handle}`).join(' · ')}</span> : null}
                </td>
                <td>{FOLLOW_KIND[t.kind] ?? t.kind}</td>
                <td>{platforms(t.platforms) || '—'}</td>
                <td>
                  {t.active ? (
                    <span className="status ready">Active</span>
                  ) : (
                    <span className="status">{PAUSED[t.paused_reason] ?? (t.paused_reason ? `Paused: ${t.paused_reason.replaceAll('_', ' ')}` : 'Paused')}</span>
                  )}
                </td>
                <td>{fmtDay(t.created_at)}</td>
              </tr>
            ))}
            {!w.follows.length ? <Empty cols={5}>Doesn’t follow anything.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Stories in its feed{' '}
        <span>
          {w.storyCount > w.stories.length ? `${fmtNum(w.stories.length)} of ${fmtNum(w.storyCount)}` : plural(w.storyCount, 'story', 'stories')}, built from what it follows
        </span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Story</th>
              <th>Status</th>
              <th>Published</th>
              <th className="num">Heat</th>
              <th>Last post</th>
            </tr>
          </thead>
          <tbody>
            {w.stories.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/admin/stories/${s.id}`}>{s.headline ?? 'Untitled'}</Link>
                  <span className="sub">{plural(s.post_count, 'post')}</span>
                </td>
                <td>{s.status}</td>
                <td>
                  {s.published_at ? (
                    fmtDay(s.published_at)
                  ) : s.passed === false && !['merged', 'rejected'].includes(s.status) ? (
                    <span className="err">No, checks failed</span>
                  ) : (
                    <span className="muted">No</span>
                  )}
                </td>
                <td className="num">{s.heat ?? '—'}</td>
                <td>{s.last_post_at ? fmtTime(s.last_post_at) : '—'}</td>
              </tr>
            ))}
            {!w.stories.length ? <Empty cols={5}>No stories in its feed yet.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Saved stories <span>{plural(w.saved.length, 'story', 'stories')}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Story</th>
              <th>Saved by</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {w.saved.map((s) => (
              <tr key={s.story_id}>
                <td>
                  <Link href={`/admin/stories/${s.story_id}`}>{s.headline ?? 'Untitled'}</Link>
                  <span className="sub">
                    {s.status}
                    {s.published_at ? '' : ' · not published'}
                  </span>
                </td>
                <td>{s.saved_by_email ?? '—'}</td>
                <td>{fmtTime(s.created_at)}</td>
              </tr>
            ))}
            {!w.saved.length ? <Empty cols={3}>Nothing saved.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Reports <span>{plural(w.reports.length, 'report')}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Requested by</th>
              <th>Status</th>
              <th className="num">Credits</th>
              <th>Story</th>
            </tr>
          </thead>
          <tbody>
            {w.reports.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.query}</b>
                  <span className="sub">{fmtTime(r.created_at)}</span>
                </td>
                <td>{r.requested_by_email ?? '—'}</td>
                <td>
                  <span className={`status ${r.status}`}>{REPORT_STATUS[r.status] ?? r.status}</span>
                </td>
                <td className="num">
                  {r.charged != null ? fmtNum(r.charged) : '—'}
                  <span className="sub">quoted {fmtNum(r.quoted_credits)}</span>
                </td>
                <td>{r.story_id ? <Link href={`/admin/stories/${r.story_id}`}>{r.story_headline ?? 'Open story'}</Link> : '—'}</td>
              </tr>
            ))}
            {!w.reports.length ? <Empty cols={5}>No reports.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Refreshes <span>{w.refreshes.length ? `last ${fmtNum(w.refreshes.length)}, newest first` : 'none yet'}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Asked</th>
              <th>Who</th>
              <th>Status</th>
              <th className="num">Took</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {w.refreshes.map((r) => (
              <tr key={r.id}>
                <td>
                  {fmtTime(r.created_at)}
                  <span className="sub">{REFRESH_REASON[r.reason] ?? r.reason}</span>
                </td>
                <td>{r.requested_by_email ?? '—'}</td>
                <td>
                  <span className={`status ${REFRESH_CLASS[r.status] ?? ''}`}>{r.status}</span>
                  {r.error ? <span className="sub err">{r.error}</span> : null}
                </td>
                <td className="num">{duration(r.seconds)}</td>
                <td className="num">
                  {r.run_id ? <Link href={`/admin/runs#run-${r.run_id}`}>{usd(r.usd)}</Link> : '—'}
                </td>
              </tr>
            ))}
            {!w.refreshes.length ? <Empty cols={5}>No refreshes.</Empty> : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Referrals made <span>{plural(w.referrals.length, 'friend')}</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Friend</th>
              <th>Status</th>
              <th>Joined</th>
              <th>Rewarded</th>
            </tr>
          </thead>
          <tbody>
            {w.referrals.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.workspace_id ? <Link href={`/admin/workspaces/${r.workspace_id}`}>{r.workspace_name}</Link> : 'Deleted workspace'}
                  <span className="sub">
                    {r.user_email ?? 'unknown email'} · code {r.code}
                  </span>
                </td>
                <td>{REFERRAL_STATUS[r.status] ?? r.status}</td>
                <td>{fmtDay(r.joined_at)}</td>
                <td>{r.rewarded_at ? fmtDay(r.rewarded_at) : '—'}</td>
              </tr>
            ))}
            {!w.referrals.length ? <Empty cols={4}>No referrals.</Empty> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
