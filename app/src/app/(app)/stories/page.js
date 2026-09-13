import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PLATFORM_NAMES, dayRange, fmtNum, plural } from '../../../../lib/format.js';
import { PLATFORMS } from '../../../../lib/pricing.js';
import { requireSession } from '../../../../lib/session.js';
import { getFeed, getFeedCounts, getTotals } from '../../../../lib/stories.js';
import { listFollowing } from '../../../../lib/watchlist.js';
import FilterBar from '../../components/filter-bar.js';
import Icon from '../../components/icons.js';
import StoryCard from '../../components/story-card.js';
import { toggleSaveAction } from '../actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stories' };

const TABS = [
  { id: 'foryou', label: 'For you' },
  { id: 'all', label: 'All stories' },
  { id: 'saved', label: 'Saved' },
];

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function tabHref(tab, { q, platform }) {
  const params = new URLSearchParams({ tab });
  if (q) params.set('q', q);
  if (platform) params.set('platform', platform);
  return `/stories?${params}`;
}

function Empty({ tab, filtered, followingCount, total }) {
  let content;
  if (filtered) {
    content = { title: 'No stories match', text: 'Try a different search or platform.', actions: [{ href: `/stories?tab=${tab}`, label: 'Clear search', primary: true }] };
  } else if (tab === 'saved') {
    content = { title: 'Nothing saved yet', text: 'Use the bookmark on any story to keep it here.', actions: [{ href: '/stories?tab=all', label: 'Browse all stories', primary: true }] };
  } else if (tab === 'foryou' && !followingCount) {
    content = {
      title: 'Choose who to follow',
      text: 'Your stories come from the creators, subreddits and brands you follow. It takes a minute.',
      actions: [
        { href: '/following', label: 'Choose who to follow', primary: true },
        { href: '/stories?tab=all', label: 'Browse all stories' },
      ],
    };
  } else if (tab === 'foryou') {
    content = {
      title: 'Nothing from who you follow this week',
      text: `None of this week’s ${plural(total, 'story', 'stories')} involve them yet. Follow a few more, or browse everything.`,
      actions: [
        { href: '/stories?tab=all', label: 'Browse all stories', primary: true },
        { href: '/following', label: 'Follow more' },
      ],
    };
  } else {
    content = { title: 'No stories yet', text: 'Stories appear here once this week’s posts are collected and checked.', actions: [] };
  }
  return (
    <div className="empty">
      <h2>{content.title}</h2>
      <p>{content.text}</p>
      {content.actions.length ? (
        <div className="empty-actions">
          {content.actions.map((a) => (
            <Link key={a.href} href={a.href} className={`btn ${a.primary ? 'primary' : 'ghost'}`}>
              {a.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default async function StoriesPage({ searchParams }) {
  const session = await requireSession();
  if (!session.workspace.onboardedAt) redirect('/welcome');
  const workspaceId = session.workspace.id;
  const sp = await searchParams;
  const [following, counts, totals] = await Promise.all([listFollowing(workspaceId), getFeedCounts(workspaceId), getTotals()]);

  const follow = following.find((t) => t.id === sp.follow) ?? null;
  const tab = TABS.some((t) => t.id === sp.tab) ? sp.tab : following.length ? 'foryou' : 'all';
  const platform = PLATFORMS.includes(sp.platform) ? sp.platform : '';
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 80) : '';
  const scope = follow ? 'all' : tab === 'foryou' ? 'watchlist' : tab;
  const stories = await getFeed({ workspaceId, scope, platform, q, followTargetId: follow?.id ?? '' });

  const filtered = Boolean(platform || q);
  const strong = stories.filter((s) => !s.whyNotTop);
  const weak = stories.filter((s) => s.whyNotTop);
  const [main, more] = strong.length ? [strong, weak] : [weak, []];
  const firstName = (session.user.name ?? '').split(' ')[0];
  const tabCount = { foryou: counts.for_you, all: counts.total, saved: counts.saved };
  const title = follow ? follow.name : tab === 'foryou' ? 'Your stories' : tab === 'saved' ? 'Saved stories' : 'This week in AI & tech';

  return (
    <div className="page reading">
      <header className="home-head">
        <p className="hello">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </p>
        <h1>{title}</h1>
        <p className="home-sub">
          {follow
            ? `Stories this week that involve ${follow.name}.`
            : `${dayRange(totals.first_post_at, totals.last_post_at)} · ${fmtNum(totals.posts)} posts and ${fmtNum(totals.comments)} comments from six platforms, grouped into ${plural(counts.total, 'story', 'stories')}.`}
        </p>
      </header>

      {sp.welcome ? (
        <div className="welcomebar" role="status">
          <Icon name="check" size={18} />
          <p>
            <b>You’re set up.</b>{' '}
            {counts.for_you
              ? `${plural(counts.for_you, 'story', 'stories')} this week ${counts.for_you === 1 ? 'involves' : 'involve'} who you follow.`
              : 'None of this week’s stories involve your picks yet, so here’s everything.'}
          </p>
          <Link href="/following">Edit who you follow</Link>
        </div>
      ) : null}

      {follow ? (
        <p className="filterchip">
          <span>
            Showing stories involving <b>{follow.name}</b>
          </span>
          <Link href="/stories?tab=foryou" aria-label="Show all your stories">
            <Icon name="close" size={14} />
          </Link>
        </p>
      ) : (
        <div className="toolbar">
          <nav className="tabs" aria-label="Which stories">
            {TABS.map((t) => (
              <Link key={t.id} href={tabHref(t.id, { q, platform })} className={tab === t.id ? 'on' : undefined} aria-current={tab === t.id ? 'page' : undefined}>
                {t.label}
                <span className="tabcount">{tabCount[t.id]}</span>
              </Link>
            ))}
          </nav>
          <FilterBar tab={tab} q={q} platform={platform} platforms={PLATFORMS.map((p) => ({ id: p, name: PLATFORM_NAMES[p] }))} />
        </div>
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
        <Empty tab={follow ? 'all' : tab} filtered={filtered} followingCount={following.length} total={counts.total} />
      )}
    </div>
  );
}
