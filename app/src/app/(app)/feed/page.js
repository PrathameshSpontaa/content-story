import Link from 'next/link';
import { HEAT_HELP, PLATFORM_NAMES, dayRange, fmtNum, plural } from '../../../../lib/format.js';
import { PLATFORMS } from '../../../../lib/pricing.js';
import { requireSession } from '../../../../lib/session.js';
import { TOP, getCategories, getFeed, getTotals } from '../../../../lib/stories.js';
import { listTargets } from '../../../../lib/watchlist.js';
import { toggleSaveAction } from '../actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Feed' };

const SCOPES = [
  { id: 'all', label: 'All stories' },
  { id: 'watchlist', label: 'From your watchlist' },
  { id: 'saved', label: 'Saved' },
];

function feedHref(current, change) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...change })) {
    if (value && !(key === 'scope' && value === 'all')) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/feed?${qs}` : '/feed';
}

function coverage(story) {
  const communities = Math.max(0, (story.sources ?? story.creators) - story.creators);
  return [
    story.creators ? plural(story.creators, 'creator') : null,
    communities ? plural(communities, 'community', 'communities') : null,
    plural(story.platforms, 'platform'),
    story.audience ? plural(story.audience, 'comment') : 'no comments collected',
  ]
    .filter(Boolean)
    .join(' · ');
}

function StoryCard({ story, compact = false }) {
  return (
    <article className={`story${compact ? ' compact' : ''}`}>
      <div>
        <p className="eyebrow">
          <span className="mc">{story.main_character}</span> · {story.category} · {dayRange(story.first_post_at, story.last_post_at)}
          {compact && story.whyNotTop ? <span className="why">{story.whyNotTop}</span> : null}
        </p>
        <h3>
          <Link href={`/stories/${story.id}`}>{story.headline}</Link>
        </h3>
        {!compact && story.dek ? <p className="dek">{story.dek}</p> : null}
        {!compact && story.platform_strip.length ? (
          <ul className="strip">
            {story.platform_strip.map((s) => (
              <li key={s.platform}>
                <b>{PLATFORM_NAMES[s.platform] ?? s.platform}</b>
                <span>{s.gist}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="cov">
          {coverage(story)}
          {story.tracked.length ? <span className="tracked">On your watchlist: {story.tracked.join(', ')}</span> : null}
        </p>
      </div>
      <div className="story-side">
        <div className="heatbox" title={HEAT_HELP}>
          <b>{story.heat}</b>
          <span>heat</span>
        </div>
        <form action={toggleSaveAction}>
          <input type="hidden" name="storyId" value={story.id} />
          <button type="submit" className={`save${story.saved ? ' on' : ''}`} aria-pressed={story.saved}>
            {story.saved ? 'Saved' : 'Save'}
          </button>
        </form>
      </div>
    </article>
  );
}

function Empty({ scope, filtered, hasTargets, clearHref }) {
  if (filtered) {
    return (
      <div className="empty">
        <b>No stories match these filters.</b>
        <Link href={clearHref}>Clear filters</Link>
      </div>
    );
  }
  if (scope === 'saved') {
    return (
      <div className="empty">
        <b>Nothing saved yet.</b>
        <span>Use Save on any story to keep it here.</span>
      </div>
    );
  }
  if (scope === 'watchlist' && !hasTargets) {
    return (
      <div className="empty">
        <b>Your watchlist is empty.</b>
        <span>Add creators, brands or subreddits, and stories that involve them collect here.</span>
        <Link className="btn primary sm" href="/watchlist">
          Build your watchlist
        </Link>
      </div>
    );
  }
  return (
    <div className="empty">
      <b>None of this week’s stories involve your watchlist yet.</b>
      <span>Stories show up here as soon as collection covers the creators, brands and communities you track.</span>
    </div>
  );
}

export default async function FeedPage({ searchParams }) {
  const session = await requireSession();
  const sp = await searchParams;
  const current = {
    scope: SCOPES.some((s) => s.id === sp.scope) ? sp.scope : 'all',
    category: typeof sp.category === 'string' ? sp.category.slice(0, 60) : '',
    platform: PLATFORMS.includes(sp.platform) ? sp.platform : '',
    q: typeof sp.q === 'string' ? sp.q.trim().slice(0, 80) : '',
  };
  const [stories, totals, categories, targets] = await Promise.all([
    getFeed({ workspaceId: session.workspace.id, ...current }),
    getTotals(),
    getCategories(),
    listTargets(session.workspace.id),
  ]);
  const filtered = Boolean(current.category || current.platform || current.q);
  const splitByBar = current.scope === 'all' && !filtered;
  const top = splitByBar ? stories.filter((s) => !s.whyNotTop) : stories;
  const rest = splitByBar ? stories.filter((s) => s.whyNotTop) : [];
  const clearHref = feedHref({ scope: current.scope }, {});

  const steps = [
    { done: targets.length > 0, label: 'Add the creators, brands or subreddits you follow', href: '/watchlist', cta: 'Open watchlist' },
    { done: stories.some((s) => s.saved), label: 'Save a story to come back to it', href: null },
    { done: false, label: 'Request a report on any topic from the last 30 days', href: '/reports', cta: 'Request a report' },
  ];

  return (
    <main>
      <header className="ihead">
        <p className="eyebrow">
          AI &amp; tech · X, YouTube, LinkedIn, Instagram, TikTok, Reddit · {dayRange(totals.first_post_at, totals.last_post_at)}
        </p>
        <h1>This week’s stories</h1>
        <p className="totals">
          <span>
            <b>{fmtNum(totals.posts)}</b> posts
          </span>
          <span>
            <b>{fmtNum(totals.comments)}</b> comments
          </span>
          <span>
            <b>{stories.length}</b> {current.scope === 'all' && !filtered ? 'stories' : 'shown'}
          </span>
        </p>
      </header>

      {targets.length === 0 && current.scope === 'all' ? (
        <section className="getstarted" aria-label="Get started">
          <h2>Get started</h2>
          <ol>
            {steps.map((step) => (
              <li key={step.label} className={step.done ? 'done' : undefined}>
                <span className="check" aria-hidden="true" />
                <span>{step.label}</span>
                {step.href && !step.done ? <Link href={step.href}>{step.cta}</Link> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="filters">
        <nav className="tabs" aria-label="Which stories">
          {SCOPES.map((s) => (
            <Link key={s.id} href={feedHref(current, { scope: s.id })} className={current.scope === s.id ? 'on' : undefined} aria-current={current.scope === s.id ? 'page' : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        <form className="search" action="/feed" role="search">
          {current.scope !== 'all' ? <input type="hidden" name="scope" value={current.scope} /> : null}
          {current.category ? <input type="hidden" name="category" value={current.category} /> : null}
          {current.platform ? <input type="hidden" name="platform" value={current.platform} /> : null}
          <input type="search" name="q" defaultValue={current.q} placeholder="Search stories, people, products" aria-label="Search stories" />
        </form>
        <div className="chips" aria-label="Category">
          <Link href={feedHref(current, { category: '' })} className={!current.category ? 'on' : undefined}>
            All topics
          </Link>
          {categories.map((c) => (
            <Link key={c} href={feedHref(current, { category: c })} className={current.category === c ? 'on' : undefined}>
              {c}
            </Link>
          ))}
        </div>
        <div className="chips" aria-label="Platform">
          <Link href={feedHref(current, { platform: '' })} className={!current.platform ? 'on' : undefined}>
            All platforms
          </Link>
          {PLATFORMS.map((p) => (
            <Link key={p} href={feedHref(current, { platform: p })} className={current.platform === p ? 'on' : undefined}>
              {PLATFORM_NAMES[p]}
            </Link>
          ))}
          {filtered ? (
            <Link href={clearHref} className="clear">
              Clear filters
            </Link>
          ) : null}
        </div>
      </div>

      {splitByBar ? (
        <h2 className="sect">
          Top stories <span>covered by {TOP.minSources}+ independent sources, with audience reaction</span>
        </h2>
      ) : null}
      <div className="feed">
        {top.length ? (
          top.map((s) => <StoryCard key={s.id} story={s} />)
        ) : splitByBar ? (
          <p className="note">No story meets the bar yet.</p>
        ) : (
          <Empty scope={current.scope} filtered={filtered} hasTargets={targets.length > 0} clearHref={clearHref} />
        )}
      </div>

      {rest.length ? (
        <>
          <h2 className="sect">
            Also this week <span>one source, or little audience reaction so far</span>
          </h2>
          <div className="feed compact">
            {rest.map((s) => (
              <StoryCard key={s.id} story={s} compact />
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}
