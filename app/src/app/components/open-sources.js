'use client';

import { useEffect } from 'react';

// Sources sit in a collapsed <details>; clicking a citation opens it so the anchor is visible.
export default function OpenSourcesOnCite() {
  useEffect(() => {
    const onClick = (event) => {
      if (!event.target.closest?.('a.cite')) return;
      const sources = document.getElementById('sources');
      if (sources && !sources.open) sources.open = true;
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  return null;
}
