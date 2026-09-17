import Link from 'next/link';
import LegalPage from '../../components/legal-page.js';

export const metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        This policy explains what personal data Content-Story handles and why, under India’s Digital Personal Data Protection Act, 2023. Codeamesh is the data fiduciary.
      </p>

      <h2>Data about you as a customer</h2>
      <ul>
        <li>
          <b>Account:</b> your name and email address, and a sign-in identifier from Clerk, our sign-in provider.
        </li>
        <li>
          <b>Workspace:</b> its name, your watchlist, saved stories, report requests, and billing details you add (GSTIN and state).
        </li>
        <li>
          <b>Payments:</b> amounts, dates and Razorpay payment IDs. Card, UPI and bank details are handled by Razorpay; we never see or store them.
        </li>
        <li>
          <b>Usage:</b> credit use and basic server logs, to run and secure the service.
        </li>
      </ul>

      <h2>Public posts and comments</h2>
      <p>
        We collect posts and comments that are publicly visible on X, YouTube, LinkedIn, Instagram, TikTok and Reddit, including the author’s public username. We use
        them to build stories, show short quotes with links to the original, and count reactions. You can ask
        us to remove content about you at any time.
      </p>

      <h2>Who processes data for us</h2>
      <p>
        Clerk (sign-in), Render (hosting and database, Singapore region), Razorpay (payments), OpenAI (AI processing of public posts and comments) and Apify
        (collection of public posts). Each processes data only to provide its part of the service.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account data is kept while your account is open and deleted within 30 days of closing it, except payment records we must keep for tax law. Collected public
        content is kept while it’s part of a published story or report.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask to access, correct or erase your data, withdraw consent, or raise a grievance. Use the details on our <Link href="/contact">contact page</Link>; we
        reply within 30 days.
      </p>
    </LegalPage>
  );
}
