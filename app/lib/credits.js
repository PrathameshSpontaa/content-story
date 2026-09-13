// Credit ledger. Every change is an append-only entry in credit_entries; a balance is a sum.
// Each entry carries an idempotency key, so a retried job or a replayed webhook can never
// charge or grant twice. Spending locks the workspace row so concurrent jobs can't overdraw.
import { pool, tx } from './db.js';

export class InsufficientCredits extends Error {
  constructor(needed, available) {
    super(`This needs ${needed} credits and ${available} are available.`);
    this.name = 'InsufficientCredits';
    this.needed = needed;
    this.available = available;
  }
}

export async function getBalance(workspaceId, client = pool) {
  const { rows } = await client.query('select balance, held from credit_balances where workspace_id = $1', [workspaceId]);
  const balance = Number(rows[0]?.balance ?? 0);
  const held = Number(rows[0]?.held ?? 0);
  return { balance, held, available: balance - held };
}

async function lockWorkspace(client, workspaceId) {
  const { rowCount } = await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
  if (!rowCount) throw new Error(`Workspace ${workspaceId} not found`);
}

// Returns true when the entry was written, false when the idempotency key was already used.
async function addEntry(client, { workspaceId, kind, amount, action = null, reference = null, idempotencyKey, note = null }) {
  if (!idempotencyKey) throw new Error('Every credit entry needs an idempotency key');
  const { rowCount } = await client.query(
    `insert into credit_entries (workspace_id, kind, amount, action, reference, idempotency_key, note)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (idempotency_key) do nothing`,
    [workspaceId, kind, amount, action, reference, idempotencyKey, note],
  );
  return rowCount === 1;
}

async function creditsFor(client, action, units) {
  const { rows } = await client.query('select credits from price_list where action = $1', [action]);
  if (!rows[0]) throw new Error(`No price set for action "${action}"`);
  return Math.ceil(rows[0].credits * units);
}

// Adds credits: plan renewals ('grant'), paid top-ups ('purchase'), or 'refund'.
export function addCredits(workspaceId, credits, { kind = 'grant', reference, idempotencyKey, note } = {}) {
  if (!(credits > 0)) throw new Error('Credits to add must be positive');
  return tx(async (client) => {
    await lockWorkspace(client, workspaceId);
    const applied = await addEntry(client, { workspaceId, kind, amount: credits, reference, idempotencyKey, note });
    return { applied, ...(await getBalance(workspaceId, client)) };
  });
}

// Spends credits for an action priced in price_list, e.g. charge(ws, 'track_creator_day', 12, ...).
// Throws InsufficientCredits instead of going negative.
export function charge(workspaceId, action, units, { reference, idempotencyKey } = {}) {
  return tx(async (client) => {
    await lockWorkspace(client, workspaceId);
    const credits = await creditsFor(client, action, units);
    if (credits === 0) return { applied: false, credits: 0, ...(await getBalance(workspaceId, client)) };
    const before = await getBalance(workspaceId, client);
    if (credits > before.available) throw new InsufficientCredits(credits, before.available);
    const applied = await addEntry(client, { workspaceId, kind: 'debit', amount: -credits, action, reference, idempotencyKey });
    return { applied, credits, ...(await getBalance(workspaceId, client)) };
  });
}

// Holds credits for a run whose final cost isn't known yet (on-demand reports).
export function reserve(workspaceId, credits, { reference, ttlMinutes = 180 } = {}) {
  if (!(credits > 0)) throw new Error('Credits to reserve must be positive');
  return tx(async (client) => {
    await lockWorkspace(client, workspaceId);
    const { available } = await getBalance(workspaceId, client);
    if (credits > available) throw new InsufficientCredits(credits, available);
    const { rows } = await client.query(
      `insert into credit_reservations (workspace_id, credits, reference, expires_at)
       values ($1, $2, $3, now() + make_interval(mins => $4))
       returning id`,
      [workspaceId, credits, reference, ttlMinutes],
    );
    return rows[0].id;
  });
}

// Charges what the run actually used, never more than was quoted, and frees the rest.
export function settle(reservationId, usedCredits, { action = 'report', idempotencyKey } = {}) {
  return tx(async (client) => {
    const { rows } = await client.query('select * from credit_reservations where id = $1 for update', [reservationId]);
    const reservation = rows[0];
    if (!reservation) throw new Error(`Reservation ${reservationId} not found`);
    if (reservation.status !== 'held') return { applied: false, credits: 0, status: reservation.status };
    await lockWorkspace(client, reservation.workspace_id);
    const credits = Math.min(Math.max(0, Math.ceil(usedCredits)), reservation.credits);
    await client.query(`update credit_reservations set status = 'settled' where id = $1`, [reservationId]);
    const applied = credits > 0
      ? await addEntry(client, {
          workspaceId: reservation.workspace_id,
          kind: 'debit',
          amount: -credits,
          action,
          reference: reservation.reference,
          idempotencyKey: idempotencyKey ?? `settle:${reservationId}`,
        })
      : false;
    return { applied, credits, status: 'settled' };
  });
}

export async function release(reservationId) {
  const { rowCount } = await pool.query(`update credit_reservations set status = 'released' where id = $1 and status = 'held'`, [reservationId]);
  return rowCount === 1;
}

// Frees reservations left behind by runs that crashed; call from a scheduled job.
export async function releaseExpired() {
  const { rowCount } = await pool.query(`update credit_reservations set status = 'released' where status = 'held' and expires_at < now()`);
  return rowCount;
}

// Which low-balance warning (if any) a spend just crossed, relative to the plan's monthly allowance.
export function crossedWarning(before, after, allowance, shares = [0.2, 0.05]) {
  if (!(allowance > 0)) return null;
  return shares.find((share) => before > allowance * share && after <= allowance * share) ?? null;
}
