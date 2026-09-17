// One watchlist: its tags (what kinds of story it wants), who's in it, its name, and deleting it.
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { plural } from '../../../../../lib/format.js';
import { requireSession } from '../../../../../lib/session.js';
import { getFeedCounts } from '../../../../../lib/stories.js';
import { TAG_LIMITS, TAG_TEMPLATES } from '../../../../../lib/tags.js';
import { listFollowing } from '../../../../../lib/watchlist.js';
import { getWatchlist, listWatchlistNames } from '../../../../../lib/watchlists.js';
import ActionForm from '../../../components/action-form.js';
import Face from '../../../components/face.js';
import Icon from '../../../components/icons.js';
import SubmitButton from '../../../components/submit-button.js';
import {
  addTemplateTagAction,
  deleteWatchlistAction,
  followIntoWatchlistAction,
  removeTagAction,
  renameWatchlistAction,
  saveTagAction,
  saveWatchlistFollowsAction,
} from '../actions.js';

export const dynamic = 'force-dynamic';

const GROUPS = [
  { kind: 'creator', label: 'Creators' },
  { kind: 'community', label: 'Subreddits' },
  { kind: 'keyword', label: 'Brands and topics' },
];

export async function generateMetadata({ params }) {
  const { id } = await params;
  const session = await requireSession();
  const names = await listWatchlistNames(session.workspace.id);
  return { title: names.find((w) => w.id === id)?.name ?? 'Watchlist' };
}

function TagFields({ tag = null }) {
  return (
    <>
      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input name="name" defaultValue={tag?.name ?? ''} required minLength={2} maxLength={TAG_LIMITS.name} placeholder="e.g. Competitor launches" autoComplete="off" />
        </label>
        <label className="field">
          <span>A new story needs</span>
          <select name="minSources" defaultValue={String(tag?.minSources ?? 1)}>
            <option value="1">One post</option>
            <option value="2">Two sources, or one breakout post</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>
          What counts <small>the AI reads this as written</small>
        </span>
        <textarea
          name="rule"
          rows={3}
          defaultValue={tag?.rule ?? ''}
          required
          minLength={10}
          maxLength={TAG_LIMITS.rule}
          placeholder="e.g. A competitor of our client launches a product or runs a campaign with a creator."
        />
      </label>
    </>
  );
}

export default async function WatchlistPage({ params }) {
  const { id } = await params;
  const session = await requireSession();
  if (!session.workspace.onboardedAt) redirect('/welcome');
  const workspaceId = session.workspace.id;
  const watchlist = await getWatchlist(workspaceId, id);
  if (!watchlist) notFound();
  const [following, names, counts] = await Promise.all([listFollowing(workspaceId), listWatchlistNames(workspaceId), getFeedCounts(workspaceId)]);

  const nameOf = new Map(names.map((w) => [w.id, w.name]));
  const inList = new Set(watchlist.targetIds);
  const unused = TAG_TEMPLATES.filter((t) => !watchlist.tags.some((g) => g.template === t.key || g.name.toLowerCase() === t.name.toLowerCase()));
  const roomForTags = watchlist.tags.length < TAG_LIMITS.perWatchlist;
  const hidden = <input type="hidden" name="watchlistId" value={watchlist.id} />;

  return (
    <div className="page">
      <Link href="/watchlists" className="backlink">
        <Icon name="back" size={16} />
        Watchlists
      </Link>
      <header className="pagehead">
        <h1>{watchlist.name}</h1>
        <p>
          {plural(watchlist.follows, 'follow')} · {plural(counts.watchlists[watchlist.id] ?? 0, 'story', 'stories')} ·{' '}
          <Link href={`/stories?w=${watchlist.id}`}>See its stories</Link>
        </p>
      </header>

      <div className="split">
        <div className="stack">
          <section className="panel" aria-labelledby="tags-h">
            <h2 id="tags-h">Tags</h2>
            <p className="muted-note">
              The kinds of story this watchlist wants. A story is only made when it fits one of these. Changes apply from the next refresh; stories already made
              keep their tag.
            </p>
            {watchlist.tags.length ? null : <p className="notice info wl-gap">No tags, so no stories. Add one below.</p>}
            <div className="taglist">
              {watchlist.tags.map((t) => (
                <div key={t.id} className="tagrow">
                  <ActionForm action={saveTagAction} submitLabel="Save tag" resetOnSuccess={false} variant="ghost">
                    {hidden}
                    <input type="hidden" name="id" value={t.id} />
                    <TagFields tag={t} />
                  </ActionForm>
                  <form action={removeTagAction} className="tagrow-remove">
                    {hidden}
                    <input type="hidden" name="tagId" value={t.id} />
                    <SubmitButton className="btn ghost sm danger" pendingLabel="Removing…">
                      Remove {t.name}
                    </SubmitButton>
                  </form>
                </div>
              ))}
            </div>

            {roomForTags && unused.length ? (
              <div className="tag-templates">
                <p className="field-label">Add a ready-made tag</p>
                <div className="tag-template-list">
                  {unused.map((t) => (
                    <form key={t.key} action={addTemplateTagAction}>
                      {hidden}
                      <input type="hidden" name="template" value={t.key} />
                      <SubmitButton className="btn ghost sm" pendingLabel="Adding…" title={t.rule}>
                        <Icon name="plus" size={14} />
                        {t.name}
                      </SubmitButton>
                    </form>
                  ))}
                </div>
              </div>
            ) : null}

            {roomForTags ? (
              <details className="tag-new">
                <summary>Write your own tag</summary>
                <ActionForm action={saveTagAction} submitLabel="Add tag" pendingLabel="Adding…">
                  {hidden}
                  <TagFields />
                </ActionForm>
              </details>
            ) : (
              <p className="muted-note wl-gap">A watchlist can have up to {TAG_LIMITS.perWatchlist} tags.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="who-h">
            <h2 id="who-h">Who’s in it</h2>
            <p className="muted-note">Tick who this watchlist follows. Someone you untick who isn’t in another watchlist is unfollowed.</p>
            {following.length ? (
              <ActionForm action={saveWatchlistFollowsAction} submitLabel="Save who’s in it" resetOnSuccess={false} className="wl-gap">
                {hidden}
                {GROUPS.map((g) => {
                  const rows = following.filter((t) => t.kind === g.kind);
                  if (!rows.length) return null;
                  return (
                    <fieldset key={g.kind} className="field wl-members">
                      <legend>{g.label}</legend>
                      {rows.map((t) => {
                        const elsewhere = (t.watchlist_ids ?? []).filter((w) => w !== watchlist.id).map((w) => nameOf.get(w)).filter(Boolean);
                        return (
                          <label key={t.id} className="check wl-member">
                            <input type="checkbox" name="targetId" value={t.id} defaultChecked={inList.has(t.id)} />
                            <Face name={t.name} kind={t.kind} photo={t.photo} size="xs" />
                            <span>{t.name}</span>
                            {elsewhere.length ? <small>also in {elsewhere.join(', ')}</small> : null}
                          </label>
                        );
                      })}
                    </fieldset>
                  );
                })}
              </ActionForm>
            ) : (
              <p className="muted-note wl-gap">You don’t follow anyone yet.</p>
            )}
            <form action={followIntoWatchlistAction} className="wl-gap">
              {hidden}
              <SubmitButton className="btn ghost" pendingLabel="Opening…">
                <Icon name="plus" size={15} />
                Follow someone new for {watchlist.name}
              </SubmitButton>
            </form>
          </section>
        </div>

        <div className="stack">
          <section className="panel" aria-labelledby="name-h">
            <h2 id="name-h">Name</h2>
            <ActionForm action={renameWatchlistAction} submitLabel="Rename" resetOnSuccess={false} variant="ghost">
              {hidden}
              <label className="field">
                <span>Watchlist name</span>
                <input name="name" defaultValue={watchlist.name} required minLength={2} maxLength={60} autoComplete="off" />
              </label>
            </ActionForm>
          </section>

          {watchlist.watchlistCount > 1 ? (
            <section className="panel" aria-labelledby="delete-h">
              <h2 id="delete-h">Delete watchlist</h2>
              <p className="muted-note">
                Its stories leave your feed; ones you saved stay in Saved. Anyone who is only in this watchlist is unfollowed.
              </p>
              <form action={deleteWatchlistAction} className="form wl-gap">
                {hidden}
                <label className="check">
                  <input type="checkbox" name="confirm" required />
                  <span>Yes, delete {watchlist.name}</span>
                </label>
                <div className="form-foot">
                  <SubmitButton className="btn ghost danger" pendingLabel="Deleting…">
                    Delete watchlist
                  </SubmitButton>
                </div>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
