'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from './icons.js';

export default function NavLinks({ links, label, className = 'navlist' }) {
  const pathname = usePathname();
  return (
    <nav className={className} aria-label={label}>
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link key={link.href} href={link.href} className={active ? 'on' : undefined} aria-current={active ? 'page' : undefined}>
            {link.icon ? <Icon name={link.icon} size={18} /> : null}
            <span className="navlabel">{link.label}</span>
            {link.count ? <span className="navcount">{link.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
