'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtNum } from '../../../lib/format.js';

const PANEL = 184; // width of one fold, px
const ANGLE = 72; // degrees each fold turns when the sheet is fully closed

// Where panel `i` sits when the sheet is folded by `f` (0 flat, 1 closed). Even panels turn away
// from the reader, odd panels turn back, so the edges stay joined in a zigzag.
function place(i, f) {
  const t = (f * ANGLE * Math.PI) / 180;
  const x = i * PANEL * Math.cos(t);
  const z = i % 2 ? -PANEL * Math.sin(t) : 0;
  return `translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(1)}px) rotateY(${((i % 2 ? -1 : 1) * f * ANGLE).toFixed(2)}deg)`;
}

// Six platform verdicts printed on one sheet, folded like a map. It unfolds when the page loads,
// folds back as the page scrolls, and a slider or the tabs let people play with it.
export default function FoldSheet({ panels, caption }) {
  const strip = useRef(null);
  const slider = useRef(null);
  const state = useRef({ user: 0, scroll: 0, cur: 1 });
  const kick = useRef(() => {});
  const [selected, setSelected] = useState(-1);

  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const s = state.current;
    const items = [...el.querySelectorAll('.fold-panel')];
    let raf = 0;
    const apply = () => {
      items.forEach((item, i) => {
        item.style.transform = place(i, s.cur);
      });
      el.style.setProperty('--fold', s.cur.toFixed(3));
      el.style.setProperty('--shift', `${((items.length / 2) * PANEL * (1 - Math.cos((s.cur * ANGLE * Math.PI) / 180))).toFixed(1)}px`);
    };
    const tick = () => {
      raf = 0;
      const target = Math.min(1, s.user + s.scroll);
      s.cur += (target - s.cur) * (reduced ? 1 : 0.08);
      if (Math.abs(target - s.cur) < 0.0015) s.cur = target;
      apply();
      if (s.cur !== target) raf = requestAnimationFrame(tick);
    };
    kick.current = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onScroll = () => {
      s.scroll = Math.min(1, Math.max(0, (window.scrollY - 60) / 420));
      kick.current();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    s.cur = reduced ? 0 : 1;
    apply();
    kick.current();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [panels.length]);

  const pick = (i) => {
    setSelected(i);
    state.current.user = 0;
    if (slider.current) slider.current.value = '0';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    kick.current();
  };

  return (
    <div className="fold">
      <div className="fold-cap">
        <span>{caption}</span>
        <label className="fold-ctl">
          fold
          <input
            ref={slider}
            type="range"
            min="0"
            max="100"
            defaultValue="0"
            aria-label="Fold the sheet"
            onInput={(e) => {
              state.current.user = Number(e.currentTarget.value) / 100;
              kick.current();
            }}
          />
        </label>
      </div>
      <div className="fold-strip" ref={strip} style={{ '--n': panels.length, '--pw': `${PANEL}px`, '--fold': 1 }} onMouseLeave={() => setSelected(-1)}>
        {panels.map((p, i) => (
          <article
            key={p.platform}
            className={`fold-panel${i % 2 ? ' lit' : ''}${p.quiet ? ' quiet' : ''}${selected === i ? ' on' : ''}`}
            style={{ '--c': `var(--p-${p.platform})`, transform: place(i, 1) }}
            onMouseEnter={() => setSelected(i)}
          >
            <div className="fold-ph">
              <b>
                <i />
                {p.name}
              </b>
              <span>{p.quiet ? 'no posts' : p.stand ? `${fmtNum(p.stand.comments)} counted` : p.comments ? `${fmtNum(p.comments)} comments` : 'no comments'}</span>
            </div>
            {p.quiet ? (
              <>
                <h3>Quiet this week</h3>
                <p>None of the creators followed posted about this on {p.name}. Silence is a signal too.</p>
              </>
            ) : (
              <>
                <h3>{p.take}</h3>
                {p.stand ? (
                  <div className="fold-st">
                    <div className="r">
                      <span>{p.stand.title}</span>
                      <b>{p.stand.agreePct}%</b>
                    </div>
                    <div className="bar">
                      <i style={{ width: `${p.stand.agreePct}%` }} />
                    </div>
                    <small>of {fmtNum(p.stand.comments)} comments agree</small>
                  </div>
                ) : (
                  <div className="fold-st">
                    <small>{p.comments ? 'Too few comments on any one argument to print a percentage.' : 'No comments collected here, so no percentage is printed.'}</small>
                  </div>
                )}
                {p.quote ? (
                  <blockquote>
                    “{p.quote}”<footer>{p.quoteWho} · username hidden</footer>
                  </blockquote>
                ) : null}
              </>
            )}
          </article>
        ))}
      </div>
      <div className="fold-floor" aria-hidden="true" />
      <div className="fold-tabs">
        {panels.map((p, i) => (
          <button key={p.platform} type="button" className={`fold-tab${selected === i ? ' on' : ''}`} style={{ '--c': `var(--p-${p.platform})` }} onClick={() => pick(i)}>
            <i />
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
