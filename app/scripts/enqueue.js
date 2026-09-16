// Sends one job and exits, for Render cron jobs that don't run a worker of their own. The daily job
// is keyed by IST date and hour, so a slot is queued once however many times this runs.
// Usage: node scripts/enqueue.js <daily|alerts|digest|housekeeping> [--date YYYY-MM-DD]
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { QUEUES, enqueue, makeLog, startBoss } from '../pipeline/jobs.js';

requireEnv('DATABASE_URL');
const log = makeLog('enqueue');
const args = process.argv.slice(2);
const queue = args.find((a) => !a.startsWith('--'));
const dateIndex = args.indexOf('--date');
const date = dateIndex >= 0 ? args[dateIndex + 1] : undefined;

const allowed = [QUEUES.daily, QUEUES.alerts, QUEUES.digest, QUEUES.housekeeping];
if (!allowed.includes(queue)) {
  console.error(`Usage: node scripts/enqueue.js <${allowed.join('|')}> [--date YYYY-MM-DD]`);
  process.exit(2);
}

const boss = await startBoss({ lightweight: true, log: makeLog('boss') });
try {
  const data = queue === QUEUES.daily && date ? { date } : {};
  const id = await enqueue(boss, queue, data);
  log(id ? `sent ${queue} job ${id}${date ? ` for ${date}` : ''}` : `${queue} is already queued${queue === QUEUES.daily ? ' for this IST hour' : ''}${date ? ` (${date})` : ''}; nothing sent`);
} finally {
  await boss.stop({ graceful: false, close: true });
  await pool.end();
}
