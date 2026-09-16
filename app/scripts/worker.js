// The background worker: runs every queue and keeps the timetable (daily run, alerts, digest,
// housekeeping) in IST. One instance is enough; a second one shares the work safely.
// Usage: node scripts/worker.js
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { makeLog, registerSchedules, registerWorkers, startBoss } from '../pipeline/jobs.js';

requireEnv('DATABASE_URL');
const log = makeLog('worker');

const boss = await startBoss({ log: makeLog('boss') });
const queues = await registerWorkers(boss, { log });
await registerSchedules(boss, { log });
log(`ready: working ${queues.join(', ')}; caps apify $${process.env.APIFY_DAILY_CAP_USD || 10}/day, gemini $${process.env.GEMINI_DAILY_CAP_USD || 5}/day; admin ${process.env.ADMIN_EMAILS || '(ADMIN_EMAILS not set: no ops emails)'}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: finishing the current job, then stopping`);
  try {
    await boss.stop({ graceful: true, timeout: 60_000, close: true });
    await pool.end();
    log('stopped');
    process.exit(0);
  } catch (err) {
    log(`stop failed: ${err.message}`);
    process.exit(1);
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
boss.on('stopped', () => log('boss stopped'));
