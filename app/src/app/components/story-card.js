import Link from 'next/link';
import { dayRange, plural } from '../../../lib/format.js';
import Avatar from './avatar.js';
import Heat from './heat.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';

export function coverageLine(story) {
  const communities = Math.max(0, (story.sources ?? story.creators) - story.creators);
  return [
    story.creators ? plural(story.creators, 'creator') : null,
    communities ? plural(communities, 'subreddit') : null,
    plural(story.platforms, 'platform'),
    story.audience ? plural(story.audience, 'comment') : 'no comments yet',
  ]
    .filter(Boolean)
    .join(' · ');
}

const listNames = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);

// variant: 'lead' (first story), 'full', or 'compact' (headline and meta only).
export default function StoryCard({ story, variant = 'full', saveAction = null }) {
  const takes = variant === 'compact' ? [] : (story.platform_strip ?? []);
  const faces = (story.creator_names ?? []).slice(0, 3);

  return (
    <article className={`scard ${variant}`}>
      <div className="scard-head">
        <p className="kicker">
          <span className="mc">{story.main_character}</span>
          <span aria-hidden="true">·</span>
          <span>{dayRange(story.first_post_at, story.last_post_at)}</span>
        </p>
        {saveAction ? (
          <form action={saveAction} className="scard-save">
            <input type="hidden" name="storyId" value={story.id} />
            <button
              type="submit"
              className={`iconbtn${story.saved ? ' on' : ''}`}
              aria-pressed={story.saved}
              aria-label={story.saved ? 'Remove from saved' : 'Save story'}
              title={story.saved ? 'Saved' : 'Save story'}
            >
              <Icon name="bookmark" size={17} filled={story.saved} />
            </button>
          </form>
        ) : null}
      </div>

      <h3 className="scard-title">
        <Link href={`/stories/${story.id}`}>{story.headline}</Link>
      </h3>
      {variant !== 'compact' && story.dek ? <p className="scard-dek">{story.dek}</p> : null}

      {takes.length ? (
        <ul className="takes" aria-label="What each platform is saying">
          {takes.map((t) => (
            <li key={t.platform}>
              <PlatformMark platform={t.platform} />
              <span>{t.gist}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="scard-foot">
        {faces.length ? (
          <span className="faces" aria-hidden="true">
            {faces.map((name) => (
              <Avatar key={name} name={name} size="xs" />
            ))}
          </span>
        ) : null}
        <span className="scard-meta">{coverageLine(story)}</span>
        {story.tracked?.length ? <span className="youfollow">You follow {listNames(story.tracked)}</span> : null}
        <Heat value={story.heat} />
      </div>
    </article>
  );
}
