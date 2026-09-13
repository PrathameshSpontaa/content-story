import Link from 'next/link';
import LegalPage from '../../components/legal-page.js';

export const metadata = { title: 'Refund and cancellation policy' };

export default function RefundsPage() {
  return (
    <LegalPage title="Refund and cancellation policy">
      <h2>Cancelling a plan</h2>
      <p>
        You can cancel a plan at any time from the Billing page or by contacting us. Cancellation stops the next renewal; your plan and its credits stay available until
        the end of the period you paid for. We don’t refund part of a period already started.
      </p>

      <h2>Top-up credits</h2>
      <p>If you haven’t used any credits from a top-up, you can ask for a full refund within 7 days of buying it.</p>

      <h2>Reports</h2>
      <p>
        A report holds its quoted credits while it’s prepared. If we can’t produce it, or you cancel it before work starts, the hold is released and nothing is charged.
        A finished report never costs more than its quote.
      </p>

      <h2>Payment problems</h2>
      <p>
        If you’re charged twice, or charged for a payment that failed, we refund the extra amount to the original payment method. Refunds are issued through Razorpay and
        usually reach you within 5–7 business days.
      </p>

      <h2>How to ask</h2>
      <p>
        Write to us using the details on our <Link href="/contact">contact page</Link> with your account email and the Razorpay payment ID from your receipt.
      </p>
    </LegalPage>
  );
}
