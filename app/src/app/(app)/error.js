'use client';

export default function AppError({ error, reset }) {
  return (
    <div className="page reading">
      <div className="empty">
        <h2>This page didn’t load</h2>
        <p>Try again. If it keeps happening, contact us{error?.digest ? ` and mention reference ${error.digest}` : ''}.</p>
        <div className="empty-actions">
          <button type="button" className="btn primary" onClick={() => reset()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
