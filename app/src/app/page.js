import Link from 'next/link';
import { HEAT_HELP, PLATFORM_NAMES, dayRange, fmtNum, plural } from '../../lib/format.js';
import { TOP, getSharedFeed, getTotals } from '../../lib/stories.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'This week’s stories' };

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
    <Link className="story" href={`/stories/${story.id}`}>
      <div>
        <p className="eyebrow">
          <span className="mc">{story.main_character}</span> · {story.category} · {dayRange(story.first_post_at, story.last_post_at)}
          {compact && story.whyNotTop ? <span className="why">{story.whyNotTop}</span> : null}
        </p>
        <h3>{story.headline}</h3>
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
        <p className="cov">{coverage(story)}</p>
      </div>
      <div className="heatbox" title={HEAT_HELP}>
        <b>{story.heat}</b>
        <span>heat</span>
      </div>
    </Link>
  );
}

export default async function FeedPage() {
  const [stories, totals] = await Promise.all([getSharedFeed(), getTotals()]);
  const top = stories.filter((s) => !s.whyNotTop);
  const rest = stories.filter((s) => s.whyNotTop);

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
            <b>{stories.length}</b> stories
          </span>
        </p>
      </header>

      <h2 className="sect">
        Top stories <span>covered by {TOP.minSources}+ independent sources, with audience reaction</span>
      </h2>
      <div className="feed">{top.length ? top.map((s) => <StoryCard key={s.id} story={s} />) : <p className="note">No story meets the bar yet.</p>}</div>

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
