// The job system on pg-boss: one queue each for the scheduled collection run, on-demand refreshes,
// reports, alerts, digests and housekeeping. Handlers are plain functions so run-daily.js and tests
// can call them without a queue. Collection and digest times come from app_settings, re-read by the
// worker every minute. The pipeline, alerts, digests and the notifier are loaded on demand.
import { PgBoss } from 'pg-boss';
import { release, releaseExpired } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { updateReport } from '../lib/reports.js';
import { finishRun, startRun } from '../lib/runs.js';
import { notifyOps, todayIST } from '../lib/spend.js';
import { CAP_REACHED_ERROR, REFRESH_QUEUE, REFRESH_QUEUE_OPTIONS, istSlot, markRefreshRequest, sweepStaleRefreshRequests } from '../lib/refresh.js';
import { DEFAULTS, getSettings, refreshCron, refreshHours } from '../lib/settings.js';
import { chargeDailyTracking, resumePausedTracking, workspacesWithPausedTracking } from '../lib/tracking-billing.js';

export const QUEUES = { daily: 'daily', refresh: REFRESH_QUEUE, report: 'report', alerts: 'alerts', digest: 'digest', housekeeping: 'housekeeping' };

// Policies: 'stately' allows one queued and one active job per singleton key, so a collection slot
// (keyed by IST date and hour), a workspace's refresh or an alerts pass is never queued twice;
// 'exclusive' allows one job per report at all.
const QUEUE_OPTIONS = {
  daily: { policy: 'stately', retryLimit: 2, retryDelay: 300, retryBackoff: true, expireInSeconds: 4 * 3600 },
  refresh: REFRESH_QUEUE_OPTIONS,
  report: { policy: 'exclusive', retryLimit: 0, expireInSeconds: 2 * 3600 },
  alerts: { policy: 'stately', retryLimit: 1, retryDelay: 60, expireInSeconds: 900 },
  digest: { policy: 'stately', retryLimit: 1, retryDelay: 300, expireInSeconds: 1800 },
  housekeeping: { policy: 'stately', retryLimit: 0, expireInSeconds: 600 },
};

export const STUCK_REPORT_MINUTES = 2;

const stamp = () => new Date().toISOString().slice(11, 19);
export const makeLog = (prefix) => (...args) => console.log(`${stamp()} [${prefix}]`, ...args);

// Imports a module another part of the system provides, or returns null when it isn't there yet.
async function optional(specifier, log) {
  try {
    return await import(specifier);
  } catch (err) {
    const missing = String(err.message).replaceAll('\\', '/').includes(specifier.replace(/^\.\.\//, ''));
    if (err.code === 'ERR_MODULE_NOT_FOUND' && missing) {
      log?.(`${specifier} is not available yet`);
      return null;
    }
    throw err;
  }
}

export async function startBoss({ log = makeLog('boss'), lightweight = false } = {}) {
  const boss = new PgBoss({
    connectionString: requireEnv('DATABASE_URL'),
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    schema: 'pgboss',
    max: lightweight ? 2 : 5,
    // A short-lived boss (enqueue.js, enqueueReport) neither runs schedules nor supervises.
    schedule: !lightweight,
    supervise: !lightweight,
  });
  boss.on('error', (err) => log('error', err.message));
  await boss.start();
  for (const name of Object.values(QUEUES)) await boss.createQueue(name, QUEUE_OPTIONS[name]);
  return boss;
}

// Sends a job. The collection run is keyed by its IST date and hour ('2026-09-16T12'), so a slot is
// queued once however many times it's sent; a refresh by its workspace; a report by its id.
export async function enqueue(boss, queue, data = {}, options = {}) {
  if (!Object.values(QUEUES).includes(queue)) throw new Error(`Unknown queue "${queue}"`);
  const payload = { ...data };
  const sendOptions = { ...options };
  if (queue === QUEUES.daily) {
    payload.date ??= todayIST();
    payload.slot ??= `${payload.date}T${istSlot().slice(11, 13)}`;
    sendOptions.singletonKey ??= payload.slot;
  }
  if (queue === QUEUES.refresh && payload.workspaceId) sendOptions.singletonKey ??= String(payload.workspaceId);
  if (queue === QUEUES.report && payload.reportId) sendOptions.singletonKey ??= `report:${payload.reportId}`;
  return boss.send(queue, payload, sendOptions);
}

// Queues one report from the web app or the sweep. Opens its own boss when none is given.
export async function enqueueReport(reportId, boss = null) {
  const own = !boss;
  if (own) boss = await startBoss({ lightweight: true, log: makeLog('boss') });
  try {
    return await enqueue(boss, QUEUES.report, { reportId });
  } finally {
    if (own) await boss.stop({ graceful: false, close: true });
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function tellOps(note, log) {
  try {
    await notifyOps(note, { dedupe: false });
  } catch (err) {
    log(`could not write the ops notification: ${err.message}`);
  }
}

const markRequest = markRefreshRequest;
const isCapError = (err) => err?.name === 'SpendCapReached';

// The counts a refresh request keeps, from what runDaily or runRefresh returned.
function requestSummary(result) {
  const c = result?.collected ?? {};
  const stories = Array.isArray(result?.stories) ? result.stories.filter((b) => b?.storyId && !b.error).length : 0;
  return { posts: c.posts ?? 0, newPosts: c.newPosts ?? 0, comments: c.comments ?? 0, stories };
}

// Collects, then charges the day's tracking, only once collection has succeeded. Without the
// pipeline the run fails and nothing is charged. A retry is safe: charges are keyed per target and
// date, and the collector skips handles it already collected recently. The run can happen several
// times a day; each target is still charged once per IST day. With a requestId (an admin's "run
// collection now") the refresh request is marked running, then done or failed.
export async function runDailyJob({ date = todayIST(), requestId = null, log = makeLog('daily') } = {}) {
  const runId = await startRun('daily');
  log(`run ${runId} for ${date}${requestId ? ` (request ${requestId})` : ''}`);
  if (requestId) await markRequest(requestId, 'running', { runId });
  try {
    const pipeline = await optional('../pipeline/index.js', log);
    if (!pipeline?.runDaily) {
      throw new Error(`pipeline/index.js ${pipeline ? 'does not export runDaily' : 'could not be found'}; nothing was collected and no credits were charged`);
    }
    const collection = (await pipeline.runDaily({ runId, date, log })) ?? null;
    const billing = await chargeDailyTracking({ date, log });
    const run = await finishRun(runId, { summary: { date, collection, billing } });
    log(`done: ${billing.charged} charged, ${billing.paused} paused, $${Number(run?.usd ?? 0).toFixed(4)} spent`);
    if (requestId) await markRequest(requestId, 'done', { summary: { ...requestSummary(collection), usd: Number(run?.usd ?? 0) } });
    return { runId, date, billing, collection, usd: run?.usd ?? 0 };
  } catch (err) {
    log(`failed: ${err.message}`);
    await finishRun(runId, { status: 'failed', error: err, summary: { date } });
    if (requestId) await markRequest(requestId, 'failed', { error: isCapError(err) ? CAP_REACHED_ERROR : String(err.message).slice(0, 500) });
    await tellOps(`Daily run failed: ${date}\nRun ${runId}.\n${String(err.message).slice(0, 500)}`, log);
    throw err;
  }
}

// One workspace's on-demand refresh: collects what it tracks (the shared collection cache still
// applies), understands the new posts and attaches them to shared-feed stories. No credits are
// charged; the daily tracking price covers refreshes. `pipeline` and `feedId` are for tests.
export async function runRefreshJob({ requestId, workspaceId = null, log = makeLog('refresh'), pipeline = null, feedId = null } = {}) {
  if (!requestId) throw new Error('A refresh job needs a requestId');
  const { rows } = await pool.query('select id, workspace_id, status from refresh_requests where id = $1', [requestId]);
  const request = rows[0];
  if (!request) {
    log(`refresh request ${requestId} does not exist`);
    return { requestId, skipped: true };
  }
  // A request the sweep already failed (the worker was down) stays failed; the user was told.
  if (request.status !== 'queued') {
    log(`refresh request ${requestId} is ${request.status}; nothing to do`);
    return { requestId, skipped: true };
  }
  workspaceId = request.workspace_id ?? workspaceId;
  const runId = await startRun('refresh', { workspaceId });
  await markRequest(requestId, 'running', { runId });
  log(`run ${runId} for workspace ${workspaceId} (request ${requestId})`);
  try {
    pipeline ??= await optional('../pipeline/index.js', log);
    if (!pipeline?.runRefresh) throw new Error('pipeline/index.js does not export runRefresh');
    const result = (await pipeline.runRefresh({ runId, workspaceId, log, ...(feedId ? { feedId } : {}) })) ?? {};
    const counts = requestSummary(result);
    const run = await finishRun(runId, { summary: { requestId, workspaceId, ...counts } });
    const summary = { ...counts, usd: Number(run?.usd ?? 0) };
    await markRequest(requestId, 'done', { summary });
    log(`done: ${summary.posts} posts (${summary.newPosts} new), ${summary.comments} comments, ${summary.stories} stories, $${summary.usd.toFixed(4)} spent`);
    return { requestId, runId, ...summary };
  } catch (err) {
    log(`failed: ${err.message}`);
    await finishRun(runId, { status: 'failed', error: err, summary: { requestId, workspaceId } });
    await markRequest(requestId, 'failed', { error: isCapError(err) ? CAP_REACHED_ERROR : `The refresh failed: ${String(err.message).slice(0, 300)}` });
    // The spend cap has its own notice (lib/spend.js); other failures reach ops once a day.
    if (!isCapError(err)) {
      try {
        await notifyOps(`Refresh failed: ${todayIST()}\nRun ${runId}, workspace ${workspaceId}.\n${String(err.message).slice(0, 500)}`);
      } catch (opsErr) {
        log(`could not write the ops notification: ${opsErr.message}`);
      }
    }
    throw err;
  }
}

// Prepares one requested report: holds its status, runs the pipeline, settles the credit hold
// for at most the quote, or releases it and marks the report failed.
export async function runReportJob({ reportId, log = makeLog('report') } = {}) {
  if (!reportId) throw new Error('A report job needs a reportId');
  const pipeline = await optional('../pipeline/index.js', log);
  if (!pipeline?.runReport) {
    log(`no runReport in pipeline/index.js; report ${reportId} stays queued for the team`);
    return { reportId, skipped: true };
  }
  const { rows } = await pool.query(`select * from reports where id = $1`, [reportId]);
  const report = rows[0];
  if (!report) {
    log(`report ${reportId} does not exist`);
    return { reportId, skipped: true };
  }
  if (!['queued', 'in_progress'].includes(report.status)) {
    log(`report ${reportId} is ${report.status}; nothing to do`);
    return { reportId, skipped: true };
  }
  // updateReport (lib/reports.js) owns the status changes: 'ready' settles the hold for at most the
  // quote, 'failed' releases it.
  await updateReport(reportId, { status: 'in_progress' });
  const runId = await startRun('report', { workspaceId: report.workspace_id });
  log(`run ${runId} for report ${reportId} "${report.query}"`);
  let result;
  try {
    result = (await pipeline.runReport({ reportId, runId, report, log })) ?? {};
    if (!result.storyId) throw new Error('The pipeline produced no story for this report');
  } catch (err) {
    log(`failed: ${err.message}`);
    await finishRun(runId, { status: 'failed', error: err, summary: { reportId } });
    try {
      await updateReport(reportId, { status: 'failed', note: `Couldn’t be prepared: ${String(err.message).slice(0, 300)}. Your held credits were released.` });
    } catch (closeErr) {
      if (report.reservation_id) await release(report.reservation_id);
      log(`could not mark the report failed: ${closeErr.message}`);
    }
    await tellOps(`Report failed: ${reportId}\nRun ${runId}, workspace ${report.workspace_id}, "${report.query}".\n${String(err.message).slice(0, 500)}`, log);
    throw err;
  }
  // Charged at the quote for now (never more); the run summary keeps the real USD for margin.
  const quoted = Number(report.quoted_credits);
  const used = Math.min(quoted, Number.isFinite(Number(result.credits)) ? Number(result.credits) : quoted);
  await updateReport(reportId, { status: 'ready', storyId: result.storyId, usedCredits: used, note: result.note });
  const run = await finishRun(runId, { summary: { reportId, storyId: result.storyId, quoted, charged: used } });
  log(`ready: story ${result.storyId}, charged ${used} of ${quoted} credits, $${Number(run?.usd ?? 0).toFixed(4)} spent`);
  return { reportId, runId, storyId: result.storyId, charged: used, usd: run?.usd ?? 0 };
}

export async function runAlertsJob({ log = makeLog('alerts') } = {}) {
  const alerts = await optional('../lib/alerts.js', log);
  if (!alerts?.sendDueAlerts) return { skipped: true };
  return alerts.sendDueAlerts({ log });
}

export async function runDigestJob({ log = makeLog('digest') } = {}) {
  const digests = await optional('../lib/digests.js', log);
  if (!digests?.sendDueDigests) return { skipped: true };
  return digests.sendDueDigests({ log });
}

// Reports still 'queued' after a while: either the request never reached the queue or the job
// was lost. Queue them again; the report queue accepts one job per report.
export async function requeueStuckReports(boss, { log = makeLog('housekeeping') } = {}) {
  // Until the pipeline can make reports, the team prepares them by hand; don't queue them every 5 minutes.
  const pipeline = await optional('../pipeline/index.js');
  if (!pipeline?.runReport) return { skipped: true };
  const { rows } = await pool.query(`select id from reports where status = 'queued' and updated_at < now() - make_interval(mins => $1)`, [STUCK_REPORT_MINUTES]);
  let sent = 0;
  for (const { id } of rows) if (await enqueueReport(id, boss)) sent += 1;
  if (rows.length) log(`${rows.length} queued report(s) older than ${STUCK_REPORT_MINUTES} minutes; ${sent} job(s) sent`);
  return { stuck: rows.length, sent };
}

// Refresh requests nobody picked up in 30 minutes, or still running after 2 hours, become failed.
export async function sweepRefreshRequests({ log = makeLog('housekeeping') } = {}) {
  const swept = await sweepStaleRefreshRequests();
  if (swept.queued || swept.running) log(`failed ${swept.queued} stale queued and ${swept.running} stuck running refresh request(s)`);
  return swept;
}

export async function runHousekeepingJob({ boss = null, task = null, log = makeLog('housekeeping') } = {}) {
  if (task === 'stuck_reports') {
    // The 5-minute pass: stale refresh requests, then stuck reports.
    const refreshes = await sweepRefreshRequests({ log });
    const reports = boss ? await requeueStuckReports(boss, { log }) : { skipped: true };
    return { ...reports, refreshes };
  }
  const released = await releaseExpired();
  let resumed = 0;
  for (const workspaceId of await workspacesWithPausedTracking()) resumed += await resumePausedTracking(workspaceId);
  const notify = await optional('../lib/notify.js', log);
  const flushed = notify?.flushNotifications ? await notify.flushNotifications({ log }) : null;
  log(`released ${released} expired hold(s), resumed ${resumed} paused target(s)${flushed ? `, notifications: ${JSON.stringify(flushed)}` : ''}`);
  return { released, resumed, flushed };
}

// ─── Workers ────────────────────────────────────────────────────────────────

export async function registerWorkers(boss, { log = makeLog('worker') } = {}) {
  const one = async (queue, run) => {
    await boss.work(queue, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
      log(`${queue} job ${job.id} started`);
      try {
        const result = await run(job.data ?? {}, makeLog(`${queue} ${job.id.slice(0, 8)}`));
        log(`${queue} job ${job.id} done`);
        return result;
      } catch (err) {
        log(`${queue} job ${job.id} failed: ${err.message}`);
        throw err;
      }
    });
  };
  await one(QUEUES.daily, (data, jobLog) => runDailyJob({ date: data.date, requestId: data.requestId, log: jobLog }));
  await one(QUEUES.refresh, (data, jobLog) => runRefreshJob({ requestId: data.requestId, workspaceId: data.workspaceId, log: jobLog }));
  await one(QUEUES.report, (data, jobLog) => runReportJob({ reportId: data.reportId, log: jobLog }));
  await one(QUEUES.alerts, (_data, jobLog) => runAlertsJob({ log: jobLog }));
  await one(QUEUES.digest, (_data, jobLog) => runDigestJob({ log: jobLog }));
  await one(QUEUES.housekeeping, (data, jobLog) => runHousekeepingJob({ boss, task: data.task, log: jobLog }));
  return Object.values(QUEUES);
}

// The worker's timetable, all in IST. The collection run and the digest follow app_settings; alerts
// and housekeeping are fixed. Render cron jobs can send the same jobs through enqueue.js.
export function schedulesFor(settings = DEFAULTS) {
  const hours = refreshHours(settings);
  const digest = settings.digest_hour_ist;
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  const collectWhen = hours.length === 1 ? `${hh(hours[0])} every day` : `every ${settings.refresh_every_hours}h: ${hours.map(hh).join(', ')}`;
  return [
    { queue: QUEUES.daily, cron: refreshCron(settings), key: 'daily', data: {}, when: collectWhen },
    { queue: QUEUES.alerts, cron: '*/30 * * * *', key: 'alerts', data: {}, when: 'every 30 minutes' },
    { queue: QUEUES.digest, cron: `0 ${digest} * * *`, key: 'digest', data: {}, when: `${hh(digest)} every day` },
    { queue: QUEUES.housekeeping, cron: '0 * * * *', key: 'hourly', data: {}, when: 'every hour' },
    { queue: QUEUES.housekeeping, cron: '*/5 * * * *', key: 'stuck-reports', data: { task: 'stuck_reports' }, when: 'every 5 minutes (stale refreshes, stuck reports)' },
  ];
}

// The timetable with default settings, for anything that lists it without the database.
export const SCHEDULES = schedulesFor(DEFAULTS);

// The schedules in `next` whose cron line differs from `previous` (matched by queue and key), each
// with `from`, the line it replaces. Pure, so the watcher's decision can be tested.
export function changedSchedules(previous, next) {
  const before = new Map((previous ?? []).map((s) => [`${s.queue}/${s.key}`, s.cron]));
  return next.filter((s) => before.get(`${s.queue}/${s.key}`) !== s.cron).map((s) => ({ ...s, from: before.get(`${s.queue}/${s.key}`) ?? null }));
}

// Writes schedules to pg-boss; the same queue and key replaces the old cron line.
export async function applySchedules(boss, schedules, { log = makeLog('worker') } = {}) {
  for (const s of schedules) {
    await boss.schedule(s.queue, s.cron, s.data, { tz: 'Asia/Kolkata', key: s.key });
    log(`schedule ${s.queue}/${s.key}: ${s.from ? `${s.from} -> ` : ''}${s.cron} IST (${s.when})`);
  }
  return schedules;
}

export async function registerSchedules(boss, { log = makeLog('worker'), settings = null } = {}) {
  return applySchedules(boss, schedulesFor(settings ?? (await getSettings())), { log });
}

// Re-reads the settings every minute and re-applies only the schedules whose cron line changed.
// `current` is the timetable already applied. Returns { stop, tick }; tick runs one check now.
export function watchSchedules(boss, { current, log = makeLog('worker'), intervalMs = 60_000 } = {}) {
  let applied = current;
  let busy = false;
  const tick = async () => {
    if (busy) return [];
    busy = true;
    try {
      const next = schedulesFor(await getSettings());
      const changed = changedSchedules(applied, next);
      if (changed.length) {
        log(`schedule settings changed: ${changed.map((s) => `${s.queue}/${s.key}`).join(', ')}`);
        await applySchedules(boss, changed, { log });
      }
      applied = next;
      return changed;
    } catch (err) {
      log(`could not re-apply the schedule from settings: ${err.message}`);
      return [];
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
