// End-to-end check of credits and billing against the real database with the fake payment provider.
// Creates a throwaway workspace and plan, runs each flow, prints PASS/FAIL, then deletes them.
// Usage: node scripts/test-billing.js
import assert from 'node:assert/strict';
import { pool } from '../lib/db.js';
import { InsufficientCredits, charge, getBalance, release, reserve, settle } from '../lib/credits.js';
import { handleWebhook, startSubscription } from '../lib/billing.js';
import { fakeProvider } from '../lib/payments/fake.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name}: ${err.message}`]);
  }
}

const suffix = Date.now();
const planId = `test_plan_${suffix}`;
const {
  rows: [workspace],
} = await pool.query('insert into workspaces (name) values ($1) returning id', [`billing test ${suffix}`]);
await pool.query(
  `insert into plans (id, name, price_paise, credits_per_period, max_tracked_creators, max_tracked_keywords, max_seats)
   values ($1, 'Test plan', 499900, 5000, 8, 3, 2)`,
  [planId],
);

try {
  let subscription;
  await check('starting a subscription creates it as pending, with no credits yet', async () => {
    subscription = await startSubscription(workspace.id, planId, fakeProvider);
    const { rows } = await pool.query('select status from subscriptions where provider_subscription_id = $1', [subscription.providerSubscriptionId]);
    assert.equal(rows[0].status, 'pending');
    assert.equal((await getBalance(workspace.id)).balance, 0);
  });

  const invoice = fakeProvider.simulate({
    type: 'subscription.charged',
    providerSubscriptionId: subscription?.providerSubscriptionId,
    providerPaymentId: `fake_pay_${suffix}`,
    amountPaise: 589882,
    periodStart: new Date().toISOString(),
    periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });

  await check('a paid invoice activates the subscription and grants the plan credits', async () => {
    const res = await handleWebhook(fakeProvider, invoice.body, invoice.headers);
    assert.equal(res.result, 'processed');
    assert.equal((await getBalance(workspace.id)).balance, 5000);
    const { rows } = await pool.query('select status from subscriptions where provider_subscription_id = $1', [subscription.providerSubscriptionId]);
    assert.equal(rows[0].status, 'active');
  });

  await check('the same webhook delivered again grants nothing', async () => {
    const res = await handleWebhook(fakeProvider, invoice.body, invoice.headers);
    assert.equal(res.result, 'duplicate');
    assert.equal((await getBalance(workspace.id)).balance, 5000);
  });

  await check('a webhook with a bad signature is rejected', async () => {
    const res = await handleWebhook(fakeProvider, invoice.body.replace('589882', '999999'), invoice.headers);
    assert.equal(res.status, 401);
  });

  await check('tracking is charged from the price list', async () => {
    const res = await charge(workspace.id, 'track_creator_day', 10, { reference: 'day-1', idempotencyKey: `test:${suffix}:day-1` });
    assert.equal(res.credits, 200);
    assert.equal(res.balance, 4800);
  });

  await check('a retried job is not charged twice', async () => {
    const res = await charge(workspace.id, 'track_creator_day', 10, { reference: 'day-1', idempotencyKey: `test:${suffix}:day-1` });
    assert.equal(res.applied, false);
    assert.equal(res.balance, 4800);
  });

  await check('a report holds its quote, then charges only what it used', async () => {
    const id = await reserve(workspace.id, 800, { reference: 'report-1' });
    assert.equal((await getBalance(workspace.id)).available, 4000);
    const res = await settle(id, 530);
    assert.equal(res.credits, 530);
    const after = await getBalance(workspace.id);
    assert.equal(after.balance, 4270);
    assert.equal(after.held, 0);
  });

  await check('a report never charges more than its quote', async () => {
    const id = await reserve(workspace.id, 300, { reference: 'report-2' });
    const res = await settle(id, 900);
    assert.equal(res.credits, 300);
  });

  await check('a released hold charges nothing', async () => {
    const id = await reserve(workspace.id, 500, { reference: 'report-3' });
    assert.equal(await release(id), true);
    const after = await getBalance(workspace.id);
    assert.equal(after.held, 0);
    assert.equal(after.balance, 3970);
  });

  await check('20 jobs spending at the same moment never overdraw the balance', async () => {
    const { available } = await getBalance(workspace.id);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => charge(workspace.id, 'track_creator_day', 20, { reference: 'burst', idempotencyKey: `test:${suffix}:burst:${i}` })),
    );
    const charged = outcomes.filter((o) => o.status === 'fulfilled').length;
    const refused = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof InsufficientCredits).length;
    assert.equal(charged, Math.floor(available / 400));
    assert.equal(charged + refused, 20);
    assert.ok((await getBalance(workspace.id)).balance >= 0);
  });

  await check('a top-up adds purchased credits once, even if the webhook repeats', async () => {
    const before = (await getBalance(workspace.id)).balance;
    const topup = fakeProvider.simulate({ type: 'topup.paid', workspaceId: workspace.id, providerPaymentId: `fake_topup_${suffix}`, providerOrderId: `fake_order_${suffix}`, amountPaise: 100000, credits: 1000 });
    assert.equal((await handleWebhook(fakeProvider, topup.body, topup.headers)).result, 'processed');
    assert.equal((await handleWebhook(fakeProvider, topup.body, topup.headers)).result, 'duplicate');
    assert.equal((await getBalance(workspace.id)).balance, before + 1000);
  });

  await check('the balance always equals the sum of ledger entries', async () => {
    const { rows } = await pool.query('select coalesce(sum(amount), 0)::int as total from credit_entries where workspace_id = $1', [workspace.id]);
    assert.equal(rows[0].total, (await getBalance(workspace.id)).balance);
  });
} finally {
  await pool.query('delete from workspaces where id = $1', [workspace.id]);
  await pool.query('delete from plans where id = $1', [planId]);
  await pool.query(`delete from webhook_events where provider = 'fake'`);
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
