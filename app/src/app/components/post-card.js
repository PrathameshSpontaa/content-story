import { PLATFORM_NAMES, fmtAgo, plural, truncate } from '../../../lib/format.js';
import Face from './face.js';
import PlatformMark from './platform-mark.js';

const compact = (n) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);

// One post from a creator the workspace follows that isn't part of a story: who posted where and when,
// the AI's one-line summary (the post's own text until it has one), and the biggest groups of comments.
export default function PostCard({ post }) {
  const numbers = [
    post.views ? `${compact(post.views)} views` : null,
    post.likes ? `${compact(post.likes)} likes` : null,
    post.comments ? `${compact(post.comments)} comments` : null,
  ].filter(Boolean);

  return (
    <article className="pcard">
      <div className="pcard-head">
        <Face name={post.creator} photo={post.photo} size="sm" badge={false} />
        <p className="kicker">
          <span className="mc">{post.creator}</span>
          <span aria-hidden="true">·</span>
          <PlatformMark platform={post.platform} size="xs" />
          <span>{PLATFORM_NAMES[post.platform] ?? post.platform}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(post.published_at).toISOString()}>{fmtAgo(post.published_at)}</time>
        </p>
      </div>
      <p className="pcard-about">{post.about || truncate(post.text, 240) || 'A post without text.'}</p>
      {post.reactions?.length ? (
        <ul className="pcard-reactions" aria-label="What commenters said">
          {post.reactions.map((r) => (
            <li key={r.label}>
              <b>{r.label}</b> {r.point} <span className="muted">({plural(r.size, 'comment')})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="scard-foot">
        {numbers.length ? <span className="scard-meta">{numbers.join(' · ')}</span> : null}
        {post.url ? (
          <a className="pcard-open" href={post.url} target="_blank" rel="noreferrer">
            Open on {PLATFORM_NAMES[post.platform] ?? 'the platform'}
          </a>
        ) : null}
      </div>
    </article>
  );
}
