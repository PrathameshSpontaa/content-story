export default function Loading() {
  return (
    <div className="page reading">
      <div className="loading" role="status" aria-live="polite">
        <span className="bar" />
        <span>Loading…</span>
      </div>
    </div>
  );
}
