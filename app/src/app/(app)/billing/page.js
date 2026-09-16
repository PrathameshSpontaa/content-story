import Link from 'next/link';
import { getPlanState, listPlans } from '../../../../lib/accounts.js';
import { checkoutMode, listPayments } from '../../../../lib/billing.js';
import { getBalance, listLedger } from '../../../../lib/credits.js';
import { fmtDay, fmtNum, plural } from '../../../../lib/format.js';
import { TOPUP_PACKS, fmtINR } from '../../../../lib/pricing.js';
import { requireSession } from '../../../../lib/session.js';
import TopupPacks from '../../components/topup-packs.js';
import { beginTopupAction, confirmTopupAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Billing' };

const ACTION_LABEL = {
  track_creator_day: 'Following a creator',
  track_keyword_day: 'Following a brand or topic',
  track_community_day: 'Following a subreddit',
  report: 'Story report',
  alert: 'Alert',
  digest: 'Digest email',
};

function describeEntry(entry) {
  if (entry.type === 'hold') return 'Held for a report';
  switch (entry.kind) {
    case 'grant':
      return entry.reference === 'trial' ? 'Free trial credits' : (entry.note ?? 'Credits added');
    case 'purchase':
      return 'Top-up';
    case 'debit':
      return ACTION_LABEL[entry.action] ?? 'Usage';
    case 'refund':
      return 'Refund';
    default:
      return entry.note ?? 'Adjustment';
  }
}

export default async function BillingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [credits, plan, plans, ledger, payments] = await Promise.all([
    getBalance(workspaceId),
    getPlanState(workspaceId),
    listPlans(),
    listLedger(workspaceId),
    listPayments(workspaceId),
  ]);
  const mode = checkoutMode();
  const paisePerCredit = Number(process.env.TOPUP_PAISE_PER_CREDIT || 100);
  const packs = TOPUP_PACKS.map((n) => ({ credits: n, price: fmtINR(n * paisePerCredit) }));

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Billing</h1>
        <p>Credits pay for following, reports, alerts and digests. Plans add credits every month; top-ups add them any time.</p>
      </header>

      <section className="panel balance" aria-label="Credit balance">
        <div className="balance-main">
          <span className="balance-label">Available credits</span>
          <b className="balance-num">{fmtNum(credits.available)}</b>
          <span className="balance-sub">
            {plan.name}
            {plan.status === 'past_due' ? ' · payment due' : ''}
            {plan.periodEnd ? ` · renews ${fmtDay(plan.periodEnd)}` : ''}
            {credits.held ? ` · ${fmtNum(credits.held)} held for reports` : ''}
          </span>
        </div>
        <div className="btnrow">
          <Link className="btn ghost" href="/refer">
            Refer a friend
          </Link>
          <a className="btn primary" href="#topup">
            Top up
          </a>
        </div>
      </section>

      <section className="panel" id="topup">
        <h2>Top up credits</h2>
        {mode.provider === 'razorpay' && mode.test ? <p className="notice info">Razorpay test mode: no real money moves. Use Razorpay’s test cards or UPI IDs.</p> : null}
        {mode.provider === 'fake' ? <p className="notice info">Development: purchases are simulated and add credits straight away.</p> : null}
        {!mode.provider ? (
          <p className="notice info">
            Online payments aren’t switched on yet. <Link href="/contact">Contact us</Link> to add credits.
          </p>
        ) : null}
        <TopupPacks packs={packs} beginTopup={beginTopupAction} confirmTopup={confirmTopupAction} email={session.user.email} name={session.user.name ?? ''} disabled={!mode.provider} />
        <p className="hint">Prices exclude GST. Paid through Razorpay: UPI, cards and netbanking.</p>
      </section>

      <section className="fsection" aria-labelledby="h-plans">
        <div className="fsection-head">
          <h2 id="h-plans">Plans</h2>
          <p>Monthly plans open at paid launch</p>
        </div>
        <div className="plans">
          {plans.map((p) => (
            <div className={`plan${plan.planId === p.id ? ' lead' : ''}`} key={p.id}>
              <h3>
                {p.name}
                {plan.planId === p.id ? <span className="pill">Current</span> : null}
              </h3>
              <p className="price">
                {fmtINR(p.price_paise)}
                <small> / month + GST</small>
              </p>
              <ul>
                <li>{fmtNum(p.credits_per_period)} credits every month</li>
                <li>{plural(p.max_tracked_creators, 'creator or subreddit', 'creators and subreddits')}</li>
                <li>{plural(p.max_tracked_keywords, 'brand or topic', 'brands and topics')}</li>
                <li>{plural(p.max_seats, 'seat')}</li>
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Credit history</h2>
        {ledger.length ? (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th className="num">Credits</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e, i) => (
                  <tr key={i} className={e.type === 'hold' ? 'held' : undefined}>
                    <td>{fmtDay(e.created_at)}</td>
                    <td>{describeEntry(e)}</td>
                    <td className={`num${e.amount > 0 ? ' plus' : ''}`}>
                      {e.amount > 0 ? '+' : '−'}
                      {fmtNum(Math.abs(e.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted-note">No credit activity yet.</p>
        )}
      </section>

      <section className="panel">
        <h2>Payments</h2>
        {payments.length ? (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>For</th>
                  <th className="num">Amount</th>
                  <th className="num">Credits</th>
                  <th>Status</th>
                  <th>Payment ID</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDay(p.created_at)}</td>
                    <td>{p.kind === 'topup' ? 'Top-up' : 'Plan'}</td>
                    <td className="num">{fmtINR(p.amount_paise)}</td>
                    <td className="num">{fmtNum(p.credits)}</td>
                    <td>
                      <span className={`status ${p.status}`}>{p.status}</span>
                    </td>
                    <td className="mono">{p.provider_payment_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted-note">No payments yet.</p>
        )}
        <p className="hint">
          GST invoices start at paid launch. Add your GSTIN in <Link href="/settings">Settings</Link> so they’re issued to your business.
        </p>
      </section>
    </div>
  );
}
