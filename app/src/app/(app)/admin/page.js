import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { adminOverview, listStoriesForReview } from '../../../../lib/admin.js';
import { PLATFORM_NAMES, dayRange, fmtDay, fmtNum } from '../../../../lib/format.js';
import { REPORT_STATUS, listAllReports } from '../../../../lib/reports.js';
import { requireAdmin } from '../../../../lib/session.js';
import ActionForm from '../../components/action-form.js';
import { grantCreditsAction, publishAction, updateReportAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

export default async function AdminPage() {
  await requireAdmin();
  const [{ totals, workspaces }, reports, stories] = await Promise.all([adminOverview(), listAllReports(), listStoriesForReview()]);
  const open = reports.filter((r) => ['queued', 'in_progress'].includes(r.status));
  const closed = reports.filter((r) => !open.includes(r));
  const published = stories.filter((s) => s.published_at);

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Admin</h1>
        <p className="dek">Report requests, the story review queue, and every workspace. Only emails in ADMIN_EMAILS see this page.</p>
      </header>

      <dl className="stats five">
        <div>
          <dt>Users</dt>
          <dd>{fmtNum(totals.users)}</dd>
        </div>
        <div>
          <dt>Workspaces</dt>
          <dd>{fmtNum(totals.workspaces)}</dd>
        </div>
        <div>
          <dt>Open reports</dt>
          <dd>{fmtNum(totals.open_reports)}</dd>
        </div>
        <div>
          <dt>Watchlist entries</dt>
          <dd>{fmtNum(totals.active_targets)}</dd>
        </div>
        <div>
          <dt>Credits outstanding</dt>
          <dd>{fmtNum(totals.credits_outstanding)}</dd>
        </div>
      </dl>

      <h2 className="sect">
        Report queue <span>{open.length ? `${open.length} open, oldest first` : 'nothing waiting'}</span>
      </h2>
      {open.length ? (
        <div className="queue">
          {open.map((r) => (
            <section className="panel qcard" key={r.id}>
              <div>
                <span className={`status ${r.status}`}>{REPORT_STATUS[r.status]}</span>
                <h3 className="qtitle">{r.query}</h3>
                <p className="sub">
                  {r.workspace_name} · {r.requested_by_email ?? 'unknown requester'} · requested {fmtDay(r.created_at)}
                </p>
                <p className="sub">
                  {dayRange(r.date_from, r.date_to)} · {r.platforms.map((p) => PLATFORM_NAMES[p]).join(', ')} · {fmtNum(r.quoted_credits)} credits held
                </p>
              </div>
              <ActionForm action={updateReportAction} submitLabel="Update report" pendingLabel="Updating…" resetOnSuccess={false}>
                <input type="hidden" name="id" value={r.id} />
                <label className="field">
                  <span>Status</span>
                  <select name="status" defaultValue={r.status === 'queued' ? 'in_progress' : 'ready'}>
                    <option value="in_progress">Being prepared</option>
                    <option value="ready">Ready (charge)</option>
                    <option value="failed">Couldn’t be made (release hold)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Credits used</span>
                  <input name="usedCredits" type="number" min={0} max={r.quoted_credits} placeholder={`up to ${r.quoted_credits}`} />
                </label>
                <label className="field wide">
                  <span>Finished story</span>
                  <select name="storyId" defaultValue={r.story_id ?? ''}>
                    <option value="">Not linked yet</option>
                    {published.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.headline}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field wide">
                  <span>Note to the customer</span>
                  <input name="note" maxLength={300} defaultValue={r.note ?? ''} placeholder="Optional, shown on their Reports page" />
                </label>
              </ActionForm>
            </section>
          ))}
        </div>
      ) : null}
      {closed.length ? (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Closed report</th>
                <th>Workspace</th>
                <th className="num">Charged</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.query}</b>
                    <span className="sub">{fmtDay(r.updated_at)}</span>
                  </td>
                  <td>{r.workspace_name}</td>
                  <td className="num">{r.charged != null ? fmtNum(r.charged) : '—'}</td>
                  <td>
                    <span className={`status ${r.status}`}>{REPORT_STATUS[r.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2 className="sect">
        Story review <span>{published.length} of {stories.length} published in the shared feed</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Story</th>
              <th className="num">Heat</th>
              <th>Checks</th>
              <th aria-label="Publish" />
            </tr>
          </thead>
          <tbody>
            {stories.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.published_at ? <Link href={`/stories/${s.id}`}>{s.headline}</Link> : <b>{s.headline}</b>}
                  <span className="sub">
                    {s.category} · version {s.version} · {s.published_at ? `published ${fmtDay(s.published_at)}` : 'not published'}
                  </span>
                </td>
                <td className="num">{s.heat ?? '—'}</td>
                <td>
                  <span className={`status ${s.has_passed_version ? 'ready' : 'failed'}`}>{s.has_passed_version ? 'passed' : 'failed'}</span>
                </td>
                <td className="actions">
                  <form action={publishAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="published" value={String(!s.published_at)} />
                    <button type="submit" className="btn ghost sm" disabled={!s.published_at && !s.has_passed_version}>
                      {s.published_at ? 'Unpublish' : 'Publish'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Workspaces <span>newest first</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Plan</th>
              <th className="num">Credits</th>
              <th className="num">Tracking</th>
              <th>Add credits</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => (
              <tr key={w.id}>
                <td>
                  <b>{w.name}</b>
                  <span className="sub">
                    {w.owners ?? 'no owner'} · since {fmtDay(w.created_at)}
                  </span>
                </td>
                <td>{w.plan ?? 'Free trial'}</td>
                <td className="num">
                  {fmtNum(w.balance - w.held)}
                  {w.held ? <span className="sub">{fmtNum(w.held)} held</span> : null}
                </td>
                <td className="num">{fmtNum(w.tracking)}</td>
                <td className="inline-grant">
                  <ActionForm action={grantCreditsAction} submitLabel="Add" pendingLabel="Adding…" variant="ghost sm">
                    <input type="hidden" name="workspaceId" value={w.id} />
                    <input type="hidden" name="nonce" value={randomUUID()} />
                    <label className="field">
                      <span className="sr">Credits</span>
                      <input name="amount" type="number" min={1} max={100000} placeholder="500" required />
                    </label>
                    <label className="field">
                      <span className="sr">Note</span>
                      <input name="note" maxLength={120} placeholder="Reason (optional)" />
                    </label>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
