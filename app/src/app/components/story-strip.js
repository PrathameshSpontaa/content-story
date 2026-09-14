'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { dayRange } from '../../../lib/format.js';
import Heat from './heat.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';

const smooth = () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// The latest stories someone is part of, one card at a time, newest first. Swipe or use the arrows.
export default function StoryStrip({ stories, label }) {
  const track = useRef(null);
  const [at, setAt] = useState(0);
  const n = stories.length;

  const measure = () => {
    const el = track.current;
    if (el?.clientWidth) setAt(Math.min(n - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth))));
  };

  useEffect(() => {
    measure();
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);

  const go = (index) => {
    const el = track.current;
    if (!el) return;
    const next = Math.min(n - 1, Math.max(0, index));
    el.scrollTo({ left: next * el.clientWidth, behavior: smooth() });
  };

  return (
    <div className="strip">
      <div className="exp-head">
        <h4>{label}</h4>
        {n > 1 ? (
          <span className="strip-nav">
            <button type="button" aria-label="Previous story" disabled={at === 0} onClick={() => go(at - 1)}>
              <Icon name="back" size={14} />
            </button>
            <span aria-live="polite">
              {at + 1} / {n}
            </span>
            <button type="button" aria-label="Next story" disabled={at >= n - 1} onClick={() => go(at + 1)}>
              <Icon name="arrow" size={14} />
            </button>
          </span>
        ) : null}
      </div>
      <ul className="strip-track" ref={track} onScroll={measure}>
        {stories.map((s) => (
          <li key={s.id} className="strip-card">
            <p className="kicker">
              <span>{dayRange(s.first_post_at, s.last_post_at)}</span>
              {s.category ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{s.category}</span>
                </>
              ) : null}
            </p>
            <h5 className="strip-title">
              <Link href={`/stories/${s.id}`}>{s.headline ?? 'Untitled story'}</Link>
            </h5>
            {s.dek ? <p className="strip-dek">{s.dek}</p> : null}
            <div className="strip-foot">
              {s.platforms?.length ? (
                <span className="marks" title="Where they were part of it">
                  {s.platforms.map((p) => (
                    <PlatformMark key={p} platform={p} size="xs" />
                  ))}
                </span>
              ) : (
                <span />
              )}
              <Heat value={s.heat} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
