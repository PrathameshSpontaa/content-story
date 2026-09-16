// Prints margin per action (credits charged against what the work cost us) and provider cost
// per day, from the real ledger and cost events.
// Usage: node scripts/margin.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days 14]
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { costByDay, marginByAction, usdPerCredit } from '../lib/metering.js';

requireEnv('DATABASE_URL');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(opt('--days')) || 14;
const from = opt('--from');
const to = opt('--to');

try {
  const margin = await marginByAction({ from, to });
  console.log(`Margin by action, ${from ?? 'last 30 days'} to ${to ?? 'now'} (a credit is worth $${usdPerCredit().toFixed(4)} to us):`);
  if (margin.length) console.table(margin);
  else console.log('  no charges or costs in this window');

  const cost = await costByDay({ days });
  console.log(`\nProvider cost per day, last ${days} days (IST):`);
  if (cost.length) console.table(cost);
  else console.log('  no cost events yet');
} finally {
  await pool.end();
}
