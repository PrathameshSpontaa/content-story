// The Stories page: a greeting, when stories last updated with a Refresh button, a tab for each watchlist
// and one for saved stories, the watchlist's tags as filters, search, and the story cards. Nobody sees
// another workspace's stories; a watchlist that follows nobody has none.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PLATFORM_NAMES, plural } from '../../../../lib/format.js';
import { PLATFORMS } from '../../../../lib/pricing.js';
import { getRefreshStatus } from '../../../../lib/refresh.js';
import { requireSession } from '../../../../lib/session.js';
import { getFeed, getFeedCounts } from '../../../../lib/stories.js';
import { listFollowing } from '../../../../lib/watchlist.js';
import { listWatchlists } from '../../../../lib/watchlists.js';
import FilterBar from '../../components/filter-bar.js';
import Icon from '../../components/icons.js';
import RefreshControl from '../../components/refresh-control.js';
import StoryCard from '../../components/story-card.js';
import { toggleSaveAction } from '../actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stories' };

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function storiesHref({ tab = '', w = '', tag = '', q = '', platform = '' } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ tab, w, tag, q, platform })) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `/stories?${qs}` : '/stories';
}

function Empty({ saved, filtered, clearHref, followingCount, watchlist }) {
  const edit = watchlist ? `/watchlists/${watchlist.id}` : '/watchlists';
  let content;
  if (filtered) {
    content = { title: 'No stories match', text: 'Try a different search, platform or tag.', action: { href: clearHref, label: 'Clear filters' } };
  } else if (saved) {
    content = { title: 'Nothing saved yet', text: 'Use the bookmark on any story to keep it here.', action: { href: '/stories', label: 'Back to your stories' } };
  } else if (!followingCount) {
    content = {
      title: 'Choose who to follow',
      text: 'Your stories are made only from the creators, subreddits and brands you follow. Follow a few to get your first stories.',
      action: { href: '/following', label: 'Choose who to follow' },
    };
  } else if (watchlist && !watchlist.follows) {
    content = {
      title: `Nobody in ${watchlist.name} yet`,
      text: 'Choose who this watchlist follows. Its stories are made from their posts.',
      action: { href: edit, label: 'Choose who’s in it' },
    };
  } else if (watchlist && !watchlist.tags.length) {
    content = {
      title: 'No tags yet',
      text: `Stories are only made when they fit one of the watchlist’s tags, like brand deals or breakouts. Add a few to ${watchlist.name}.`,
      action: { href: edit, label: 'Add tags' },
    };
  } else {
    content = {
      title: 'No stories yet',
      text: 'Stories appear once the latest posts from this watchlist are collected and read, and something fits one of its tags. Use Refresh to collect now, or change its tags.',
      action: { href: edit, label: 'Edit watchlist' },
    };
  }
  return (
    <div className="empty">
      <h2>{content.title}</h2>
      <p>{content.text}</p>
      <div className="empty-actions">
        <Link href={content.action.href} className="btn primary">
          {content.action.label}
        </Link>
      </div>
    </div>
  );
}

export default async function StoriesPage({ searchParams }) {
  const session = await requireSession();
  if (!session.workspace.onboardedAt) redirect('/welcome');
  const workspaceId = session.workspace.id;
  const sp = await searchParams;
  // Watchlists first: the first one is made here for a workspace that has none yet.
  const watchlists = await listWatchlists(workspaceId);
  // The refresh status only drives the freshness line; if it can't be read, the page still renders without it.
  const [following, counts, refreshStatus] = await Promise.all([
    listFollowing(workspaceId),
    getFeedCounts(workspaceId),
    getRefreshStatus(workspaceId).catch((err) => {
      console.error('[stories] refresh status:', err.message);
      return null;
    }),
  ]);

  const follow = following.find((t) => t.id === sp.follow) ?? null;
  const saved = !follow && sp.tab === 'saved';
  const watchlist = follow || saved ? null : (watchlists.find((w) => w.id === sp.w) ?? watchlists[0] ?? null);
  const tag = watchlist?.tags.find((t) => t.id === sp.tag) ?? null;
  const platform = PLATFORMS.includes(sp.platform) ? sp.platform : '';
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 80) : '';
  const stories = await getFeed({
    workspaceId,
    scope: saved ? 'saved' : 'following',
    watchlistId: watchlist?.id ?? '',
    tagId: tag?.id ?? '',
    platform,
    q,
    followTargetId: follow?.id ?? '',
  });

  const filtered = Boolean(platform || q || tag);
  const strong = stories.filter((s) => !s.whyNotTop);
  const weak = stories.filter((s) => s.whyNotTop);
  const [main, more] = strong.length ? [strong, weak] : [weak, []];
  const firstName = (session.user.name ?? '').split(' ')[0];
  const title = follow ? follow.name : saved ? 'Saved stories' : (watchlist?.name ?? 'Your stories');
  const here = { tab: saved ? 'saved' : '', w: watchlist && watchlist.id !== watchlists[0]?.id ? watchlist.id : '' };

  return (
    <div className="page reading">
      <header className="home-head">
        <p className="hello">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </p>
        <h1>{title}</h1>
        <RefreshControl initialStatus={refreshStatus} />
        {follow ? <p className="home-sub">Stories from your watchlists that involve {follow.name}.</p> : null}
        {watchlist ? (
          <p className="home-sub">
            {plural(watchlist.follows, 'follow')} · {watchlist.tags.length ? watchlist.tags.map((t) => t.name).join(', ') : 'no tags yet'} ·{' '}
            <Link href={`/watchlists/${watchlist.id}`}>Edit watchlist</Link>
          </p>
        ) : null}
      </header>

      {sp.welcome ? (
        <div className="welcomebar" role="status">
          <Icon name="check" size={18} />
          <p>
            <b>You’re set up.</b>{' '}
            {counts.for_you
              ? `${plural(counts.for_you, 'story', 'stories')} from who you follow.`
              : 'Your first stories are made from who you follow once their latest posts are collected. That can take a few minutes.'}
          </p>
          <Link href="/watchlists">Set up watchlists</Link>
        </div>
      ) : null}

      {follow ? (
        <p className="filterchip">
          <span>
            Showing <b>{follow.name}</b>
          </span>
          <Link href="/stories" aria-label="Show all your stories">
            <Icon name="close" size={14} />
          </Link>
        </p>
      ) : (
        <>
          <div className="toolbar">
            <nav className="tabs" aria-label="Watchlists">
              {watchlists.map((w, i) => {
                const on = watchlist?.id === w.id;
                return (
                  <Link key={w.id} href={storiesHref({ w: i ? w.id : '', q, platform })} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
                    {w.name}
                    <span className="tabcount">{counts.watchlists[w.id] ?? 0}</span>
                  </Link>
                );
              })}
              <Link href={storiesHref({ tab: 'saved', q, platform })} className={saved ? 'on' : undefined} aria-current={saved ? 'page' : undefined}>
                Saved
                <span className="tabcount">{counts.saved}</span>
              </Link>
            </nav>
            <FilterBar base={{ ...here, tag: tag?.id ?? '' }} q={q} platform={platform} platforms={PLATFORMS.map((p) => ({ id: p, name: PLATFORM_NAMES[p] }))} />
          </div>
          {watchlist?.tags.length ? (
            <nav className="tagfilter" aria-label="Tags">
              <Link href={storiesHref({ ...here, q, platform })} className={tag ? undefined : 'on'} aria-current={tag ? undefined : 'page'}>
                All
              </Link>
              {watchlist.tags.map((t) => (
                <Link key={t.id} href={storiesHref({ ...here, tag: t.id, q, platform })} className={tag?.id === t.id ? 'on' : undefined} aria-current={tag?.id === t.id ? 'page' : undefined} title={t.rule}>
                  {t.name}
                  <span className="tabcount">{counts.tags[t.id] ?? 0}</span>
                </Link>
              ))}
            </nav>
          ) : null}
        </>
      )}

      {stories.length ? (
        <>
          <div className="storylist">
            {main.map((s, i) => (
              <StoryCard key={s.id} story={s} variant={i === 0 && strong.length && !filtered && !follow ? 'lead' : 'full'} saveAction={toggleSaveAction} />
            ))}
          </div>
          {more.length ? (
            <section className="more-stories" aria-labelledby="more-h">
              <div className="listhead">
                <h2 id="more-h">More stories</h2>
                <p>One source so far, or not many comments yet.</p>
              </div>
              <div className="storylist">
                {more.map((s) => (
                  <StoryCard key={s.id} story={s} variant="compact" saveAction={toggleSaveAction} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <Empty saved={saved} filtered={filtered} clearHref={storiesHref(here)} followingCount={following.length} watchlist={watchlist} />
      )}
    </div>
  );
}
