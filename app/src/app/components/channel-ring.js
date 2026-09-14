'use client';

import { useEffect, useRef, useState } from 'react';
import { PLATFORM_NAMES } from '../../../lib/format.js';
import Face from './face.js';
import PlatformMark from './platform-mark.js';
import { compact } from './source-numbers.js';

const ORDER = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];
const GAP = 7; // of 100 units around the ring, between slices

const postsWord = (platform, n) => (platform === 'reddit' ? (n === 1 ? 'thread' : 'threads') : n === 1 ? 'post' : 'posts');

// A creator's channels as slices of a ring around their photo, like a status ring: one slice per
// channel in that platform's colour, grey when it posted nothing this week. Click for the list.
export default function ChannelRing({ name, kind = 'creator', photo, handles = [], channels = [], collected = true, size = 'md' }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const byHandle = new Map(handles.map((h) => [h.platform, h]));
  const byStats = new Map(channels.map((c) => [c.platform, c]));
  const platforms = [...new Set([...byHandle.keys(), ...byStats.keys()])].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  // Nothing to slice yet (a brand nobody mentioned): the face alone, at the ring's size so rows line up.
  if (!platforms.length) {
    return (
      <span className={`ring ${size}`}>
        <Face name={name} kind={kind} photo={photo} size={size} />
      </span>
    );
  }

  const slices = platforms.map((platform) => {
    const stats = byStats.get(platform);
    const handle = byHandle.get(platform);
    const quiet = collected && stats != null && stats.posts === 0;
    const where = handle ? { label: handle.handle, url: handle.url } : kind === 'community' ? { label: name, url: `https://www.reddit.com/${name}/` } : null;
    return { platform, quiet, stats, where };
  });
  const n = slices.length;
  const length = n === 1 ? 100 : (100 - n * GAP) / n;
  const names = slices.map((s) => PLATFORM_NAMES[s.platform] ?? s.platform);
  const active = slices.filter((s) => !s.quiet).length;

  return (
    <span className={`ring ${size}`} ref={root}>
      <button
        type="button"
        className="ringbtn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${name} on ${names.join(', ')}${collected && n > 1 ? `. ${active} of ${n} active this week` : ''}`}
        title={names.join(' · ')}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="ring-svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <g transform="rotate(-90 20 20)">
            {slices.map((s, i) => (
              <circle
                key={s.platform}
                className={`p-${s.platform}${s.quiet ? ' quiet' : ''}`}
                cx="20"
                cy="20"
                r="18.8"
                pathLength="100"
                strokeDasharray={`${length} ${100 - length}`}
                strokeDashoffset={-i * (length + GAP)}
              />
            ))}
          </g>
        </svg>
        <Face name={name} kind={kind} photo={photo} size={size} badge={false} />
      </button>
      {open ? (
        <div className="ring-pop" role="dialog" aria-label={`${name}: channels`}>
          <b className="ring-head">{n === 1 ? '1 channel' : `${n} channels`}</b>
          <ul>
            {slices.map((s) => (
              <li key={s.platform} className={s.quiet ? 'quiet' : ''}>
                <PlatformMark platform={s.platform} size="sm" />
                <span className="ring-ch">
                  <b>{PLATFORM_NAMES[s.platform] ?? s.platform}</b>
                  {s.where ? (
                    <a href={s.where.url} target="_blank" rel="noopener noreferrer">
                      {s.where.label}
                    </a>
                  ) : null}
                </span>
                {collected && s.stats ? (
                  <span className="ring-n">
                    {s.quiet
                      ? 'Quiet this week'
                      : `${s.stats.posts.toLocaleString('en-IN')} ${postsWord(s.platform, s.stats.posts)}${s.stats.interactions == null ? ' mention it' : ` · ${compact(s.stats.interactions)} interactions`}`}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}
