'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Icon from './icons.js';

// Search and platform filter for the stories page; both live in the URL next to `base` (the tab,
// watchlist and tag being shown), which a new search or platform keeps.
export default function FilterBar({ base = {}, q, platform, platforms }) {
  const router = useRouter();
  const [text, setText] = useState(q);

  const go = (change) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...base, q: text.trim(), platform, ...change })) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    router.push(qs ? `/stories?${qs}` : '/stories');
  };

  return (
    <div className="filterbar">
      <form
        role="search"
        className="searchbox"
        onSubmit={(event) => {
          event.preventDefault();
          go({ q: text.trim() });
        }}
      >
        <Icon name="search" size={16} />
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search stories" aria-label="Search stories" maxLength={80} />
      </form>
      <label className="selectbox">
        <span className="sr">Platform</span>
        <select value={platform} onChange={(e) => go({ platform: e.target.value })}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
