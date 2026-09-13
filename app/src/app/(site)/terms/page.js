import Link from 'next/link';
import LegalPage from '../../components/legal-page.js';

export const metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>
        Content-Story is operated by Codeamesh (“we”). By creating an account you agree to these terms. If you use Content-Story for a company, you confirm you can accept
        them on its behalf.
      </p>

      <h2>What the service does</h2>
      <p>
        We collect publicly available posts and comments from social platforms, use AI to group them into stories, and check citations, quotes and numbers against the
        collected posts before publishing. Stories are summaries of public conversation, not statements of fact by us, and can contain mistakes. Check the linked sources
        before relying on a story.
      </p>

      <h2>Your account</h2>
      <p>
        Keep your sign-in secure and tell us if someone else uses your account. You are responsible for what happens in your workspace, including teammates you invite.
      </p>

      <h2>Credits, plans and payments</h2>
      <ul>
        <li>Credits pay for tracking, reports, alerts and digests at the rates shown in the app. We show the cost before an on-demand report runs.</li>
        <li>Credits have no cash value and can’t be transferred between workspaces.</li>
        <li>Plans renew monthly until cancelled. Payments are processed by Razorpay; prices are in Indian rupees and exclude GST unless stated.</li>
        <li>
          Refunds and cancellations follow our <Link href="/refunds">refund and cancellation policy</Link>.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Don’t use Content-Story to harass or target individuals, to build profiles of private people, to break a platform’s rules, or to resell our data. We may suspend
        accounts that do.
      </p>

      <h2>Content and removal</h2>
      <p>
        Posts and comments belong to their authors and platforms. We show short quotes with links to the original. To ask for content about you to be removed, use the
        details on our <Link href="/contact">contact page</Link>.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided as it is during the beta. To the extent the law allows, our total liability for any claim is limited to the amount you paid us in the
        three months before it.
      </p>

      <h2>Changes and law</h2>
      <p>
        We’ll tell you by email or in the app before material changes take effect. These terms are governed by the laws of India, and courts in India have jurisdiction.
      </p>
    </LegalPage>
  );
}
