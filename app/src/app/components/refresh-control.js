'use client';

// The freshness line and Refresh button under the Stories title: when stories last updated and when the
// next scheduled update is, a refresh on demand, and polling while one runs so new stories show up.
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fmtAgo, fmtClock } from '../../../lib/format.js';

const POLL_MS = 10_000;
const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(d));

function nextUpdate(at, now) {
  if (!at) return '';
  return istDate(at) === istDate(now) ? `next update at ${fmtClock(at)}` : `next update tomorrow at ${fmtClock(at)}`;
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      className={spinning ? 'icon spin' : 'icon'}
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" />
    </svg>
  );
}

export default function RefreshControl({ initialStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busy = status?.state === 'queued' || status?.state === 'running';
  const wasBusy = useRef(busy);

  // While a refresh is queued or running, check on it every 10 seconds.
  useEffect(() => {
    if (!busy) return undefined;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/refresh', { cache: 'no-store' });
        if (res.ok && !stopped) setStatus(await res.json());
      } catch {
        // A missed poll is fine; the next one tries again.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [busy]);

  // When it finishes, reload the stories on the page, or say why it didn't finish.
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setNow(Date.now());
      if (status?.lastError) setMessage(`The refresh didn’t finish. ${status.lastError}`);
      else {
        setMessage('');
        router.refresh();
      }
    }
    wasBusy.current = busy;
  }, [busy, status, router]);

  // Keeps "2 hours ago" current while the page stays open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!status) return null;

  async function refresh() {
    setSending(true);
    setMessage('');
    try {
      const res = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return setMessage('Sign in again to refresh.');
      if (!res.ok) return setMessage('Couldn’t refresh just now. Try again in a minute.');
      if (data.status) setStatus(data.status);
      else if (data.ok) setStatus((s) => ({ ...s, state: 'queued' }));
      if (!data.ok) setMessage(data.message || 'Couldn’t refresh just now.');
    } catch {
      setMessage('Couldn’t reach Content-Story. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  const next = nextUpdate(status.nextScheduledAt, now);
  let line;
  if (!status.enabled) line = next;
  else if (busy) line = 'Refreshing… new stories appear in a few minutes';
  else line = [status.lastRefreshedAt ? `Updated ${fmtAgo(status.lastRefreshedAt, now)}` : null, next].filter(Boolean).join(' · ');
  if (line) line = line[0].toUpperCase() + line.slice(1);

  return (
    <div className="freshness">
      <p className="fresh-line" aria-live="polite">
        <span suppressHydrationWarning>{line}</span>
        {message ? <span className="fresh-msg">{message}</span> : null}
      </p>
      {status.enabled ? (
        <button type="button" className="btn ghost sm refresh-btn" onClick={refresh} disabled={busy || sending} aria-busy={busy || sending}>
          <RefreshIcon spinning={busy || sending} />
          Refresh
        </button>
      ) : null}
    </div>
  );
}
