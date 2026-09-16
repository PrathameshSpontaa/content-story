// On-demand refreshes and the collection timetable, for the web app: asks for a refresh, reports its
// state, starts a full run for an admin, and summarises the schedule. Safe for Next.js server code.
import { PgBoss } from 'pg-boss';
import { pool } from './db.js';
import { getSettings, refreshCron, refreshHours } from './settings.js';

export const REFRESH_QUEUE = 'refresh';
const DAILY_QUEUE = 'daily';
// One refresh at a time per workspace (the job's singleton key is the workspace id).
export const REFRESH_QUEUE_OPTIONS = { policy: 'stately', retryLimit: 0, expireInSeconds: 2 * 3600 };

export const STALE_QUEUED_MINUTES = 30;
export const STALE_RUNNING_HOURS = 2;
export const WORKER_DOWN_ERROR = "The background worker isn't running.";
export const CAP_REACHED_ERROR = "Today's collection budget is used up. Try again tomorrow.";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const IST_OFFSET = 5.5 * HOUR;

export class RefreshError extends Error {}

// ─── Time in IST ────────────────────────────────────────────────────────────

export const todayIST = (at = Date.now()) => new Date(at + IST_OFFSET).toISOString().slice(0, 10);
export const istSlot = (at = Date.now()) => new Date(at + IST_OFFSET).toISOString().slice(0, 13); // '2026-09-16T12'
const clockIST = (at) => new Date(ms(at) + IST_OFFSET).toISOString().slice(11, 16);
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
const iso = (v) => (v == null ? null : new Date(ms(v)).toISOString());

// Midnight IST at the start of the IST day holding `at`, as epoch ms.
export function startOfDayIST(at = Date.now()) {
  const d = new Date(at + IST_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET;
}

// The next time one of the IST hours comes round after `now`, as epoch ms.
export function nextRunAt(hours, now = Date.now()) {
  const day = startOfDayIST(now);
  for (const offset of [0, 1]) {
    for (const h of [...hours].sort((a, b) => a - b)) {
      const at = day + offset * 24 * HOUR + h * HOUR;
      if (at > now) return at;
    }
  }
  return null;
}

function minutesAgo(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms(at)) / MINUTE));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

// ─── Sending jobs ───────────────────────────────────────────────────────────

// One small pg-boss instance per process, started on first use and reused; it neither runs
// schedules nor supervises, it only sends. Kept on globalThis so Next.js hot reloads reuse it.
function sender() {
  globalThis.__contentStoryRefreshSender ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      schema: 'pgboss',
      max: 2,
      schedule: false,
      supervise: false,
    });
    boss.on('error', (err) => console.error('[refresh sender]', err.message));
    await boss.start();
    await boss.createQueue(REFRESH_QUEUE, REFRESH_QUEUE_OPTIONS);
    return boss;
  })().catch((err) => {
    globalThis.__contentStoryRefreshSender = null;
    throw err;
  });
  return globalThis.__contentStoryRefreshSender;
}

// Stops the shared sender, for scripts and tests that need the process to exit.
export async function closeRefreshSender() {
  const pending = globalThis.__contentStoryRefreshSender;
  globalThis.__contentStoryRefreshSender = null;
  if (!pending) return;
  try {
    await (await pending).stop({ graceful: false, close: true });
  } catch {
    // It never started; nothing to stop.
  }
}

async function send(queue, data, options) {
  const boss = await sender();
  return boss.send(queue, data, options);
}

// Moves a request along: 'running' stamps started_at, a final status stamps finished_at.
export async function markRefreshRequest(id, status, { error = null, summary = null, runId = null } = {}) {
  await pool.query(
    `update refresh_requests
        set status = $2, error = $3, summary = coalesce($4::jsonb, summary), run_id = coalesce($5::uuid, run_id),
            started_at = case when $2 = 'running' then now() else started_at end,
            finished_at = case when $2 in ('done', 'failed', 'skipped') then now() else null end
      where id = $1`,
    [id, status, error, summary == null ? null : JSON.stringify(summary), runId],
  );
}
const markRequest = markRefreshRequest;

// ─── Housekeeping ───────────────────────────────────────────────────────────

// Requests nobody picked up (no worker) or that never finished are failed, so the app stops
// showing them as in progress. Runs from housekeeping and whenever the app reads a workspace's state.
export async function sweepStaleRefreshRequests({ workspaceId } = {}) {
  // Without a workspaceId every request is swept; workspaceId null means the admin's full runs.
  const all = workspaceId === undefined;
  const { rowCount: queued } = await pool.query(
    `update refresh_requests set status = 'failed', error = $1, finished_at = now()
      where status = 'queued' and created_at < now() - make_interval(mins => $2)
        and ($3 or workspace_id is not distinct from $4::uuid)`,
    [WORKER_DOWN_ERROR, STALE_QUEUED_MINUTES, all, all ? null : workspaceId],
  );
  const { rowCount: running } = await pool.query(
    `update refresh_requests set status = 'failed', error = 'The refresh took too long and was stopped.', finished_at = now()
      where status = 'running' and coalesce(started_at, created_at) < now() - make_interval(hours => $1)
        and ($2 or workspace_id is not distinct from $3::uuid)`,
    [STALE_RUNNING_HOURS, all, all ? null : workspaceId],
  );
  return { queued, running };
}

// ─── Workspace refresh ──────────────────────────────────────────────────────

async function workspaceState(workspaceId, settings, now = Date.now()) {
  await sweepStaleRefreshRequests({ workspaceId });
  const { rows } = await pool.query(
    `select
       (select count(*)::int from tracking_targets where workspace_id = $1 and active) as targets,
       (select row_to_json(r) from (select id, status, created_at, started_at from refresh_requests
          where workspace_id = $1 and status in ('queued', 'running') order by created_at limit 1) r) as open,
       (select count(*)::int from refresh_requests where workspace_id = $1 and status = 'queued') as queued,
       (select max(created_at) from refresh_requests where workspace_id = $1 and status in ('queued', 'running', 'done')) as last_requested_at,
       (select count(*)::int from refresh_requests where workspace_id = $1 and status in ('queued', 'running', 'done') and created_at >= $2) as today,
       (select row_to_json(r) from (select status, error, finished_at from refresh_requests
          where workspace_id = $1 and status in ('done', 'failed') order by created_at desc limit 1) r) as last,
       (select max(finished_at) from refresh_requests where workspace_id = $1 and status = 'done') as last_done_at,
       (select max(finished_at) from runs where kind = 'daily' and status = 'done') as last_daily_at`,
    [workspaceId, new Date(startOfDayIST(now))],
  );
  const s = rows[0];
  const cooldownUntil = s.last_requested_at ? ms(s.last_requested_at) + settings.on_demand_cooldown_minutes * MINUTE : null;
  const dayFull = s.today >= settings.on_demand_max_per_day;
  const tomorrow = startOfDayIST(now) + 24 * HOUR;
  let nextAllowedAt = null;
  if (dayFull) nextAllowedAt = cooldownUntil && cooldownUntil > tomorrow ? cooldownUntil : tomorrow;
  else if (cooldownUntil && cooldownUntil > now) nextAllowedAt = cooldownUntil;
  const lastRefreshed = [s.last_done_at, s.last_daily_at].filter(Boolean).map(ms);
  return {
    targets: s.targets,
    open: s.open,
    queuedCount: s.queued,
    lastRequestedAt: s.last_requested_at,
    today: s.today,
    dayFull,
    cooldownUntil,
    nextAllowedAt,
    last: s.last,
    lastRefreshedAt: lastRefreshed.length ? Math.max(...lastRefreshed) : null,
  };
}

const busyMessage = (open) =>
  open.status === 'running' ? 'Already refreshing. New stories appear in a few minutes.' : 'A refresh is already on its way. New stories appear in a few minutes.';

// Asks for a refresh of one workspace's tracked sources. Refusals by rule come back as
// { ok: false, message, nextAllowedAt }; only a real failure (the database) throws.
// A 'follow' refresh (someone was just followed) skips the cooldown and the daily maximum (the
// collector still scrapes each source at most once per cooldown, so a run of follows costs one
// collection each), and is refused silently (message null, silent true) when it can't run.
export async function requestRefresh({ workspaceId, userId = null, reason = 'button' }) {
  if (!workspaceId) throw new RefreshError('requestRefresh needs a workspaceId');
  if (!['button', 'follow'].includes(reason)) throw new RefreshError(`Unknown refresh reason "${reason}"`);
  const follow = reason === 'follow';
  const settings = await getSettings();
  const now = Date.now();
  const refuse = (message, nextAllowedAt = null) =>
    follow ? { ok: false, silent: true, message: null, nextAllowedAt: iso(nextAllowedAt) } : { ok: false, message, nextAllowedAt: iso(nextAllowedAt) };

  if (!settings.on_demand_enabled) return refuse('Refreshing on demand is turned off right now.');
  const state = await workspaceState(workspaceId, settings, now);
  if (!state.targets) return refuse('Add someone to follow first.');
  if (state.open) {
    // A follow while a refresh is already running queues one more, so the new follow is collected;
    // one that is still waiting to start will pick the new follow up by itself.
    if (!(follow && state.open.status === 'running' && state.queuedCount === 0)) return refuse(busyMessage(state.open));
  }
  if (!follow && state.dayFull) {
    return refuse(`You've used all ${settings.on_demand_max_per_day} refreshes for today. You can refresh again tomorrow.`, state.nextAllowedAt);
  }
  if (!follow && state.cooldownUntil && state.cooldownUntil > now) {
    return refuse(`Refreshed ${minutesAgo(state.lastRequestedAt, now)}. You can refresh again at ${clockIST(state.cooldownUntil)}.`, state.cooldownUntil);
  }

  // The partial check above and this insert race only if two requests arrive together; the queue's
  // one-per-workspace policy then drops the second job and its request is marked skipped.
  const {
    rows: [request],
  } = await pool.query(`insert into refresh_requests (workspace_id, requested_by, reason) values ($1, $2, $3) returning id`, [workspaceId, userId, reason]);
  let jobId;
  try {
    jobId = await send(REFRESH_QUEUE, { requestId: request.id, workspaceId }, { singletonKey: String(workspaceId) });
  } catch (err) {
    console.error(`[refresh] could not queue request ${request.id}: ${err.message}`);
    await markRequest(request.id, 'failed', { error: `Could not queue the refresh: ${String(err.message).slice(0, 300)}` });
    return refuse("Couldn't start a refresh just now. Try again in a minute.");
  }
  if (!jobId) {
    await markRequest(request.id, 'skipped', { error: 'A refresh for this workspace was already queued.' });
    return refuse('A refresh is already on its way. New stories appear in a few minutes.');
  }
  return { ok: true, requestId: request.id, message: 'Refreshing now. New stories appear in a few minutes.' };
}

// Starts collecting right after a follow. Every follow action calls this; a refusal or a failure
// never fails the follow. Returns true when a collection is now queued or already under way.
export async function collectAfterFollow({ workspaceId, userId = null }) {
  try {
    const res = await requestRefresh({ workspaceId, userId, reason: 'follow' });
    if (res.ok) return true;
    // Refused because one is already queued or running: that run picks the new follow up.
    const state = await workspaceState(workspaceId, await getSettings());
    return Boolean(state.open);
  } catch (err) {
    console.error('[follow] could not start collecting:', err.message);
    return false;
  }
}

// What the app shows next to the refresh button.
export async function getRefreshStatus(workspaceId) {
  const settings = await getSettings();
  const now = Date.now();
  const state = await workspaceState(workspaceId, settings, now);
  const next = nextRunAt(refreshHours(settings), now);
  const lastFailed = state.last?.status === 'failed';
  return {
    enabled: Boolean(settings.on_demand_enabled),
    state: state.open ? state.open.status : 'idle',
    lastRefreshedAt: iso(state.lastRefreshedAt),
    lastError: lastFailed ? state.last.error : null,
    nextAllowedAt: iso(state.nextAllowedAt),
    remainingToday: Math.max(0, settings.on_demand_max_per_day - state.today),
    nextScheduledAt: iso(next),
    everyHours: settings.refresh_every_hours,
  };
}

// ─── Full run and the timetable ─────────────────────────────────────────────

// An admin's "run collection now": sends the scheduled run straight away, keyed by the request so
// it isn't dropped as a copy of this hour's scheduled run. The daily handler closes the request.
export async function requestFullRefresh({ userId = null } = {}) {
  await sweepStaleRefreshRequests({ workspaceId: null });
  const { rows: open } = await pool.query(`select status from refresh_requests where workspace_id is null and status in ('queued', 'running') limit 1`);
  if (open[0]) return { ok: false, message: open[0].status === 'running' ? 'A full collection run is already running.' : 'A full collection run is already queued.' };
  const {
    rows: [request],
  } = await pool.query(`insert into refresh_requests (workspace_id, requested_by, reason) values (null, $1, 'admin') returning id`, [userId]);
  try {
    const jobId = await send(DAILY_QUEUE, { requestId: request.id, date: todayIST(), slot: istSlot() }, { singletonKey: `manual-${request.id}` });
    if (!jobId) throw new Error('the queue did not accept the job');
    return { ok: true, requestId: request.id, jobId, message: 'Collection run queued. It starts within a minute if the worker is running.' };
  } catch (err) {
    const message = /does not exist/.test(err.message) ? "The worker hasn't set up its queues yet. Start the worker first." : `Couldn't queue the run: ${String(err.message).slice(0, 200)}`;
    await markRequest(request.id, 'failed', { error: message });
    return { ok: false, message };
  }
}

const round = (n, places = 6) => (n == null ? null : Math.round(Number(n) * 10 ** places) / 10 ** places);

// The collection timetable and what it costs, for the admin panel.
export async function scheduleSummary() {
  const settings = await getSettings();
  const hoursIst = refreshHours(settings);
  const {
    rows: [last],
  } = await pool.query(`select started_at, finished_at, status, usd::float as usd from runs where kind = 'daily' order by started_at desc limit 1`);
  const {
    rows: [avg],
  } = await pool.query(
    `select count(*)::int as runs,
            avg(coalesce(r.usd, (select sum(c.usd) from cost_events c where c.run_id = r.id), 0))::float as usd
       from runs r
      where r.kind in ('daily', 'refresh') and r.finished_at is not null and r.status = 'done'
        and r.started_at >= now() - interval '7 days'`,
  );
  const runsPerDay = 24 / settings.refresh_every_hours;
  const avgUsdPerRun7d = avg.runs ? round(avg.usd) : null;
  return {
    everyHours: settings.refresh_every_hours,
    hoursIst,
    cron: refreshCron(settings),
    nextRunAt: iso(nextRunAt(hoursIst)),
    digestHourIst: settings.digest_hour_ist,
    lastRun: last ? { startedAt: iso(last.started_at), finishedAt: iso(last.finished_at), status: last.status, usd: last.usd } : null,
    avgUsdPerRun7d,
    runsPerDay,
    estUsdPerDay: avgUsdPerRun7d == null ? null : round(avgUsdPerRun7d * runsPerDay),
  };
}
