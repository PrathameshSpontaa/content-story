import Link from 'next/link';

export default function SiteFooter() {
  return (
    <footer className="sitefoot">
      <span>© {new Date().getFullYear()} Codeamesh · Content-Story beta</span>
      <nav aria-label="Legal">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/refunds">Refunds and cancellation</Link>
        <Link href="/contact">Contact</Link>
      </nav>
    </footer>
  );
}
