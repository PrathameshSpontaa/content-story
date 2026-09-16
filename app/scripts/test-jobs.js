// End-to-end check of the job layer against the real database: daily tracking charges, pausing and
// resuming, low-credit warnings, spend caps, runs, margin and the pg-boss queues. Creates a
// throwaway workspace, prints PASS/FAIL, then deletes everything it made. Never runs the pipeline.
// Usage: node scripts/test-jobs.js
import assert from 'node:assert/strict';
import { recordTopupPaid } from '../lib/billing.js';
import { addCredits, getBalance } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { costByDay, marginByAction } from '../lib/metering.js';
import { finishRun, listRuns, startRun } from '../lib/runs.js';
import { SpendCapReached, assertUnderDailyCap, dailyCap, spentToday } from '../lib/spend.js';
import { chargeDailyTracking, estimateDailyCredits, resumePausedTracking } from '../lib/tracking-billing.js';
import { QUEUES, startBoss } from '../pipeline/jobs.js';

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
const marker = `billing test jobs ${suffix}`;
const email = `jobs-test-${suffix}@content-story.dev`;
const quiet = () => {};
const targetsOf = async (workspaceId) => (await pool.query(`select kind::text as kind, active, paused_reason from tracking_targets where workspace_id = $1 order by created_at`, [workspaceId])).rows;
const notificationsOf = async (workspaceId) => (await pool.query(`select kind, destination, note, sent_at from notifications where workspace_id = $1 order by created_at`, [workspaceId])).rows;

const {
  rows: [user],
} = await pool.query(`insert into users (email, name) values ($1, 'Jobs Test') returning id`, [email]);
const {
  rows: [workspace],
} = await pool.query(`insert into workspaces (name) values ($1) returning id`, [marker]);
await pool.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [workspace.id, user.id]);
const {
  rows: [creator],
} = await pool.query(`insert into creators (name) values ($1) returning id`, [marker]);
await pool.query(`insert into tracking_targets (workspace_id, kind, creator_id, platforms) values ($1, 'creator', $2, '{x}')`, [workspace.id, creator.id]);
await pool.query(`insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, 'keyword', $2, '{x,reddit}')`, [workspace.id, marker]);
await pool.query(`insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, 'community', $2, '{reddit}')`, [workspace.id, `r/${suffix}`]);
await addCredits(workspace.id, 100, { kind: 'grant', reference: 'test', idempotencyKey: `test:jobs:${suffix}:grant` });

let runId = null;
let boss = null;
try {
  await check('the daily estimate adds up the price list for every active target', async () => {
    assert.equal(await estimateDailyCredits(workspace.id), 80); // creator 20 + keyword 40 + community 20
  });

  await check('a day of tracking is charged per target at price-list credits', async () => {
    const r = await chargeDailyTracking({ date: '2026-01-01', log: quiet, workspaceIds: [workspace.id] });
    assert.equal(r.charged, 3);
    assert.equal(r.credits, 80);
    assert.equal(r.paused, 0);
    assert.equal((await getBalance(workspace.id)).balance, 20);
  });

  await check('re-running the same date charges nothing again and pauses nothing already paid', async () => {
    const r = await chargeDailyTracking({ date: '2026-01-01', log: quiet, workspaceIds: [workspace.id] });
    assert.equal(r.charged, 0);
    assert.equal(r.credits, 0);
    assert.equal(r.paused, 0); // 20 left would not cover the keyword, but it was paid for this date
    assert.ok((await targetsOf(workspace.id)).every((t) => t.active));
    assert.equal((await getBalance(workspace.id)).balance, 20);
  });

  await check('crossing 5% of the trial allowance writes one low_credits warning, once', async () => {
    const rows = (await notificationsOf(workspace.id)).filter((n) => n.note?.startsWith('5% or less left of your 1000 free trial credits.'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'low_credits');
    assert.equal(rows[0].destination, email);
    assert.equal(rows[0].sent_at, null);
  });

  await check('targets the balance cannot cover are paused, not deleted, and the owner is told', async () => {
    const r = await chargeDailyTracking({ date: '2026-01-02', log: quiet, workspaceIds: [workspace.id] });
    // the creator (20) fits, the keyword (40) and community (20) do not
    assert.deepEqual({ charged: r.charged, paused: r.paused, balance: (await getBalance(workspace.id)).balance }, { charged: 1, paused: 2, balance: 0 });
    const targets = await targetsOf(workspace.id);
    assert.equal(targets.length, 3);
    assert.deepEqual(
      targets.map((t) => [t.kind, t.active, t.paused_reason]),
      [
        ['creator', true, null],
        ['keyword', false, 'out_of_credits'],
        ['community', false, 'out_of_credits'],
      ],
    );
    const rows = (await notificationsOf(workspace.id)).filter((n) => n.note?.startsWith('Tracking paused on 2026-01-02: out of credits.'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'low_credits');
    assert.equal(rows[0].destination, email);
  });

  await check('nothing resumes while the balance is still empty', async () => {
    assert.equal(await resumePausedTracking(workspace.id), 0);
  });

  await check('after credits are added, paused targets come back', async () => {
    await addCredits(workspace.id, 100, { kind: 'grant', reference: 'test', idempotencyKey: `test:jobs:${suffix}:grant-2` });
    assert.equal(await resumePausedTracking(workspace.id), 2);
    assert.ok((await targetsOf(workspace.id)).every((t) => t.active && t.paused_reason === null));
  });

  await check('a captured top-up resumes paused tracking by itself', async () => {
    assert.equal((await chargeDailyTracking({ date: '2026-01-03', log: quiet, workspaceIds: [workspace.id] })).paused, 0); // 100 covers the 80
    const r = await chargeDailyTracking({ date: '2026-01-04', log: quiet, workspaceIds: [workspace.id] });
    assert.equal(r.paused, 2); // 20 left: the creator is charged, the other two are paused
    assert.equal((await getBalance(workspace.id)).balance, 0);
    await recordTopupPaid({ provider: 'fake', workspaceId: workspace.id, providerPaymentId: `test_jobs_${suffix}`, providerOrderId: `test_jobs_order_${suffix}`, amountPaise: 10000, credits: 100 });
    assert.equal((await getBalance(workspace.id)).balance, 100);
    assert.ok((await targetsOf(workspace.id)).every((t) => t.active && t.paused_reason === null));
  });

  await check('a run starts as running and finishes with a summary', async () => {
    runId = await startRun('test', { workspaceId: workspace.id });
    const before = (await pool.query('select status, finished_at from runs where id = $1', [runId])).rows[0];
    assert.equal(before.status, 'running');
    assert.equal(before.finished_at, null);
  });

  const cap = dailyCap('gemini');
  await check('spend over the Gemini daily cap stops collection and tells the admin once', async () => {
    process.env.ADMIN_EMAILS = email;
    // The over-cap row would stop real collection too, so it lives only for these few queries.
    const {
      rows: [over],
    } = await pool.query(`insert into cost_events (provider, detail, workspace_id, usd, units) values ('gemini', $1, $2, $3, '{"test": true}') returning id`, [
      `${marker} over cap`,
      workspace.id,
      cap + 1,
    ]);
    try {
      assert.ok((await spentToday('gemini')) >= cap + 1);
      await assert.rejects(() => assertUnderDailyCap('gemini'), SpendCapReached);
      await assert.rejects(() => assertUnderDailyCap('gemini'), SpendCapReached);
    } finally {
      await pool.query('delete from cost_events where id = $1', [over.id]);
    }
    const ops = (await notificationsOf(workspace.id)).filter((n) => n.kind === 'ops');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].destination, email);
    assert.match(ops[0].note, /^Spend cap reached: gemini on \d{4}-\d{2}-\d{2}\n/);
    assert.equal(ops[0].sent_at, null);
  });

  const runUsd = 0.0123;
  await check('a cost event tagged with a run is recorded under the cap', async () => {
    await pool.query(`insert into cost_events (provider, detail, run_id, workspace_id, usd, units) values ('gemini', $1, $2, null, $3, '{"test": true}')`, [marker, runId, runUsd]);
    assert.ok((await spentToday('gemini')) >= runUsd);
  });

  await check('spend under the cap passes', async () => {
    process.env.APIFY_DAILY_CAP_USD = '1000000';
    const r = await assertUnderDailyCap('apify');
    assert.equal(r.cap, 1000000);
    delete process.env.APIFY_DAILY_CAP_USD;
  });

  await check('finishing a run records its status, summary and the cost events tagged with it', async () => {
    const run = await finishRun(runId, { summary: { test: true } });
    assert.equal(run.status, 'done');
    assert.ok(Math.abs(run.usd - runUsd) < 1e-9, `run usd ${run.usd}`);
    const row = (await pool.query('select status, summary, finished_at from runs where id = $1', [runId])).rows[0];
    assert.deepEqual(row.summary, { test: true });
    assert.ok(row.finished_at);
    const listed = await listRuns({ limit: 200 });
    assert.ok(listed.some((r) => r.id === runId && r.workspace_name === marker));
  });

  await check('margin by action reports the tracking charges and attributes shared cost to them', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const rows = await marginByAction({ from, to });
    assert.ok(Array.isArray(rows) && rows.length > 0);
    const creator = rows.find((r) => r.action === 'track_creator_day');
    assert.ok(creator, 'no track_creator_day row');
    assert.ok(creator.credits_charged >= 60); // three days of the test creator
    assert.ok(rows.filter((r) => r.action.startsWith('track_')).reduce((n, r) => n + r.usd_cost, 0) >= runUsd - 0.0001); // shared cost from the run lands on tracking
    for (const r of rows) for (const k of ['action', 'credits_charged', 'revenue_usd', 'usd_cost', 'margin_pct']) assert.ok(k in r, `missing ${k}`);
  });

  await check('cost by day lists today for gemini', async () => {
    const rows = await costByDay({ days: 2 });
    assert.ok(rows.some((r) => r.provider === 'gemini' && r.usd >= runUsd - 0.0001));
  });

  await check('pg-boss starts and every queue exists', async () => {
    boss = await startBoss({ lightweight: true, log: quiet });
    const queues = (await boss.getQueues()).map((q) => q.name);
    for (const name of Object.values(QUEUES)) assert.ok(queues.includes(name), `queue ${name} missing`);
    await boss.stop({ graceful: false, close: true });
    boss = null;
  });
} finally {
  if (boss) await boss.stop({ graceful: false, close: true }).catch(() => {});
  await pool.query(`delete from cost_events where starts_with(detail, $1)`, [marker]);
  if (runId) await pool.query(`delete from runs where id = $1`, [runId]);
  await pool.query(`delete from workspaces where id = $1`, [workspace.id]); // targets, ledger, notifications, payments, membership go with it
  await pool.query(`delete from creators where id = $1`, [creator.id]);
  await pool.query(`delete from users where id = $1`, [user.id]);
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
