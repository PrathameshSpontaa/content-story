'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function NavLinks({ links }) {
  const pathname = usePathname();
  return (
    <nav className="appnav" aria-label="Main">
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`) || (link.href === '/feed' && pathname.startsWith('/stories/'));
        return (
          <Link key={link.href} href={link.href} className={active ? 'on' : undefined} aria-current={active ? 'page' : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
