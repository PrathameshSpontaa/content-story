'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { chooseWatchlistAction } from '../watchlists/actions.js';

// Which watchlist the follows made on this page go into. Saved as soon as it changes.
export default function WatchlistPicker({ watchlists, chosenId }) {
  const [value, setValue] = useState(chosenId);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const choose = (id) => {
    const before = value;
    setValue(id);
    setError('');
    startTransition(async () => {
      const res = await chooseWatchlistAction(id);
      if (res?.error) {
        setValue(before);
        setError(res.error);
      }
    });
  };

  return (
    <div className="wl-picker">
      <label>
        <span>New follows go into</span>
        <select value={value} onChange={(e) => choose(e.target.value)} disabled={pending} aria-busy={pending}>
          {watchlists.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <Link href={`/watchlists/${value}`}>Edit this watchlist</Link>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
