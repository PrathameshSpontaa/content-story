'use client';

import { useState } from 'react';

// Copies `text` (with {url} replaced by this page's address) or just the address.
export default function CopyButton({ text = '{url}', label = 'Copy link', doneLabel = 'Copied' }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    const url = window.location.href.split('#')[0];
    try {
      await navigator.clipboard.writeText(text.replaceAll('{url}', url));
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      window.prompt('Copy this:', text.replaceAll('{url}', url));
    }
  };

  return (
    <button type="button" className="btn ghost sm" onClick={copy} aria-live="polite">
      {done ? doneLabel : label}
    </button>
  );
}
