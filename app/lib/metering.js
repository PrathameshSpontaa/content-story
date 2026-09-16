// Margin per action: credits charged to customers (credit_entries debits) next to what the work
// cost us (cost_events), grouped by action. Report, alert and digest costs are tied to their runs;
// the rest is shared collection, spread over the tracking actions in proportion to credits charged.
import { pool } from './db.js';

// What a credit is worth to us in USD: the top-up price in paise, converted at USD_INR (as admin.js).
export function usdPerCredit() {
  const paise = Number(process.env.TOPUP_PAISE_PER_CREDIT || 100);
  const inrPerUsd = Number(process.env.USD_INR || 84);
  return paise / 100 / inrPerUsd;
}

const ACTION_OF_RUN = `case r.kind when 'report' then 'report' when 'alerts' then 'alert' when 'digest' then 'digest' end`;

export async function marginByAction({ from, to } = {}) {
  const fromTs = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
  const toTs = to ? new Date(to) : new Date();
  const { rows } = await pool.query(
    `with charged as (
       select action, -sum(amount)::int as credits
         from credit_entries
        where kind = 'debit' and action is not null and created_at >= $1 and created_at < $2
        group by action
     ),
     costs as (
       select ${ACTION_OF_RUN} as action, sum(c.usd)::float as usd
         from cost_events c left join runs r on r.id = c.run_id
        where c.created_at >= $1 and c.created_at < $2
        group by 1
     )
     select coalesce(ch.action, co.action) as action, coalesce(ch.credits, 0) as credits, coalesce(co.usd, 0) as usd
       from charged ch full outer join costs co on co.action = ch.action`,
    [fromTs, toTs],
  );

  const shared = rows.find((r) => r.action === null)?.usd ?? 0;
  const actions = rows.filter((r) => r.action !== null).map((r) => ({ action: r.action, credits: Number(r.credits), usd: Number(r.usd) }));
  const tracking = actions.filter((r) => r.action.startsWith('track_'));
  const trackingCredits = tracking.reduce((n, r) => n + r.credits, 0);
  if (shared > 0) {
    if (trackingCredits > 0) for (const r of tracking) r.usd += (shared * r.credits) / trackingCredits;
    else actions.push({ action: 'track_(unattributed)', credits: 0, usd: shared });
  }

  const rate = usdPerCredit();
  return actions
    .map((r) => {
      const revenue = r.credits * rate;
      return {
        action: r.action,
        credits_charged: r.credits,
        revenue_usd: Number(revenue.toFixed(4)),
        usd_cost: Number(r.usd.toFixed(4)),
        margin_pct: revenue > 0 ? Number((((revenue - r.usd) / revenue) * 100).toFixed(1)) : null,
      };
    })
    .sort((a, b) => a.action.localeCompare(b.action));
}

export async function costByDay({ days = 14 } = {}) {
  const { rows } = await pool.query(
    `select (created_at at time zone 'Asia/Kolkata')::date::text as day, provider, sum(usd)::float as usd, count(*)::int as events
       from cost_events
      where created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') - make_interval(days => $1 - 1)) at time zone 'Asia/Kolkata'
      group by 1, 2
      order by 1 desc, 2`,
    [Math.max(1, Number(days) || 14)],
  );
  return rows.map((r) => ({ ...r, usd: Number(r.usd.toFixed(4)) }));
}
