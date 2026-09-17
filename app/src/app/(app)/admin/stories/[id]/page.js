// One story's review view: the latest version, its checks, version history, posts and merge
// candidates, with approve, reject, unpublish and merge forms.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { decidedBy, getStoryForReview, listStoriesForReview } from '../../../../../../lib/admin.js';
import { PLATFORM_NAMES as P, fmtDay, fmtNum, fmtTime, stripCites } from '../../../../../../lib/format.js';
import { requireAdmin } from '../../../../../../lib/session.js';
import ActionForm from '../../../../components/action-form.js';
import Icon from '../../../../components/icons.js';
import { mergeAction, reviewAction } from '../../actions.js';

export const dynamic = 'force-dynamic';

const text = (x) => (typeof x === 'string' ? x : JSON.stringify(x));

// Confidence arrives as 0–1; anything above 1 is already a percentage.
const sure = (c) => {
  const n = Number(c);
  if (c == null || !Number.isFinite(n)) return null;
  return `${Math.round(n > 1 ? n : n * 100)}% sure`;
};
const VERDICT_CLASS = { publish: 'ready', hold: 'queued', reject: 'failed' };
const FEED_KIND = { following: 'Following feed', reports: 'Reports feed' };

// The AI's call on a possible duplicate pair, from this story's side: `self` is this story's id.
function PairDecision({ c, self }) {
  const d = c.decision;
  if (!d) return <span className="sub">{c.resolved_at ? '' : 'No AI decision yet.'}</span>;
  const keepId = d.kept_id ?? (d.keep === 'a' ? c.story_a : d.keep === 'b' ? c.story_b : null);
  const keep = keepId ? (keepId === self ? 'keep this one' : 'keep the other') : '';
  return (
    <span className="sub verdict">
      AI: {d.same_story ? 'same story' : 'different stories'}
      {sure(d.confidence) ? ` · ${sure(d.confidence)}` : ''}
      {d.same_story && keep ? ` · ${keep}` : ''}
      {d.reason ? `: ${d.reason}` : ''}
      {d.resolved_by === 'human' ? (d.kept_separate ? ' · a person kept them separate' : ' · a person resolved it') : ''}
    </span>
  );
}

export async function generateMetadata({ params }) {
  const { id } = await params;
  const story = await getStoryForReview(id);
  return { title: story ? `Review: ${story.headline ?? 'Untitled'}` : 'Story not found' };
}

export default async function ReviewStoryPage({ params, searchParams }) {
  await requireAdmin();
  const [{ id }, { notice = '' }] = await Promise.all([params, searchParams]);
  const story = await getStoryForReview(id);
  if (!story) notFound();
  // Only stories in the same feed can be merged, so only those are offered.
  const all = await listStoriesForReview('all', { feedId: story.feed_id });
  const others = all.filter((s) => s.id !== story.id && !['merged', 'rejected'].includes(s.status));
  const edit = story.feed_edit ?? {};
  const checks = story.checks ?? {};
  const by = decidedBy(story);
  const state = story.status === 'merged' ? 'merged' : story.status === 'rejected' ? 'rejected' : story.published_at ? 'published' : by === 'human' ? 'unpublished' : 'needs you';
  const openCandidates = story.candidates.filter((c) => !c.resolved_at);
  const corrected = checks.corrected_quotes ?? checks.corrected ?? [];
  const hidden = checks.hidden_quotes ?? [];

  return (
    <div className="page wide">
      <Link href="/admin" className="backlink">
        <Icon name="back" size={16} /> Review queue
      </Link>
      {notice ? (
        <p role="status" className="notice info">
          {notice}
        </p>
      ) : null}

      <header className="pagehead review-head">
        <p className="sub">
          {story.feed_workspace_id ? (
            <>
              {FEED_KIND[story.feed_kind] ?? `Feed “${story.feed_name}”`} of <Link href={`/admin/workspaces/${story.feed_workspace_id}`}>{story.workspace_name ?? 'a workspace'}</Link>
            </>
          ) : (
            'Shared feed'
          )}{' '}
          · {story.category ?? 'no category'} · heat {story.heat ?? '—'} · {story.status}
          {story.merged_into ? (
            <>
              {' → '}
              <Link href={`/admin/stories/${story.merged_into}`}>{story.merged_into_headline ?? 'merged target'}</Link>
            </>
          ) : null}
        </p>
        <h1>{story.headline ?? 'Untitled'}</h1>
        {edit.dek ? <p className="dek">{edit.dek}</p> : null}
        <p className="btnrow">
          <span className={`status ${state === 'published' ? 'ready' : state === 'needs you' ? 'queued' : state === 'rejected' ? 'failed' : ''}`}>{state}</span>
          <span className={`status ${story.passed ? 'ready' : 'failed'}`}>
            v{story.version} {story.passed ? 'passed' : 'failed'}
          </span>
          {story.published_at ? (
            <Link href={`/stories/${story.id}`} className="btn ghost sm">
              Public page <Icon name="external" size={14} />
            </Link>
          ) : null}
        </p>
        {by === 'ai' ? (
          <p className="sub">
            Decided by <b className="by-ai">AI</b>
            {story.reviewed_at ? ` on ${fmtTime(story.reviewed_at)}` : ''}
            {story.review_note && !(story.editor && story.review_note.startsWith('AI: ')) ?` · ${story.review_note}` : ''}
            <span className="sub">Anything you do here overrides it, and the AI won’t change it back.</span>
          </p>
        ) : story.reviewed_at ? (
          <p className="sub">
            Reviewed by {story.reviewed_by_email ?? 'unknown'} on {fmtTime(story.reviewed_at)}
            {story.review_note ? ` · “${story.review_note}”` : ''}
          </p>
        ) : null}
        {story.editor ? (
          <p className="sub verdict">
            AI editor on v{story.version}: {story.editor.decision}
            {sure(story.editor.confidence) ? ` · ${sure(story.editor.confidence)}` : ''}
            {story.editor.reason ? ` · ${story.editor.reason}` : ''}
          </p>
        ) : null}
      </header>

      <div className="rgrid">
        <div className="page">
          <section className="panel">
            <h2>The story, version {story.version}</h2>
            <p>{(story.written?.narrative ?? []).map((s) => stripCites(s.sentence)).join(' ') || 'No narrative written.'}</p>
            {edit.platform_strip?.length ? (
              <ul className="howlist">
                {edit.platform_strip.map((s) => (
                  <li key={s.platform}>
                    <b>{P[s.platform] ?? s.platform}:</b> {s.gist}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="sub">
              {fmtNum(story.sources ?? 0)} sources · {fmtNum(story.creators ?? 0)} creators · {fmtNum(story.platforms ?? 0)} platforms · {fmtNum(story.post_count)} posts · run {fmtTime(story.version_at)}
            </p>
          </section>

          <section className="panel">
            <h2>
              Checks: {story.error_count} errors, {story.warning_count} warnings
            </h2>
            {story.error_count || story.warning_count || corrected.length || hidden.length ? (
              <ul className="checks">
                {(checks.errors ?? []).map((e, i) => (
                  <li key={`e${i}`} className="err">
                    Error: {text(e)}
                  </li>
                ))}
                {(checks.warnings ?? []).map((w, i) => (
                  <li key={`w${i}`} className="warn">
                    Warning: {text(w)}
                  </li>
                ))}
                {corrected.map((c, i) => (
                  <li key={`c${i}`}>Corrected quote: {text(c)}</li>
                ))}
                {hidden.map((h, i) => (
                  <li key={`h${i}`}>Hidden quote: {text(h)}</li>
                ))}
              </ul>
            ) : (
              <p className="muted-note">Every citation, quote and number matched the collected posts and comments.</p>
            )}
          </section>

          <section className="panel">
            <h2>Posts in this story ({story.posts.length})</h2>
            {story.posts.length ? (
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Post</th>
                      <th>Who</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {story.posts.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <a href={p.url} target="_blank" rel="noopener noreferrer">
                            {P[p.platform] ?? p.platform} {p.kind}
                          </a>
                          <span className="sub">{p.snippet}</span>
                        </td>
                        <td>
                          {p.creator ?? p.community ?? '—'}
                          <span className="sub">{p.handle ?? ''}</span>
                        </td>
                        <td>
                          {fmtTime(p.published_at)}
                          {p.reason ? <span className="sub">{p.reason}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted-note">No posts. If this story was merged, they moved to the target.</p>
            )}
          </section>

          <section className="panel">
            <h2>Versions</h2>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Run</th>
                    <th>Checks</th>
                    <th>AI editor</th>
                    <th>Models</th>
                  </tr>
                </thead>
                <tbody>
                  {story.versions.map((v) => (
                    <tr key={v.id}>
                      <td>v{v.version}</td>
                      <td>{fmtTime(v.created_at)}</td>
                      <td>
                        <span className={`status ${v.passed ? 'ready' : 'failed'}`}>{v.passed ? 'passed' : 'failed'}</span>
                        <span className="sub">
                          {v.error_count} errors · {v.warning_count} warnings
                        </span>
                      </td>
                      <td>
                        {v.editor ? (
                          <>
                            <span className={`status ${VERDICT_CLASS[v.editor.decision] ?? ''}`}>{v.editor.decision}</span>
                            <span className="sub">
                              {[sure(v.editor.confidence), v.editor.model].filter(Boolean).join(' · ')}
                              {v.editor.reason ? <span className="verdict-reason">{v.editor.reason}</span> : null}
                            </span>
                          </>
                        ) : (
                          <span className="sub">Not asked</span>
                        )}
                      </td>
                      <td className="summary">
                        {Object.entries(v.models ?? {})
                          .map(([k, m]) => `${k}: ${typeof m === 'string' ? m : (m?.model ?? text(m))}`)
                          .join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="page">
          {story.status !== 'merged' ? (
            <section className="panel">
              <h2>Decision</h2>
              {story.published_at ? (
                <ActionForm action={reviewAction} submitLabel="Unpublish" pendingLabel="Working…" variant="ghost" resetOnSuccess={false}>
                  <input type="hidden" name="id" value={story.id} />
                  <input type="hidden" name="decision" value="unpublish" />
                  <label className="field">
                    <span>Note</span>
                    <input name="note" maxLength={500} placeholder="Why (optional)" />
                  </label>
                </ActionForm>
              ) : (
                <ActionForm action={reviewAction} submitLabel="Approve and publish" pendingLabel="Publishing…" resetOnSuccess={false}>
                  <input type="hidden" name="id" value={story.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <label className="field">
                    <span>Note</span>
                    <input name="note" maxLength={500} placeholder="Optional" />
                  </label>
                  {!story.has_passed_version ? <p className="notice err">No version has passed the checks, so this can’t be published yet.</p> : null}
                </ActionForm>
              )}
              {story.status !== 'rejected' ? (
                <ActionForm action={reviewAction} submitLabel="Reject" pendingLabel="Rejecting…" variant="ghost danger" resetOnSuccess={false} className="mt">
                  <input type="hidden" name="id" value={story.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <label className="field">
                    <span>Reason</span>
                    <input name="note" maxLength={500} placeholder="Shown here only" />
                  </label>
                </ActionForm>
              ) : null}
            </section>
          ) : null}

          <section className="panel">
            <h2>Possible duplicates {openCandidates.length ? `(${openCandidates.length})` : ''}</h2>
            {story.candidates.length ? (
              <ul className="cands">
                {story.candidates.map((c) => (
                  <li key={c.other_id}>
                    <Link href={`/admin/stories/${c.other_id}`}>{c.other_headline ?? 'Untitled'}</Link>
                    <span className="sub">
                      {c.other_status} · heat {c.other_heat ?? '—'} · {c.other_published_at ? 'published' : 'not published'}
                      {c.reason ? ` · ${c.reason}` : ''}
                      {c.resolved_at ? ` · resolved ${fmtDay(c.resolved_at)}` : ''}
                    </span>
                    <PairDecision c={c} self={story.id} />
                    {!c.resolved_at && c.other_feed_id !== story.feed_id ? <span className="sub">In another feed, so it can’t be merged.</span> : null}
                    {!c.resolved_at && story.status !== 'merged' ? (
                      <form action={mergeAction} className="btnrow">
                        <input type="hidden" name="id" value={story.id} />
                        <input type="hidden" name="otherId" value={c.other_id} />
                        <button
                          type="submit"
                          name="decision"
                          value="merge_this_into_other"
                          className="btn ghost sm"
                          disabled={['merged', 'rejected'].includes(c.other_status) || c.other_feed_id !== story.feed_id}
                        >
                          Merge this into it
                        </button>
                        <button type="submit" name="decision" value="merge_other_into_this" className="btn ghost sm" disabled={c.other_status === 'merged' || c.other_feed_id !== story.feed_id}>
                          Merge it into this
                        </button>
                        <button type="submit" name="decision" value="keep_separate" className="btn ghost sm">
                          Keep separate
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-note">None flagged.</p>
            )}
            {story.status !== 'merged' && others.length ? (
              <form action={mergeAction} className="form mt">
                <input type="hidden" name="id" value={story.id} />
                <input type="hidden" name="decision" value="merge_this_into_other" />
                <label className="field">
                  <span>Merge this story into</span>
                  <select name="otherId" defaultValue="">
                    <option value="" disabled>
                      Pick a story
                    </option>
                    {others.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.headline ?? 'Untitled'} ({s.published_at ? 'published' : s.status})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Note</span>
                  <input name="note" maxLength={500} placeholder="Optional" />
                </label>
                <div className="form-foot">
                  <button type="submit" className="btn ghost">
                    Merge
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
