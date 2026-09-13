'use client';

import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { PLATFORMS, daysBetween, quoteReport } from '../../../lib/pricing.js';

// Report request with a live credit quote, computed by the same rule the server charges by.
export default function ReportForm({ action, today, minDate, defaultFrom, maxDays, available, platformNames }) {
  const [state, dispatch, pending] = useActionState(action, null);
  const formRef = useRef(null);
  const [platforms, setPlatforms] = useState(PLATFORMS);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);

  useEffect(() => {
    if (state?.ok) formRef.current.elements.namedItem('query').value = '';
  }, [state]);

  const days = from && to && from <= to ? daysBetween(from, to) : 0;
  const tooLong = days > maxDays;
  const quote = days && platforms.length && !tooLong ? quoteReport({ platforms: platforms.length, days }) : null;
  const short = quote !== null && quote > available;
  const toggle = (p) => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : PLATFORMS.filter((x) => cur.includes(x) || x === p)));

  const onSubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };

  return (
    <form ref={formRef} className="form" onSubmit={onSubmit}>
      <label className="field">
        <span>Topic, brand or launch</span>
        <input name="query" required minLength={3} maxLength={80} placeholder="e.g. GPT-6 Astra launch" autoComplete="off" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>From</span>
          <input type="date" name="dateFrom" value={from} min={minDate} max={today} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label className="field">
          <span>To</span>
          <input type="date" name="dateTo" value={to} min={minDate} max={today} onChange={(e) => setTo(e.target.value)} required />
        </label>
      </div>
      <fieldset className="field">
        <legend>Platforms</legend>
        <div className="checks">
          {PLATFORMS.map((p) => (
            <label className="choice" key={p}>
              <input type="checkbox" name="platforms" value={p} checked={platforms.includes(p)} onChange={() => toggle(p)} /> {platformNames[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="quote" aria-live="polite">
        {tooLong ? (
          <span className="err-text">A report covers up to {maxDays} days.</span>
        ) : quote === null ? (
          <span>Choose dates and at least one platform to see the price.</span>
        ) : (
          <>
            <b>{quote.toLocaleString('en-IN')}</b> credits · {days} {days === 1 ? 'day' : 'days'} · {platforms.length} {platforms.length === 1 ? 'platform' : 'platforms'}
            {short ? <span className="err-text"> · you have {available.toLocaleString('en-IN')} available</span> : null}
          </>
        )}
      </p>
      <div className="form-foot">
        <button type="submit" className="btn primary" disabled={pending || quote === null}>
          {pending ? 'Requesting…' : quote ? `Request for ${quote.toLocaleString('en-IN')} credits` : 'Request report'}
        </button>
        {state?.message ? (
          <p role="status" className={`notice ${state.ok ? 'ok' : 'err'}`}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
