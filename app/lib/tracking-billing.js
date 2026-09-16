// The daily tracking charge. Every active target costs its price_list credits per day, charged
// once per target per date. A workspace that can't cover a target has it paused (never deleted)
// and its owner told; a top-up resumes what was paused. Warnings go out once per threshold per
// billing period as the balance crosses 20% and 5% of the plan's allowance.
import { getPlanState } from './accounts.js';
import { InsufficientCredits, charge, crossedWarning, getBalance } from './credits.js';
import { pool } from './db.js';

export const ACTION_BY_KIND = { creator: 'track_creator_day', keyword: 'track_keyword_day', community: 'track_community_day' };
export const WARNING_SHARES = [0.2, 0.05];

export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

async function ownerEmail(workspaceId) {
  const { rows } = await pool.query(
    `select u.email from memberships m join users u on u.id = m.user_id
      where m.workspace_id = $1 order by (m.role = 'owner') desc, (m.role = 'admin') desc limit 1`,
    [workspaceId],
  );
  return rows[0]?.email ?? null;
}

// Writes a notification unless the workspace already has one whose note starts with `key`.
// The note is what the owner reads; the key is its stable opening, so it is written once.
async function notifyOnce(workspaceId, kind, destination, key, rest = '') {
  if (!destination) return false;
  const { rowCount } = await pool.query(
    `insert into notifications (workspace_id, kind, destination, note)
     select $1, $2, $3, $4
      where not exists (select 1 from notifications where workspace_id = $1 and kind = $2 and starts_with(note, $5))`,
    [workspaceId, kind, destination, key + rest, key],
  );
  return rowCount === 1;
}

async function prices() {
  const { rows } = await pool.query(`select action, credits from price_list where action = any($1::text[])`, [Object.values(ACTION_BY_KIND)]);
  return Object.fromEntries(rows.map((r) => [r.action, r.credits]));
}

// The allowance a warning is measured against, in words: the current plan period, or the trial.
function periodLabel(plan) {
  if (!plan.planId) return `your ${plan.allowance} free trial credits`;
  const ends = plan.periodEnd ? ` for the period ending ${new Date(plan.periodEnd).toISOString().slice(0, 10)}` : '';
  return `your ${plan.name} plan's ${plan.allowance} credits${ends}`;
}

// Charges every active target of every workspace (or of `workspaceIds` only, used by tests) for
// the given IST date. Idempotent per target and date.
export async function chargeDailyTracking({ date = todayIST(), log = console.log, workspaceIds = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date must be YYYY-MM-DD, got "${date}"`);
  const { rows: targets } = await pool.query(
    `select t.id, t.kind::text as kind, t.workspace_id
       from tracking_targets t
      where t.active and ($1::uuid[] is null or t.workspace_id = any($1::uuid[]))
      order by t.workspace_id, t.created_at, t.id`,
    [workspaceIds],
  );

  // Targets already charged for this date are skipped up front: charge() checks the balance before
  // its idempotency key, so a re-run on a low balance would otherwise pause a target that was paid.
  const keyOf = (t) => `track:${t.id}:${date}`;
  const { rows: done } = await pool.query(`select idempotency_key from credit_entries where idempotency_key = any($1::text[])`, [targets.map(keyOf)]);
  const alreadyCharged = new Set(done.map((r) => r.idempotency_key));

  const byWorkspace = new Map();
  for (const t of targets) {
    if (alreadyCharged.has(keyOf(t))) continue;
    (byWorkspace.get(t.workspace_id) ?? byWorkspace.set(t.workspace_id, []).get(t.workspace_id)).push(t);
  }

  const totals = { charged: 0, paused: 0, warned: 0, credits: 0, workspaces: byWorkspace.size };
  for (const [workspaceId, list] of byWorkspace) {
    const plan = await getPlanState(workspaceId);
    const period = periodLabel(plan);
    let email = null;
    let pausedHere = 0;
    for (const target of list) {
      const action = ACTION_BY_KIND[target.kind];
      if (!action) continue;
      let result;
      try {
        result = await charge(workspaceId, action, 1, { reference: `track:${date}`, idempotencyKey: keyOf(target) });
      } catch (err) {
        if (!(err instanceof InsufficientCredits)) throw err;
        const { rowCount } = await pool.query(
          `update tracking_targets set active = false, paused_reason = 'out_of_credits' where id = $1 and active`,
          [target.id],
        );
        if (rowCount) {
          totals.paused += 1;
          pausedHere += 1;
        }
        continue;
      }
      if (!result.applied) continue; // already charged for this date
      totals.charged += 1;
      totals.credits += result.credits;
      const share = crossedWarning(result.balance + result.credits, result.balance, plan.allowance, WARNING_SHARES);
      if (share != null) {
        email ??= await ownerEmail(workspaceId);
        const pct = Math.round(share * 100);
        // The opening names only the threshold and period, so it is written once per period.
        if (await notifyOnce(workspaceId, 'low_credits', email, `${pct}% or less left of ${period}.`, ` ${result.balance} credits remain.`)) {
          totals.warned += 1;
        }
      }
    }
    if (pausedHere) {
      email ??= await ownerEmail(workspaceId);
      await notifyOnce(
        workspaceId,
        'low_credits',
        email,
        `Tracking paused on ${date}: out of credits.`,
        ` ${pausedHere} tracked ${pausedHere === 1 ? 'source was' : 'sources were'} paused, not removed. Top up and they resume on their own.`,
      );
      log(`workspace ${workspaceId}: paused ${pausedHere} target(s), out of credits`);
    }
  }
  log(`tracking ${date}: charged ${totals.charged} target(s) for ${totals.credits} credits across ${totals.workspaces} workspace(s); paused ${totals.paused}; warned ${totals.warned}`);
  return totals;
}

// Credits per day for the workspace's active targets.
export async function estimateDailyCredits(workspaceId) {
  const { rows } = await pool.query(
    `select coalesce(sum(p.credits), 0)::int as credits
       from tracking_targets t
       join price_list p on p.action = case t.kind::text
         when 'creator' then 'track_creator_day' when 'keyword' then 'track_keyword_day' when 'community' then 'track_community_day' end
      where t.workspace_id = $1 and t.active`,
    [workspaceId],
  );
  return rows[0].credits;
}

// Re-activates targets paused for 'out_of_credits', oldest first, as far as the available balance
// covers a day of everything active plus what is resumed. Returns how many were resumed.
export async function resumePausedTracking(workspaceId) {
  const { rows: paused } = await pool.query(
    `select id, kind::text as kind from tracking_targets
      where workspace_id = $1 and not active and paused_reason = 'out_of_credits'
      order by created_at, id`,
    [workspaceId],
  );
  if (!paused.length) return 0;
  const price = await prices();
  const { available } = await getBalance(workspaceId);
  let dayCost = await estimateDailyCredits(workspaceId);
  const resume = [];
  for (const t of paused) {
    const cost = price[ACTION_BY_KIND[t.kind]] ?? 0;
    if (dayCost + cost > available) break;
    dayCost += cost;
    resume.push(t.id);
  }
  if (!resume.length) return 0;
  const { rowCount } = await pool.query(
    `update tracking_targets set active = true, paused_reason = null
      where id = any($1::uuid[]) and not active and paused_reason = 'out_of_credits'`,
    [resume],
  );
  return rowCount;
}

// Workspaces with at least one target paused for credits, for housekeeping.
export async function workspacesWithPausedTracking() {
  const { rows } = await pool.query(`select distinct workspace_id from tracking_targets where not active and paused_reason = 'out_of_credits'`);
  return rows.map((r) => r.workspace_id);
}
