import LegalPage from '../../components/legal-page.js';

export const metadata = { title: 'Contact' };

// Business details come from the environment so they can be filled in without a code change.
const DETAILS = [
  ['Email', process.env.SUPPORT_EMAIL],
  ['Phone', process.env.SUPPORT_PHONE],
  ['Registered address', process.env.BUSINESS_ADDRESS],
];

export default function ContactPage() {
  return (
    <LegalPage title="Contact">
      <p>Questions about your account, billing, a story, or content about you: we reply within two business days.</p>
      <dl className="details">
        <div className="details-row">
          <dt>Operated by</dt>
          <dd>Codeamesh</dd>
        </div>
        {DETAILS.map(([label, value]) => (
          <div key={label} className="details-row">
            <dt>{label}</dt>
            <dd>{value ? label === 'Email' ? <a href={`mailto:${value}`}>{value}</a> : value : <span className="muted">Being added during the beta</span>}</dd>
          </div>
        ))}
      </dl>
      <p>For content removal, include a link to the story and the post or comment you’d like removed.</p>
    </LegalPage>
  );
}
