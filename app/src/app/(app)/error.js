'use client';

export default function AppError({ error, reset }) {
  return (
    <main className="apppage">
      <div className="empty">
        <b>This page didn’t load.</b>
        <span>
          Try again. If it keeps happening, contact us{error?.digest ? ` and mention reference ${error.digest}` : ''}.
        </span>
        <button type="button" className="btn primary sm" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
