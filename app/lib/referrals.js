// Refer a friend. Each workspace has a short code behind a link (/r/CODE). Opening the link
// remembers the code in a cookie; when that visitor's account is created, the new workspace is
// tied to the referrer and gets its welcome bonus. The referrer earns credits once the friend
// has finished (or skipped) first-run setup, capped at REFERRAL.maxRewarded friends.
// Credits move through the ledger like everything else, each with an idempotency key.
import { randomInt } from 'node:crypto';
import { pool, tx } from './db.js';
import { APP_URL, emailLayout, escapeHtml, sendEmail } from './notify.js';
import { REFERRAL } from './pricing.js';

export const REFERRAL_COOKIE = 'cs_ref';

// No 0/O or 1/I: codes get read out loud and typed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const normalizeCode = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isCode = (value) => new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(String(value ?? ''));
export const referralLink = (code) => `${APP_URL()}/r/${code}`;

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

// The workspace's code, created on first use so workspaces from before this feature get one too.
export async function getReferralCode(workspaceId) {
  const found = await pool.query('select referral_code from workspaces where id = $1', [workspaceId]);
  if (!found.rowCount) throw new Error(`Workspace ${workspaceId} not found`);
  if (found.rows[0].referral_code) return found.rows[0].referral_code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    const { rows } = await pool.query(
      `update workspaces set referral_code = $2 where id = $1 and referral_code is null
         and not exists (select 1 from workspaces where referral_code = $2)
       returning referral_code`,
      [workspaceId, code],
    );
    if (rows[0]) return rows[0].referral_code;
    const again = await pool.query('select referral_code from workspaces where id = $1', [workspaceId]);
    if (again.rows[0]?.referral_code) return again.rows[0].referral_code;
  }
  throw new Error('Could not pick a referral code');
}

// Who a code belongs to, for the link page and the sign-up banner. Null for unknown codes.
export async function lookupCode(code, client = pool) {
  const normalized = normalizeCode(code);
  if (!isCode(normalized)) return null;
  const { rows } = await client.query(
    `select w.id as workspace_id, w.name as workspace_name, u.name as owner_name
       from workspaces w
       left join memberships m on m.workspace_id = w.id and m.role = 'owner'
       left join users u on u.id = m.user_id
      where w.referral_code = $1
      order by u.created_at
      limit 1`,
    [normalized],
  );
  return rows[0] ?? null;
}

// Ties a brand-new workspace to the referrer and grants the friend's bonus. Runs inside the
// account-creation transaction on the caller's client. Returns the referral row, or null when the
// code is unknown or the person is referring themselves. Never throws for a bad code.
export async function attachReferral(client, { workspaceId, userId, email, code }) {
  const referrer = await lookupCode(code, client);
  if (!referrer || referrer.workspace_id === workspaceId) return null;
  const self = await client.query(
    'select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and (u.id = $2 or lower(u.email) = lower($3))',
    [referrer.workspace_id, userId, email ?? ''],
  );
  if (self.rowCount) return null;

  const { rows } = await client.query(
    `insert into referrals (referrer_workspace_id, referred_workspace_id, referred_user_id, code)
     values ($1, $2, $3, $4)
     on conflict (referred_workspace_id) do nothing
     returning id, referrer_workspace_id`,
    [referrer.workspace_id, workspaceId, userId, normalizeCode(code)],
  );
  const referral = rows[0];
  if (!referral) return null;
  await client.query(
    `insert into credit_entries (workspace_id, kind, amount, reference, idempotency_key, note)
     values ($1, 'grant', $2, 'referral', $3, $4)
     on conflict (idempotency_key) do nothing`,
    [workspaceId, REFERRAL.friendCredits, `referral:${referral.id}:friend`, `Welcome bonus: invited by ${referrer.workspace_name}`],
  );
  return { id: referral.id, referrerWorkspaceId: referral.referrer_workspace_id, referrerName: referrer.workspace_name };
}

function rewardEmail({ friendName, credits, rewarded, available }) {
  const title = `${friendName} joined Content-Story: ${credits} credits for you`;
  const left = REFERRAL.maxRewarded - rewarded;
  const html = emailLayout(
    title,
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(friendName)} signed up with your link and set up their stories, so ${credits} credits have been added to your workspace. You now have ${available.toLocaleString('en-IN')} credits available.</p>
     <p style="margin:0 0 12px;font-size:15px;line-height:1.5">${left > 0 ? `You can earn credits for ${left} more ${left === 1 ? 'friend' : 'friends'}.` : 'That was the last referral reward for this workspace; friends you invite still get their welcome bonus.'}</p>
     <p style="margin:16px 0 0"><a href="${APP_URL()}/refer" style="display:inline-block;padding:10px 16px;background:#1c1b18;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Share your link</a></p>`,
  );
  const text = `${title}\n\n${friendName} signed up with your link and set up their stories, so ${credits} credits have been added. Share your link: ${APP_URL()}/refer`;
  return { subject: title, html, text };
}

// Pays the referrer once the referred workspace has set up (or skipped setup). Safe to call more
// than once: only a 'joined' referral pays out, and the ledger entry has a fixed key.
export async function rewardReferral(referredWorkspaceId, { log = console.log } = {}) {
  const outcome = await tx(async (client) => {
    const { rows } = await client.query(
      `select r.id, r.status, r.referrer_workspace_id, coalesce(u.name, u.email, w.name) as friend_name
         from referrals r
         join workspaces w on w.id = r.referred_workspace_id
         left join users u on u.id = r.referred_user_id
        where r.referred_workspace_id = $1 for update of r`,
      [referredWorkspaceId],
    );
    const referral = rows[0];
    if (!referral || referral.status !== 'joined') return null;
    await client.query('select 1 from workspaces where id = $1 for update', [referral.referrer_workspace_id]);
    const { rows: counts } = await client.query(`select count(*)::int as rewarded from referrals where referrer_workspace_id = $1 and status = 'rewarded'`, [referral.referrer_workspace_id]);
    if (counts[0].rewarded >= REFERRAL.maxRewarded) {
      await client.query(`update referrals set status = 'capped' where id = $1`, [referral.id]);
      return { status: 'capped', referral };
    }
    await client.query(
      `insert into credit_entries (workspace_id, kind, amount, reference, idempotency_key, note)
       values ($1, 'grant', $2, 'referral', $3, $4)
       on conflict (idempotency_key) do nothing`,
      [referral.referrer_workspace_id, REFERRAL.referrerCredits, `referral:${referral.id}:referrer`, `Referral reward: ${referral.friend_name} joined`],
    );
    await client.query(`update referrals set status = 'rewarded', rewarded_at = now() where id = $1`, [referral.id]);
    const { rows: balance } = await client.query('select balance - held as available from credit_balances where workspace_id = $1', [referral.referrer_workspace_id]);
    return { status: 'rewarded', referral, rewarded: counts[0].rewarded + 1, available: Number(balance[0]?.available ?? 0) };
  });
  if (outcome?.status !== 'rewarded') return outcome?.status ?? null;

  // Tell the owner. A failed email is recorded on its notifications row and never undoes the credits.
  const { rows: owners } = await pool.query(
    `select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role = 'owner' order by u.created_at limit 1`,
    [outcome.referral.referrer_workspace_id],
  );
  if (owners[0]?.email) {
    const email = rewardEmail({ friendName: outcome.referral.friend_name, credits: REFERRAL.referrerCredits, rewarded: outcome.rewarded, available: outcome.available });
    await sendEmail({ ...email, to: owners[0].email, workspaceId: outcome.referral.referrer_workspace_id, kind: 'referral', note: `referral ${outcome.referral.id}`, log });
  }
  return 'rewarded';
}

// Everything the Refer page shows: the link, the numbers, and each friend's state.
export async function getReferralSummary(workspaceId) {
  const code = await getReferralCode(workspaceId);
  const { rows } = await pool.query(
    `select r.id, r.status, r.joined_at, r.rewarded_at, w.name as friend_name, coalesce(u.name, u.email) as friend
       from referrals r
       join workspaces w on w.id = r.referred_workspace_id
       left join users u on u.id = r.referred_user_id
      where r.referrer_workspace_id = $1
      order by r.joined_at desc`,
    [workspaceId],
  );
  const rewarded = rows.filter((r) => r.status === 'rewarded').length;
  return {
    code,
    link: referralLink(code),
    referrals: rows,
    joined: rows.length,
    rewarded,
    pending: rows.filter((r) => r.status === 'joined').length,
    earned: rewarded * REFERRAL.referrerCredits,
    remaining: Math.max(0, REFERRAL.maxRewarded - rewarded),
  };
}
