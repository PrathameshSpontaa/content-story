export const LEGAL_UPDATED = '13 September 2026';

export default function LegalPage({ title, children }) {
  return (
    <main className="legal">
      <p className="eyebrow">Last updated {LEGAL_UPDATED} · beta draft, pending legal review</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
