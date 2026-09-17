// Watchlists: each one's follows, tags and stories, and a form for a new one.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { plural } from '../../../../lib/format.js';
import { requireSession } from '../../../../lib/session.js';
import { getFeedCounts } from '../../../../lib/stories.js';
import { MAX_WATCHLISTS, listWatchlists } from '../../../../lib/watchlists.js';
import ActionForm from '../../components/action-form.js';
import { createWatchlistAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Watchlists' };

export default async function WatchlistsPage() {
  const session = await requireSession();
  if (!session.workspace.onboardedAt) redirect('/welcome');
  const workspaceId = session.workspace.id;
  const watchlists = await listWatchlists(workspaceId);
  const counts = await getFeedCounts(workspaceId);

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Watchlists</h1>
        <p>
          Group who you follow by client, campaign or interest. Each watchlist has its own tags, the kinds of story it wants, and its own stories. Someone can be in
          several watchlists and is collected once.
        </p>
      </header>

      <div className="wl-grid">
        {watchlists.map((w) => (
          <article key={w.id} className="panel wl-card">
            <h2>
              <Link href={`/watchlists/${w.id}`}>{w.name}</Link>
            </h2>
            <p className="muted-note">
              {plural(w.follows, 'follow')} · {plural(counts.watchlists[w.id] ?? 0, 'story', 'stories')}
            </p>
            {w.tags.length ? (
              <ul className="tagchips" aria-label="Tags">
                {w.tags.map((t) => (
                  <li key={t.id} className="tagchip" title={t.rule}>
                    {t.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-note">No tags yet, so no stories.</p>
            )}
            <div className="wl-actions">
              <Link href={`/stories?w=${w.id}`} className="btn ghost sm">
                See stories
              </Link>
              <Link href={`/watchlists/${w.id}`} className="btn ghost sm">
                Edit
              </Link>
            </div>
          </article>
        ))}

        {watchlists.length < MAX_WATCHLISTS ? (
          <section className="panel wl-card">
            <h2>New watchlist</h2>
            <ActionForm action={createWatchlistAction} submitLabel="Create watchlist" pendingLabel="Creating…">
              <label className="field">
                <span>Name</span>
                <input name="name" required minLength={2} maxLength={60} placeholder="e.g. boAt, Diwali campaign, AI creators" autoComplete="off" />
              </label>
            </ActionForm>
            <p className="muted-note">It starts with the tags for your kind of work. You choose who’s in it next.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
