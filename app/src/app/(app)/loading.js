export default function Loading() {
  return (
    <main className="apppage">
      <div className="loading" role="status" aria-live="polite">
        <span className="bar" />
        <span>Loading…</span>
      </div>
    </main>
  );
}
