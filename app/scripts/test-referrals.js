// End-to-end check of referrals against the real database. Creates throwaway accounts, walks a
// friend through a referral link, sign-up and setup, checks both ledgers, then deletes everything.
// Usage: node scripts/test-referrals.js
import assert from 'node:assert/strict';
import { ensureAccount, skipOnboarding } from '../lib/accounts.js';
import { getBalance, listLedger } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { REFERRAL, TRIAL } from '../lib/pricing.js';
import { getReferralCode, getReferralSummary, isCode, lookupCode, normalizeCode, referralLink, rewardReferral } from '../lib/referrals.js';

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
const accounts = [];
const signIn = async (tag, name, referralCode = null) => {
  const session = await ensureAccount(`test:${suffix}:${tag}`, async () => ({ email: `referral-test-${suffix}-${tag}@content-story.dev`, name, referralCode }));
  if (!accounts.some((a) => a.workspace.id === session.workspace.id)) accounts.push(session);
  return session;
};
const grants = async (workspaceId) => (await listLedger(workspaceId)).filter((e) => e.reference === 'referral');

const originalCap = REFERRAL.maxRewarded;
try {
  let referrer;
  let code;
  await check('a workspace gets one stable referral code and a link', async () => {
    referrer = await signIn('ref', 'Referring Person');
    code = await getReferralCode(referrer.workspace.id);
    assert.ok(isCode(code), `code ${code} is not valid`);
    assert.equal(await getReferralCode(referrer.workspace.id), code);
    assert.equal(referralLink(code), `${referralLink('').replace(/\/$/, '')}/${code}`);
    assert.match(referralLink(code), /\/r\/[A-Z2-9]{8}$/);
  });

  await check('a code is found however it is typed; unknown codes are not', async () => {
    const found = await lookupCode(` ${code.toLowerCase()} `);
    assert.equal(found?.workspace_id, referrer.workspace.id);
    assert.equal(normalizeCode('ab-cd ef'), 'ABCDEF');
    assert.equal(await lookupCode('ZZZZZZZZ'), null);
    assert.equal(await lookupCode('not a code'), null);
  });

  let friend;
  await check('a friend who signs up with the code starts with the trial plus the welcome bonus', async () => {
    friend = await signIn('friend', 'Invited Person', code);
    assert.equal((await getBalance(friend.workspace.id)).balance, TRIAL.credits + REFERRAL.friendCredits);
    const [bonus] = await grants(friend.workspace.id);
    assert.equal(bonus.kind, 'grant');
    assert.equal(bonus.amount, REFERRAL.friendCredits);
    assert.match(bonus.note, /invited by/i);
    const { rows } = await pool.query('select status, referrer_workspace_id from referrals where referred_workspace_id = $1', [friend.workspace.id]);
    assert.equal(rows[0].status, 'joined');
    assert.equal(rows[0].referrer_workspace_id, referrer.workspace.id);
  });

  await check('the referrer earns nothing until the friend has set up', async () => {
    assert.equal((await getBalance(referrer.workspace.id)).balance, TRIAL.credits);
    const summary = await getReferralSummary(referrer.workspace.id);
    assert.equal(summary.joined, 1);
    assert.equal(summary.pending, 1);
    assert.equal(summary.rewarded, 0);
    assert.equal(summary.earned, 0);
  });

  await check('finishing setup pays the referrer once, and emails them', async () => {
    await skipOnboarding(friend.workspace.id);
    assert.equal(await rewardReferral(friend.workspace.id, { log: () => {} }), 'rewarded');
    assert.equal(await rewardReferral(friend.workspace.id, { log: () => {} }), null);
    assert.equal((await getBalance(referrer.workspace.id)).balance, TRIAL.credits + REFERRAL.referrerCredits);
    const [reward] = await grants(referrer.workspace.id);
    assert.equal(reward.amount, REFERRAL.referrerCredits);
    assert.match(reward.note, /Invited Person joined/);
    const summary = await getReferralSummary(referrer.workspace.id);
    assert.equal(summary.rewarded, 1);
    assert.equal(summary.earned, REFERRAL.referrerCredits);
    assert.equal(summary.remaining, REFERRAL.maxRewarded - 1);
    const { rows } = await pool.query(`select count(*)::int as n from notifications where workspace_id = $1 and kind = 'referral' and sent_at is not null`, [referrer.workspace.id]);
    assert.equal(rows[0].n, 1);
  });

  await check('signing in again never grants the bonus twice', async () => {
    await signIn('friend', 'Invited Person', code);
    assert.equal((await getBalance(friend.workspace.id)).balance, TRIAL.credits + REFERRAL.friendCredits);
    assert.equal((await grants(friend.workspace.id)).length, 1);
  });

  await check('referring yourself does nothing', async () => {
    const again = await ensureAccount(`test:${suffix}:self`, async () => ({ email: referrer.user.email, name: 'Referring Person', referralCode: code }));
    assert.equal(again.workspace.id, referrer.workspace.id);
    const { rows } = await pool.query('select count(*)::int as n from referrals where referrer_workspace_id = $1', [referrer.workspace.id]);
    assert.equal(rows[0].n, 1);
  });

  await check('an unknown code still creates the account, without a bonus', async () => {
    const stranger = await signIn('stranger', 'Stranger', 'ZZZZZZZZ');
    assert.equal((await getBalance(stranger.workspace.id)).balance, TRIAL.credits);
    const { rows } = await pool.query('select 1 from referrals where referred_workspace_id = $1', [stranger.workspace.id]);
    assert.equal(rows.length, 0);
  });

  await check('past the cap the friend keeps the bonus but the referrer is not paid', async () => {
    REFERRAL.maxRewarded = 1;
    const late = await signIn('late', 'Late Friend', code);
    assert.equal((await getBalance(late.workspace.id)).balance, TRIAL.credits + REFERRAL.friendCredits);
    await skipOnboarding(late.workspace.id);
    assert.equal(await rewardReferral(late.workspace.id, { log: () => {} }), 'capped');
    assert.equal((await getBalance(referrer.workspace.id)).balance, TRIAL.credits + REFERRAL.referrerCredits);
    const summary = await getReferralSummary(referrer.workspace.id);
    assert.equal(summary.joined, 2);
    assert.equal(summary.remaining, 0);
    assert.equal(summary.referrals.find((r) => r.friend_name.startsWith('Late'))?.status, 'capped');
  });

  await check('the balance always equals the sum of ledger entries', async () => {
    for (const a of accounts) {
      const { rows } = await pool.query('select coalesce(sum(amount), 0)::int as total from credit_entries where workspace_id = $1', [a.workspace.id]);
      assert.equal(rows[0].total, (await getBalance(a.workspace.id)).balance);
    }
  });
} finally {
  REFERRAL.maxRewarded = originalCap;
  for (const account of accounts) {
    await pool.query('delete from workspaces where id = $1', [account.workspace.id]);
    await pool.query('delete from users where id = $1', [account.user.id]);
  }
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
