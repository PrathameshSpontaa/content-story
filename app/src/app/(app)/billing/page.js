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
  track_creator_day: 'Creator tracking',
  track_keyword_day: 'Brand and keyword tracking',
  track_community_day: 'Subreddit tracking',
  report: 'Story report',
  alert: 'Alert',
  digest: 'Digest email',
};

function describeEntry(entry) {
  if (entry.type === 'hold') return 'Held for a report';
  switch (entry.kind) {
    case 'grant':
      return entry.reference === 'trial' ? 'Free trial credits' : entry.note ?? 'Credits added';
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
    <main className="apppage">
      <header className="pagehead">
        <h1>Billing</h1>
        <p className="dek">Credits pay for tracking, reports, alerts and digests. Your plan adds credits every month; top-ups add them any time.</p>
      </header>

      <dl className="stats">
        <div>
          <dt>Available credits</dt>
          <dd>{fmtNum(credits.available)}</dd>
        </div>
        <div>
          <dt>Held for reports</dt>
          <dd>{fmtNum(credits.held)}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            {plan.name}
            {plan.status === 'past_due' ? <small className="err-text"> payment due</small> : null}
          </dd>
        </div>
        <div>
          <dt>{plan.periodEnd ? 'Renews' : 'Included'}</dt>
          <dd>{plan.periodEnd ? fmtDay(plan.periodEnd) : <>{fmtNum(plan.allowance)} <small>credits</small></>}</dd>
        </div>
      </dl>

      <section className="panel">
        <h2>Top up credits</h2>
        {mode.provider === 'razorpay' && mode.test ? (
          <p className="notice info">Razorpay test mode: no real money moves. Use Razorpay’s test cards or test UPI IDs to try a purchase.</p>
        ) : null}
        {mode.provider === 'fake' ? <p className="notice info">Development: purchases are simulated and add credits straight away.</p> : null}
        {!mode.provider ? <p className="notice info">Online payments aren’t switched on for this site yet. Contact us to add credits.</p> : null}
        <TopupPacks packs={packs} beginTopup={beginTopupAction} confirmTopup={confirmTopupAction} email={session.user.email} name={session.user.name ?? ''} disabled={!mode.provider} />
        <p className="hint">Prices exclude GST.</p>
      </section>

      <section className="panel">
        <h2>Plans</h2>
        <div className="plans compact">
          {plans.map((p) => (
            <div className={`plan${plan.planId === p.id ? ' lead' : ''}`} key={p.id}>
              <h3>
                {p.name}
                {plan.planId === p.id ? <span className="pill">Current</span> : null}
              </h3>
              <p className="price">
                {fmtINR(p.price_paise)}
                <small> a month + GST</small>
              </p>
              <ul>
                <li>{fmtNum(p.credits_per_period)} credits a month</li>
                <li>{plural(p.max_tracked_creators, 'creator or subreddit', 'creators and subreddits')}</li>
                <li>{plural(p.max_tracked_keywords, 'brand or keyword', 'brands and keywords')}</li>
                <li>{plural(p.max_seats, 'seat')}</li>
              </ul>
            </div>
          ))}
        </div>
        <p className="hint">
          Monthly plans open at paid launch. Until then, top-ups work on every account; <Link href="/contact">contact us</Link> if you need more room on your watchlist.
        </p>
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
                    <td className={`num ${e.amount > 0 ? 'plus' : ''}`}>
                      {e.amount > 0 ? '+' : '−'}
                      {fmtNum(Math.abs(e.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="note">No credit activity yet.</p>
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
          <p className="note">No payments yet.</p>
        )}
        <p className="hint">
          GST invoices start at paid launch. Add your GSTIN in <Link href="/settings">Settings</Link> so they’re issued to your business.
        </p>
      </section>
    </main>
  );
}
