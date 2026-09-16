// Admin home: the story review queue, the report queue and every workspace.
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { REVIEW_FILTERS, adminOverview, listReportRuns, listStoriesForReview } from '../../../../lib/admin.js';
import { PLATFORM_NAMES, dayRange, fmtDay, fmtNum, fmtTime } from '../../../../lib/format.js';
import { REPORT_STATUS, listAllReports } from '../../../../lib/reports.js';
import { requireAdmin } from '../../../../lib/session.js';
import ActionForm from '../../components/action-form.js';
import { grantCreditsAction, publishAction, updateReportAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

// The same two links sit on every admin page.
function AdminNav({ current }) {
  return (
    <nav className="tabs admin-tabs" aria-label="Admin pages">
      <Link href="/admin" className={current === 'admin' ? 'on' : undefined}>
        Review and reports
      </Link>
      <Link href="/admin/runs" className={current === 'runs' ? 'on' : undefined}>
        Runs and spend
      </Link>
    </nav>
  );
}

const STORY_STATE = (s) => (s.status === 'merged' ? 'merged' : s.status === 'rejected' ? 'rejected' : s.published_at ? 'published' : 'waiting');

export default async function AdminPage({ searchParams }) {
  await requireAdmin();
  const { filter: rawFilter = 'all' } = await searchParams;
  const filter = REVIEW_FILTERS[rawFilter] ? rawFilter : 'all';
  const [{ totals, workspaces }, reports, stories, reportRuns] = await Promise.all([adminOverview(), listAllReports(), listStoriesForReview(filter), listReportRuns()]);
  const open = reports.filter((r) => ['queued', 'in_progress'].includes(r.status));
  const closed = reports.filter((r) => !open.includes(r));
  const published = stories.filter((s) => s.published_at);
  const waiting = stories.filter((s) => STORY_STATE(s) === 'waiting');

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Admin</h1>
        <p className="dek">Stories waiting for review, report requests, and every workspace. Only emails in ADMIN_EMAILS see this page.</p>
      </header>
      <AdminNav current="admin" />

      <dl className="stats five">
        <div>
          <dt>Waiting review</dt>
          <dd>{fmtNum(totals.waiting_review)}</dd>
        </div>
        <div>
          <dt>Open reports</dt>
          <dd>{fmtNum(totals.open_reports)}</dd>
        </div>
        <div>
          <dt>Failed runs, 7 days</dt>
          <dd>{fmtNum(totals.failed_runs)}</dd>
        </div>
        <div>
          <dt>Workspaces</dt>
          <dd>{fmtNum(totals.workspaces)}</dd>
        </div>
        <div>
          <dt>Credits outstanding</dt>
          <dd>{fmtNum(totals.credits_outstanding)}</dd>
        </div>
      </dl>

      <h2 className="sect">
        Story review <span>{waiting.length ? `${waiting.length} waiting, newest run first` : 'nothing waiting'}</span>
      </h2>
      <nav className="tabs" aria-label="Review filter">
        {Object.entries(REVIEW_FILTERS).map(([key, label]) => (
          <Link key={key} href={key === 'all' ? '/admin' : `/admin?filter=${key}`} className={filter === key ? 'on' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Story</th>
              <th className="num">Heat</th>
              <th>Coverage</th>
              <th>Latest version</th>
              <th>State</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {stories.map((s) => {
              const state = STORY_STATE(s);
              return (
                <tr key={s.id}>
                  <td>
                    <Link href={`/admin/stories/${s.id}`}>{s.headline ?? 'Untitled'}</Link>
                    <span className="sub">
                      {s.category ?? 'no category'} · {s.status}
                      {s.merge_candidates ? ` · ${s.merge_candidates} possible duplicate${s.merge_candidates > 1 ? 's' : ''}` : ''}
                    </span>
                  </td>
                  <td className="num">{s.heat ?? '—'}</td>
                  <td>
                    {fmtNum(s.sources ?? s.creators ?? 0)} sources · {fmtNum(s.creators ?? 0)} creators
                    <span className="sub">{fmtNum(s.post_count)} posts</span>
                  </td>
                  <td>
                    <span className={`status ${s.passed ? 'ready' : 'failed'}`}>
                      v{s.version} {s.passed ? 'passed' : 'failed'}
                    </span>
                    <span className="sub">
                      {s.error_count} errors · {s.warning_count} warnings · {fmtTime(s.version_at)}
                    </span>
                  </td>
                  <td>
                    <span className={`status ${state === 'published' ? 'ready' : state === 'waiting' ? 'queued' : state === 'rejected' ? 'failed' : ''}`}>{state}</span>
                    {s.reviewed_at ? <span className="sub">{s.reviewed_by_email ?? 'reviewed'} · {fmtDay(s.reviewed_at)}</span> : null}
                  </td>
                  <td className="actions">
                    {s.published_at ? (
                      <Link href={`/stories/${s.id}`} className="btn ghost sm">
                        View
                      </Link>
                    ) : null}
                    {state !== 'merged' ? (
                      <form action={publishAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="published" value={String(!s.published_at)} />
                        <button type="submit" className="btn ghost sm" disabled={!s.published_at && !s.has_passed_version}>
                          {s.published_at ? 'Unpublish' : 'Approve'}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {!stories.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  No stories here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Report queue <span>{open.length ? `${open.length} open, oldest first` : 'nothing waiting'}</span>
      </h2>
      {open.length ? (
        <div className="queue">
          {open.map((r) => {
            const run = reportRuns[r.id];
            return (
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
                  {run ? (
                    <p className="sub">
                      Run <Link href={`/admin/runs#run-${run.run_id}`}>{run.status}</Link>, started {fmtTime(run.started_at)}
                      {run.error ? ` · ${run.error}` : ''}
                    </p>
                  ) : null}
                  {r.story_id ? (
                    <p className="sub">
                      Story: <Link href={`/admin/stories/${r.story_id}`}>{r.story_headline ?? 'review it'}</Link>
                    </p>
                  ) : null}
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
            );
          })}
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
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((r) => {
                const run = reportRuns[r.id];
                return (
                  <tr key={r.id}>
                    <td>
                      <b>{r.query}</b>
                      <span className="sub">
                        {fmtDay(r.updated_at)}
                        {r.story_id ? (
                          <>
                            {' · '}
                            <Link href={`/admin/stories/${r.story_id}`}>{r.story_headline ?? 'story'}</Link>
                          </>
                        ) : null}
                      </span>
                    </td>
                    <td>{r.workspace_name}</td>
                    <td className="num">{r.charged != null ? fmtNum(r.charged) : '—'}</td>
                    <td>
                      <span className={`status ${r.status}`}>{REPORT_STATUS[r.status]}</span>
                    </td>
                    <td>{run ? <Link href={`/admin/runs#run-${run.run_id}`}>{run.status}</Link> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

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
