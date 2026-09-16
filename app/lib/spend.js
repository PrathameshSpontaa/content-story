// Global daily safety caps on what we spend at Apify and Gemini, independent of customer credits.
// A collector calls assertUnderDailyCap before each paid call; when the cap is reached it stops,
// and the admin is told once per provider per day through the notifications table.
import { pool } from './db.js';

const CAPS = {
  apify: { env: 'APIFY_DAILY_CAP_USD', fallback: 10 },
  gemini: { env: 'GEMINI_DAILY_CAP_USD', fallback: 5 },
};

export class SpendCapReached extends Error {
  constructor(provider, spent, cap) {
    super(`The ${provider} daily spend cap of $${cap} is reached ($${spent.toFixed(4)} spent today).`);
    this.name = 'SpendCapReached';
    this.provider = provider;
    this.spent = spent;
    this.cap = cap;
  }
}

export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const adminEmails = () =>
  (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function dailyCap(provider) {
  const cap = CAPS[provider];
  if (!cap) throw new Error(`Unknown provider "${provider}"; expected apify or gemini`);
  const value = Number(process.env[cap.env]);
  return Number.isFinite(value) && value >= 0 ? value : cap.fallback;
}

// USD spent with a provider since midnight IST today.
export async function spentToday(provider) {
  const { rows } = await pool.query(
    `select coalesce(sum(usd), 0)::float as usd
       from cost_events
      where provider = $1
        and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`,
    [provider],
  );
  return rows[0].usd;
}

// Writes one 'ops' notification for the admin (the first address in ADMIN_EMAILS). The row goes on
// the first workspace an admin owns, or on no workspace. The note's first line is the email subject;
// with dedupe, a note whose first line was already written is not written again.
export async function notifyOps(note, { dedupe = true } = {}) {
  const emails = adminEmails();
  if (!emails.length) return false;
  const firstLine = String(note).split('\n')[0];
  const { rowCount } = await pool.query(
    `insert into notifications (workspace_id, kind, destination, note)
     select (select m.workspace_id
               from memberships m join users u on u.id = m.user_id
              where m.role = 'owner' and lower(u.email) = any($3::text[])
              order by array_position($3::text[], lower(u.email)), m.workspace_id
              limit 1),
            'ops', $1, $2
      where not ($4::boolean and exists (select 1 from notifications n where n.kind = 'ops' and starts_with(n.note, $5)))`,
    [emails[0], note, emails, dedupe, firstLine],
  );
  return rowCount === 1;
}

// Throws SpendCapReached when today's spend with the provider has reached its cap.
export async function assertUnderDailyCap(provider) {
  const cap = dailyCap(provider);
  const spent = await spentToday(provider);
  if (spent < cap) return { spent, cap };
  // The first line names the provider and day, so the admin is told once per provider per day.
  await notifyOps(
    `Spend cap reached: ${provider} on ${todayIST()}\n` +
      `$${spent.toFixed(4)} spent since 00:00 IST against a daily cap of $${cap} (${CAPS[provider].env}).\n` +
      `Paid ${provider} calls stop until midnight IST. Raise the cap in the Render environment to continue today.`,
  );
  throw new SpendCapReached(provider, spent, cap);
}
