'use client';

import { useEffect, useRef } from 'react';

// A number that counts up from zero once it scrolls into view. The server renders the final value,
// so the page reads correctly before any script runs.
export default function CountUp({ value, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const to = Number(value) || 0;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const started = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - started) / 1300);
          const eased = 1 - (1 - k) ** 3;
          el.textContent = String(Math.round(to * eased));
          if (k < 1) requestAnimationFrame(step);
        };
        el.textContent = '0';
        requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value]);
  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}
