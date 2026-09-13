import Link from 'next/link';

// Lines of posts narrowing into one story, with a live dot.
export function BrandMark({ size = 24 }) {
  return (
    <svg className="brandmark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="7" fill="var(--ink)" />
      <path d="M6.5 8h11M6.5 12h8M6.5 16h4.5" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="15.5" cy="16" r="2" fill="var(--accent)" />
    </svg>
  );
}

export default function Brand({ href = '/' }) {
  return (
    <Link href={href} className="brand">
      <BrandMark />
      <span>Content-Story</span>
    </Link>
  );
}
