// Runs the daily job inline, without pg-boss: for a manual run, a re-run of a day, or a cron-only
// deployment with no worker. Collects first and charges only after collection succeeds; without
// pipeline/index.js the run fails and charges nothing. Re-running a date charges nothing twice.
// Usage: node scripts/run-daily.js [--date YYYY-MM-DD] [--dry]
//   --dry   charge nothing and collect nothing; print what each workspace would be charged
import { getBalance } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { estimateDailyCredits, todayIST } from '../lib/tracking-billing.js';
import { makeLog, runDailyJob } from '../pipeline/jobs.js';

requireEnv('DATABASE_URL');
const args = process.argv.slice(2);
const dateIndex = args.indexOf('--date');
const date = dateIndex >= 0 ? args[dateIndex + 1] : todayIST();
const dry = args.includes('--dry');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('Usage: node scripts/run-daily.js [--date YYYY-MM-DD] [--dry]');
  process.exit(2);
}
const log = makeLog('daily');

try {
  if (dry) {
    const { rows } = await pool.query(
      `select w.id, w.name, count(*) filter (where t.active)::int as active, count(*) filter (where t.paused_reason = 'out_of_credits')::int as paused
         from workspaces w join tracking_targets t on t.workspace_id = w.id
        group by w.id order by w.created_at`,
    );
    const table = [];
    let total = 0;
    for (const w of rows) {
      const credits = await estimateDailyCredits(w.id);
      const { available } = await getBalance(w.id);
      total += Math.min(credits, Math.max(0, available));
      table.push({ workspace: w.name, targets: w.active, paused: w.paused, credits_per_day: credits, available, outcome: credits <= available ? 'charged' : 'some targets paused' });
    }
    log(`dry run for ${date}: ${rows.length} workspace(s) with tracking; about ${total} credits would be charged; nothing was charged or collected`);
    console.table(table);
  } else {
    const result = await runDailyJob({ date, log });
    log(`run ${result.runId} finished: ${JSON.stringify(result.billing)}`);
  }
} finally {
  await pool.end();
}
