// The background worker: runs every queue and keeps the IST timetable. Collection and digest times
// come from the admin settings and are re-checked every minute; one instance is enough.
// Usage: node scripts/worker.js
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { getSettings } from '../lib/settings.js';
import { makeLog, registerSchedules, registerWorkers, startBoss, watchSchedules } from '../pipeline/jobs.js';

requireEnv('DATABASE_URL');
const log = makeLog('worker');

const boss = await startBoss({ log: makeLog('boss') });
const queues = await registerWorkers(boss, { log });
const schedules = await registerSchedules(boss, { log, settings: await getSettings() });
const watcher = watchSchedules(boss, { current: schedules, log });
log(`ready: working ${queues.join(', ')}; caps apify $${process.env.APIFY_DAILY_CAP_USD || 10}/day, gemini $${process.env.GEMINI_DAILY_CAP_USD || 5}/day; admin ${process.env.ADMIN_EMAILS || '(ADMIN_EMAILS not set: no ops emails)'}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: finishing the current job, then stopping`);
  watcher.stop();
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
