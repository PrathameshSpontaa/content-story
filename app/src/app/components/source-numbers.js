// A week of numbers for a creator, subreddit or brand, drawn the same way in search and lists.
import { PLATFORM_NAMES } from '../../../lib/format.js';

// 950 · 12.4K · 3.2L · 1.1Cr, the way Indian audiences count.
export function compact(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const short = (value, unit) => `${(Math.round(value * 10) / 10).toLocaleString('en-IN')}${unit}`;
  if (abs >= 1e7) return short(n / 1e7, 'Cr');
  if (abs >= 1e5) return short(n / 1e5, 'L');
  if (abs >= 1e3) return short(n / 1e3, 'K');
  return String(Math.round(n));
}

// Change from the week before. Nothing is shown when there's no earlier week to compare with.
export function Change({ value, suffix = '' }) {
  if (value == null) return null;
  const words = value === 0 ? `No change${suffix}` : `${value > 0 ? 'Up' : 'Down'} ${Math.abs(value)}%${suffix}`;
  return (
    <span className={`delta ${value > 0 ? 'up' : value < 0 ? 'down' : 'flat'}`} aria-label={words} title={words}>
      {value === 0 ? 'No change' : `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}%`}
      {value === 0 ? '' : suffix}
    </span>
  );
}

// How interactions split across a creator's channels.
export function SplitBar({ channels }) {
  const live = (channels ?? []).filter((c) => c.interactions > 0);
  if (live.length < 2) return null;
  const total = live.reduce((sum, c) => sum + c.interactions, 0);
  const label = live.map((c) => `${PLATFORM_NAMES[c.platform]} ${Math.round((c.interactions / total) * 100)}%`).join(', ');
  return (
    <span className="chsplit" role="img" aria-label={`Interactions by channel: ${label}`} title={label}>
      {live.map((c) => (
        <i key={c.platform} className={`p-${c.platform}`} style={{ flexGrow: c.interactions }} />
      ))}
    </span>
  );
}

// Seven days, oldest first, drawn from zero so a flat week looks flat.
export function Sparkline({ values, label, width = 64, height = 22 }) {
  if (!values?.some((v) => v > 0)) return <span className="spark-none" aria-hidden="true">—</span>;
  const max = Math.max(...values);
  const x = (i) => (2 + (i / (values.length - 1)) * (width - 4)).toFixed(1);
  const y = (v) => (height - 3 - (v / max) * (height - 6)).toFixed(1);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <polygon className="spark-area" points={`${x(0)},${height} ${points} ${x(last)},${height}`} />
      <polyline className="spark-line" points={points} />
      <circle className="spark-end" cx={x(last)} cy={y(values[last])} r="2.2" />
    </svg>
  );
}

// Interactions, views and posts for a creator or subreddit; posts that mention a brand.
export function Numbers({ kind, stats }) {
  if (kind === 'keyword') {
    return (
      <span className="numbers">
        <span>
          <b>{compact(stats.mentions)}</b> {stats.mentions === 1 ? 'post mentions it' : 'posts mention it'}
        </span>
      </span>
    );
  }
  const reddit = kind === 'community';
  return (
    <span className="numbers">
      <span>
        <b>{compact(stats.interactions)}</b> {reddit ? 'upvotes and comments' : 'interactions'}
      </span>
      {stats.views == null ? null : (
        <span>
          <b>{compact(stats.views)}</b> views
        </span>
      )}
      <span>
        <b>{stats.posts.toLocaleString('en-IN')}</b> {reddit ? (stats.posts === 1 ? 'thread' : 'threads') : stats.posts === 1 ? 'post' : 'posts'}
      </span>
    </span>
  );
}
