import Link from 'next/link';

const PAGES = [
  ['admin', '/admin', 'Review and reports'],
  ['users', '/admin/users', 'Users'],
  ['runs', '/admin/runs', 'Runs and spend'],
  ['settings', '/admin/settings', 'Settings'],
];

// The same links sit on every admin page.
export default function AdminNav({ current }) {
  return (
    <nav className="tabs admin-tabs" aria-label="Admin pages">
      {PAGES.map(([key, href, label]) => (
        <Link key={key} href={href} className={current === key ? 'on' : undefined} aria-current={current === key ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
