// Users, workspaces and plans. An account is created on first sign-in: one user, a workspace
// they own, and free trial credits granted once (by idempotency key).
import { pool, tx } from './db.js';
import { TRIAL } from './pricing.js';

const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const MEMBER = `
  select u.id as user_id, u.email, u.name, m.role,
         w.id as workspace_id, w.name as workspace_name, w.gstin, w.billing_state, w.created_at as workspace_created_at,
         w.onboarded_at, w.use_case
    from users u
    join memberships m on m.user_id = u.id
    join workspaces w on w.id = m.workspace_id
   where u.clerk_user_id = $1
   order by w.created_at
   limit 1`;

function toSession(row) {
  return {
    user: { id: row.user_id, email: row.email, name: row.name },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      gstin: row.gstin,
      billingState: row.billing_state,
      createdAt: row.workspace_created_at,
      onboardedAt: row.onboarded_at,
      useCase: row.use_case,
    },
    role: row.role,
    isAdmin: adminEmails().includes(String(row.email).toLowerCase()),
  };
}

function workspaceName(name, email) {
  const first = String(name ?? '').trim().split(/\s+/)[0] || email.split('@')[0];
  return `${first}’s workspace`;
}

export async function ensureAccount(clerkUserId, loadProfile) {
  const found = await pool.query(MEMBER, [clerkUserId]);
  if (found.rows[0]) return toSession(found.rows[0]);

  const profile = await loadProfile();
  const email = String(profile?.email ?? '').trim();
  if (!email) throw new Error('Your account has no email address. Add one to your profile, then sign in again.');

  await tx(async (client) => {
    // A page and its prefetch can both arrive first; only one of them creates the workspace.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [clerkUserId]);
    let userId = (await client.query('select id from users where clerk_user_id = $1', [clerkUserId])).rows[0]?.id;
    if (!userId) {
      const byEmail = (await client.query('select id from users where lower(email) = lower($1)', [email])).rows[0];
      userId = byEmail
        ? (await client.query('update users set clerk_user_id = $1, name = coalesce(name, $2) where id = $3 returning id', [clerkUserId, profile.name, byEmail.id])).rows[0].id
        : (await client.query('insert into users (email, name, clerk_user_id) values ($1, $2, $3) returning id', [email, profile.name, clerkUserId])).rows[0].id;
    }
    if ((await client.query('select 1 from memberships where user_id = $1', [userId])).rowCount) return;

    const workspaceId = (await client.query('insert into workspaces (name) values ($1) returning id', [workspaceName(profile.name, email)])).rows[0].id;
    await client.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [workspaceId, userId]);
    await client.query(
      `insert into credit_entries (workspace_id, kind, amount, reference, idempotency_key, note)
       values ($1, 'grant', $2, 'trial', $3, 'Free trial credits')
       on conflict (idempotency_key) do nothing`,
      [workspaceId, TRIAL.credits, `trial:${workspaceId}`],
    );
  });

  return toSession((await pool.query(MEMBER, [clerkUserId])).rows[0]);
}

// The workspace's active plan, or the free trial when it has no subscription.
export async function getPlanState(workspaceId) {
  const { rows } = await pool.query(
    `select p.id, p.name, p.credits_per_period, p.max_tracked_creators, p.max_tracked_keywords, p.max_seats, s.status, s.current_period_end
       from subscriptions s
       join plans p on p.id = s.plan_id
      where s.workspace_id = $1 and s.status in ('active', 'past_due')
      order by s.created_at desc
      limit 1`,
    [workspaceId],
  );
  const r = rows[0];
  if (!r) {
    return { planId: null, name: 'Free trial', status: 'trial', allowance: TRIAL.credits, maxSources: TRIAL.maxSources, maxKeywords: TRIAL.maxKeywords, seats: TRIAL.seats, periodEnd: null };
  }
  return {
    planId: r.id,
    name: r.name,
    status: r.status,
    allowance: r.credits_per_period,
    maxSources: r.max_tracked_creators,
    maxKeywords: r.max_tracked_keywords,
    seats: r.max_seats,
    periodEnd: r.current_period_end,
  };
}

export async function listPlans() {
  const { rows } = await pool.query(
    `select id, name, price_paise, credits_per_period, max_tracked_creators, max_tracked_keywords, max_seats
       from plans where active and id not like 'test_plan_%' order by price_paise`,
  );
  return rows;
}

export async function listPriceList() {
  const { rows } = await pool.query('select action, credits, unit from price_list order by credits desc');
  return Object.fromEntries(rows.map((r) => [r.action, r]));
}

export async function skipOnboarding(workspaceId) {
  await pool.query('update workspaces set onboarded_at = coalesce(onboarded_at, now()) where id = $1', [workspaceId]);
}

export async function updateWorkspace(workspaceId, { name, gstin, billingState }) {
  await pool.query('update workspaces set name = $2, gstin = $3, billing_state = $4 where id = $1', [workspaceId, name, gstin || null, billingState || null]);
}

export async function listMembers(workspaceId) {
  const { rows } = await pool.query(
    `select u.email, u.name, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 order by m.role, u.email`,
    [workspaceId],
  );
  return rows;
}
