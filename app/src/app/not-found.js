import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <main className="legal">
      <p className="kicker">404</p>
      <h1>This page isn’t here.</h1>
      <p>The story may have been merged into another one or unpublished, or the link is incomplete.</p>
      <p>
        <Link className="btn primary" href="/stories">
          Go to your stories
        </Link>
      </p>
    </main>
  );
}
