// Admin home: the story review queue (an audit of what the AI editor and the checks published, held,
// rejected and merged across the shared feed and every workspace's following feed, with what still
// needs a person), the report queue and every workspace.
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import {
  REVIEW_FILTERS,
  adminOverview,
  decidedBy,
  listReportRuns,
  listStoriesForReview,
  listUnsureMergePairs,
  needsYouReason,
  reportStoryChoices,
  reviewCounts,
} from '../../../../lib/admin.js';
import { PLATFORM_NAMES, dayRange, fmtDay, fmtNum, fmtTime } from '../../../../lib/format.js';
import { REPORT_STATUS, listAllReports } from '../../../../lib/reports.js';
import { requireAdmin } from '../../../../lib/session.js';
import { getSettings } from '../../../../lib/settings.js';
import ActionForm from '../../components/action-form.js';
import { grantCreditsAction, pairAction, publishAction, rejectAction, updateReportAction } from './actions.js';
import AdminNav from './admin-nav.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

// Which feed a story is in: a workspace (linked to its admin page) or the old shared feed.
function FeedOf({ s }) {
  if (!s.feed_workspace_id) return 'Shared feed';
  return <Link href={`/admin/workspaces/${s.feed_workspace_id}`}>{s.workspace_name ?? 'A workspace'}</Link>;
}

const STORY_STATE = (s) => (s.status === 'merged' ? 'merged' : s.status === 'rejected' ? 'rejected' : s.published_at ? 'published' : decidedBy(s) === 'human' ? 'unpublished' : 'needs you');
const STATE_CLASS = { published: 'ready', 'needs you': 'queued', rejected: 'failed' };

// Confidence arrives as 0–1; anything above 1 is already a percentage.
const sure = (c) => {
  const n = Number(c);
  if (c == null || !Number.isFinite(n)) return null;
  return `${Math.round(n > 1 ? n : n * 100)}% sure`;
};

// Who made the last call on a story, and the AI's reasoning when it made it.
function Decision({ s, autoPublish }) {
  const by = decidedBy(s);
  const state = STORY_STATE(s);
  const editor = s.editor;
  const aiNote = by === 'ai' && s.review_note ? s.review_note.replace(/^AI( merged into [0-9a-f-]+)?:\s*/i, '') : '';
  return (
    <>
      <span className={`status ${STATE_CLASS[state] ?? ''}`}>{state}</span>
      <span className="sub">
        {by === 'ai' ? <b className="by-ai">AI</b> : by === 'human' ? <b>{s.reviewed_by_email ?? 'A person'}</b> : null}
        {!by && state === 'published' && s.feed_kind === 'following' ? 'Checks passed' : ''}
        {by && s.reviewed_at ? ` · ${fmtDay(s.reviewed_at)}` : ''}
        {state === 'needs you' ? `${by ? ' · ' : ''}${needsYouReason(s, { autoPublish })}` : ''}
        {state === 'merged' && s.merged_into ? (
          <>
            {' · into '}
            <Link href={`/admin/stories/${s.merged_into}`}>{s.merged_into_headline ?? 'another story'}</Link>
          </>
        ) : null}
      </span>
      {editor ? (
        <span className="sub verdict">
          AI said {editor.decision}
          {sure(editor.confidence) ? ` · ${sure(editor.confidence)}` : ''}
          {editor.reason ? `: ${editor.reason}` : ''}
        </span>
      ) : aiNote ? (
        <span className="sub verdict">{aiNote}</span>
      ) : null}
      {by === 'human' && s.review_note ? <span className="sub">“{s.review_note}”</span> : null}
    </>
  );
}

// The AI's verdict on a possible duplicate pair, in words.
function PairVerdict({ decision }) {
  if (!decision) return <span className="muted">No AI decision yet</span>;
  const keep = decision.keep === 'a' ? 'keep 1' : decision.keep === 'b' ? 'keep 2' : '';
  return (
    <>
      <b>{decision.same_story ? 'Same story' : 'Different stories'}</b>
      {sure(decision.confidence) ? ` · ${sure(decision.confidence)}` : ''}
      {decision.same_story && keep ? ` · would ${keep}` : ''}
      {decision.reason ? <span className="sub">{decision.reason}</span> : null}
    </>
  );
}

export default async function AdminPage({ searchParams }) {
  await requireAdmin();
  const { filter: rawFilter, notice = '' } = await searchParams;
  const settings = await getSettings();
  const [{ totals, workspaces }, reports, counts, pairs, reportRuns, storyChoices] = await Promise.all([
    adminOverview(),
    listAllReports(),
    reviewCounts(),
    listUnsureMergePairs({ minConfidence: settings.merge_min_confidence, autoMerge: settings.auto_merge }),
    listReportRuns(),
    reportStoryChoices(),
  ]);
  const filter = REVIEW_FILTERS[rawFilter] ? rawFilter : counts.needs ? 'needs' : 'ai_published';
  const stories = filter === 'pairs' ? [] : await listStoriesForReview(filter);
  const tabCount = { ...counts, pairs: pairs.length };
  const open = reports.filter((r) => ['queued', 'in_progress'].includes(r.status));
  const closed = reports.filter((r) => !open.includes(r));

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Admin</h1>
        <p className="dek">
          What the AI and the checks published, held and merged in the shared feed and every workspace’s feed, what needs you, report requests, and every workspace. Only emails in
          ADMIN_EMAILS see this page.
        </p>
      </header>
      <AdminNav current="admin" />

      <dl className="stats five">
        <div>
          <dt>Needs you</dt>
          <dd>{fmtNum(totals.needs_you + pairs.length)}</dd>
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
        Story review{' '}
        <span>
          {counts.needs || pairs.length
            ? [counts.needs ? `${fmtNum(counts.needs)} ${counts.needs === 1 ? 'story needs' : 'stories need'} you` : null, pairs.length ? `${fmtNum(pairs.length)} unsure merge${pairs.length === 1 ? '' : 's'}` : null]
                .filter(Boolean)
                .join(', ')
            : 'nothing needs you'}
          {' · '}AI publishing {settings.auto_publish ? 'on' : 'off'}, AI merging {settings.auto_merge ? 'on' : 'off'} (<Link href="/admin/settings">change</Link>)
        </span>
      </h2>
      {notice ? (
        <p role="status" className="notice info">
          {notice}
        </p>
      ) : null}
      <nav className="tabs" aria-label="Review filter">
        {Object.entries(REVIEW_FILTERS).map(([key, label]) => (
          <Link key={key} href={`/admin?filter=${key}`} className={filter === key ? 'on' : undefined} aria-current={filter === key ? 'page' : undefined}>
            {label}
            <span className="tabcount">{fmtNum(tabCount[key])}</span>
          </Link>
        ))}
      </nav>

      {filter === 'pairs' ? (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Possible duplicates</th>
                <th>AI decision</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={`${p.story_a}-${p.story_b}`}>
                  <td>
                    <ol className="pairlist">
                      <li>
                        <Link href={`/admin/stories/${p.story_a}`}>{p.a_headline ?? 'Untitled'}</Link>
                        <span className="sub">
                          {p.a_status} · heat {p.a_heat ?? '—'} · {p.a_published_at ? 'published' : 'not published'}
                        </span>
                      </li>
                      <li>
                        <Link href={`/admin/stories/${p.story_b}`}>{p.b_headline ?? 'Untitled'}</Link>
                        <span className="sub">
                          {p.b_status} · heat {p.b_heat ?? '—'} · {p.b_published_at ? 'published' : 'not published'}
                        </span>
                      </li>
                    </ol>
                    <span className="sub">
                      <FeedOf s={p} /> · Flagged {fmtTime(p.created_at)}
                      {p.reason ? ` · ${p.reason}` : ''}
                    </span>
                  </td>
                  <td>
                    <PairVerdict decision={p.decision} />
                  </td>
                  <td className="actions">
                    <form action={pairAction} className="btnrow pairbtns">
                      <input type="hidden" name="a" value={p.story_a} />
                      <input type="hidden" name="b" value={p.story_b} />
                      <button type="submit" name="decision" value="merge_a_into_b" className="btn ghost sm">
                        Merge 1 into 2
                      </button>
                      <button type="submit" name="decision" value="merge_b_into_a" className="btn ghost sm">
                        Merge 2 into 1
                      </button>
                      <button type="submit" name="decision" value="keep_separate" className="btn ghost sm">
                        Keep separate
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {!pairs.length ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No pairs need you. {settings.auto_merge ? `The AI merges pairs it is at least ${sure(settings.merge_min_confidence)} about.` : 'AI merging is off, so every new pair shows here.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Story</th>
                <th className="num">Heat</th>
                <th>Coverage</th>
                <th>Latest version</th>
                <th>Decision</th>
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
                        <FeedOf s={s} /> · {s.category ?? 'no category'} · {s.status}
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
                    <td className="decision">
                      <Decision s={s} autoPublish={settings.auto_publish} />
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
                      {!['merged', 'rejected'].includes(state) ? (
                        <form action={rejectAction}>
                          <input type="hidden" name="id" value={s.id} />
                          <button type="submit" className="btn ghost sm danger">
                            Reject
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
                    {filter === 'needs' ? 'Nothing needs you. The AI has decided every story.' : 'No stories here.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

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
                      {(storyChoices[r.id] ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.headline ?? 'Untitled'}
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
                  <Link href={`/admin/workspaces/${w.id}`}>{w.name}</Link>
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
