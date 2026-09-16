// End-to-end check of on-demand refreshes and the settings-driven timetable against the real
// database in fake mode: request rules and messages, status, the refresh handler run inline, the
// schedule watcher, the schedule summary and the stale-request sweep. Cleans up everything it made.
// Usage: node scripts/test-refresh.js
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake provider and a fixture overlay, set before the pipeline modules load.
const overlay = join(tmpdir(), `content-story-refresh-test-${Date.now()}`);
process.env.PIPELINE_PROVIDER = 'fake';
process.env.PIPELINE_FIXTURE_OVERLAY = overlay;

const { pool } = await import('../lib/db.js');
const { SpendCapReached } = await import('../lib/spend.js');
const { DEFAULTS, getSettings, refreshCron, saveSettings } = await import('../lib/settings.js');
const refresh = await import('../lib/refresh.js');
const { CAP_REACHED_ERROR, WORKER_DOWN_ERROR, closeRefreshSender, getRefreshStatus, nextRunAt, requestRefresh, scheduleSummary, startOfDayIST } = refresh;
const jobs = await import('../pipeline/jobs.js');
const { QUEUES, changedSchedules, enqueue, runHousekeepingJob, runRefreshJob, schedulesFor, startBoss, watchSchedules } = jobs;
const pipeline = await import('../pipeline/index.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name}: ${err.message}`]);
  }
}
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const quiet = () => {};
const MIN = 60_000;

const marker = `billing test refresh ${randomBytes(4).toString('hex')}`;
const startedAt = new Date().toISOString();
const settingKeys = ['refresh_every_hours', 'refresh_start_hour_ist', 'on_demand_enabled'];
const savedSettings = await q('select key, value, updated_by from app_settings where key = any($1::text[])', [settingKeys]);
let settings = await getSettings();

const [user] = await q(`insert into users (email, name) values ($1, 'Refresh Test') returning id`, [`${marker.replaceAll(' ', '-')}@content-story.dev`]);
const [workspace] = await q(`insert into workspaces (name) values ($1) returning id`, [marker]);
await pool.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [workspace.id, user.id]);
const [feed] = await q(`insert into feeds (workspace_id, name) values ($1, $2) returning id`, [workspace.id, marker]);
// The grouping step answers "no stories" for the test feed, so nothing is written to a real feed.
mkdirSync(join(overlay, 'grouping'), { recursive: true });
writeFileSync(join(overlay, 'grouping', `feed-${feed.id}.json`), JSON.stringify({ stories: [] }));

// One dry-run creator on X, made due for collection; its handles are put back afterwards.
const [creator] = await q(
  `select c.id, c.name from creators c join creator_handles h on h.creator_id = c.id and h.platform = 'x' and h.verified
    order by c.name limit 1`,
);
assert.ok(creator, 'no dry-run creator with a verified X handle; run npm run import:dryrun first');
const savedHandles = await q('select id, last_collected_at from creator_handles where creator_id = $1', [creator.id]);

let boss = null;
let collected = null;
const snapshots = [];
const requestIds = new Set();
const trackRequest = (r) => r?.requestId && requestIds.add(r.requestId);
const jobsFor = async (requestId) => q(`select id, name, state, singleton_key, data from pgboss.job where name = 'refresh' and data ->> 'requestId' = $1`, [requestId]);
const dropJobs = async () => {
  if (requestIds.size) await pool.query(`delete from pgboss.job where name in ('refresh', 'daily') and data ->> 'requestId' = any($1::text[])`, [[...requestIds]]);
};
const backdate = (minutes) => pool.query(`update refresh_requests set created_at = greatest(now() - make_interval(mins => $2), $3) where workspace_id = $1`, [workspace.id, minutes, new Date(startOfDayIST() + 1000)]);

try {
  if (!settings.on_demand_enabled) {
    await saveSettings({ on_demand_enabled: true });
    settings = await getSettings();
  }
  const { on_demand_cooldown_minutes: cooldown, on_demand_max_per_day: maxPerDay } = settings;

  await check('with nothing followed, a refresh is refused with a plain message', async () => {
    const r = await requestRefresh({ workspaceId: workspace.id, userId: user.id });
    assert.deepEqual(r, { ok: false, message: 'Add someone to follow first.', nextAllowedAt: null });
    const s = await getRefreshStatus(workspace.id);
    assert.equal(s.state, 'idle');
    assert.equal(s.enabled, true);
    assert.equal(s.remainingToday, maxPerDay);
    assert.equal(s.everyHours, settings.refresh_every_hours);
    assert.ok(Date.parse(s.nextScheduledAt) > Date.now());
  });

  await pool.query(`insert into tracking_targets (workspace_id, kind, creator_id, platforms) values ($1, 'creator', $2, '{x}')`, [workspace.id, creator.id]);
  await pool.query(`update creator_handles set last_collected_at = now() - interval '2 days' where creator_id = $1`, [creator.id]);

  let first;
  await check('a refresh is queued: one request row and one pg-boss job keyed by the workspace', async () => {
    first = await requestRefresh({ workspaceId: workspace.id, userId: user.id });
    trackRequest(first);
    assert.equal(first.ok, true, first.message);
    assert.equal(first.message, 'Refreshing now. New stories appear in a few minutes.');
    const [row] = await q('select status, reason, requested_by from refresh_requests where id = $1', [first.requestId]);
    assert.deepEqual(row, { status: 'queued', reason: 'button', requested_by: user.id });
    const sent = await jobsFor(first.requestId);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].singleton_key, workspace.id);
    assert.equal(sent[0].data.workspaceId, workspace.id);
  });

  await check('status shows it queued, one fewer left today, and the cooldown', async () => {
    const s = await getRefreshStatus(workspace.id);
    assert.equal(s.state, 'queued');
    assert.equal(s.remainingToday, maxPerDay - 1);
    assert.ok(Math.abs(Date.parse(s.nextAllowedAt) - (Date.now() + cooldown * MIN)) < 2 * MIN, `nextAllowedAt ${s.nextAllowedAt}`);
  });

  await check('while one is queued, the button is refused and a follow is refused silently', async () => {
    const r = await requestRefresh({ workspaceId: workspace.id, reason: 'button' });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'A refresh is already on its way. New stories appear in a few minutes.');
    const f = await requestRefresh({ workspaceId: workspace.id, reason: 'follow' });
    assert.deepEqual([f.ok, f.message, f.silent], [false, null, true]);
    assert.equal((await q('select count(*)::int as n from refresh_requests where workspace_id = $1', [workspace.id]))[0].n, 1);
  });

  await check('the refresh handler, run inline, collects, marks the request done and records a refresh run', async () => {
    await dropJobs(); // run here instead of by a worker
    let during;
    const stub = {
      runRefresh: async (args) => {
        during = await getRefreshStatus(workspace.id);
        collected = await pipeline.runRefresh(args);
        snapshots.push(...collected.collected.capturedAt);
        return collected;
      },
    };
    const out = await runRefreshJob({ requestId: first.requestId, log: quiet, pipeline: stub, feedId: feed.id });
    assert.equal(during.state, 'running');
    const c = collected.collected;
    assert.ok(c.handles >= 1, `handles collected: ${c.handles}`);
    assert.ok(c.posts > 0, `posts: ${c.posts}`);
    assert.equal(c.usd, 0);
    const [row] = await q('select status, error, summary, run_id, started_at, finished_at from refresh_requests where id = $1', [first.requestId]);
    assert.equal(row.status, 'done', row.error);
    assert.ok(row.started_at && row.finished_at);
    assert.deepEqual(Object.keys(row.summary).sort(), ['comments', 'newPosts', 'posts', 'stories', 'usd']);
    assert.equal(row.summary.posts, c.posts);
    assert.equal(row.run_id, out.runId);
    const [run] = await q('select kind, status, workspace_id, summary from runs where id = $1', [out.runId]);
    assert.deepEqual([run.kind, run.status, run.workspace_id], ['refresh', 'done', workspace.id]);
    const charged = await q(`select count(*)::int as n from credit_entries where workspace_id = $1 and kind = 'debit'`, [workspace.id]);
    assert.equal(charged[0].n, 0, 'a refresh charges no credits');
  });

  await check('after the run: idle, last refreshed now, no error', async () => {
    const s = await getRefreshStatus(workspace.id);
    assert.equal(s.state, 'idle');
    assert.ok(Date.now() - Date.parse(s.lastRefreshedAt) < 5 * MIN);
    assert.equal(s.lastError, null);
  });

  await check('within the cooldown the button says when it can refresh again', async () => {
    await backdate(12);
    const r = await requestRefresh({ workspaceId: workspace.id });
    assert.equal(r.ok, false);
    assert.match(r.message, /^Refreshed \d+ minutes? ago\. You can refresh again at \d\d:\d\d\.$/);
    const [{ created_at }] = await q('select created_at from refresh_requests where id = $1', [first.requestId]);
    assert.equal(Date.parse(r.nextAllowedAt), created_at.getTime() + cooldown * MIN);
  });

  await check('a follow ignores the cooldown and queues a refresh', async () => {
    const f = await requestRefresh({ workspaceId: workspace.id, reason: 'follow' });
    trackRequest(f);
    assert.equal(f.ok, true, f.message);
    assert.equal((await jobsFor(f.requestId)).length, 1);
    await dropJobs();
    await pool.query(`update refresh_requests set status = 'done', finished_at = now() where id = $1`, [f.requestId]);
  });

  await check('once the cooldown has passed the button queues again', async () => {
    await backdate(cooldown + 2);
    const r = await requestRefresh({ workspaceId: workspace.id });
    trackRequest(r);
    assert.equal(r.ok, true, r.message);
    await dropJobs();
    await pool.query(`update refresh_requests set status = 'done', finished_at = now() where id = $1`, [r.requestId]);
    await backdate(cooldown + 2);
  });

  await check('at the daily maximum both the button and a follow are refused until tomorrow', async () => {
    const [{ n }] = await q(`select count(*)::int as n from refresh_requests where workspace_id = $1 and status in ('queued', 'running', 'done') and created_at >= $2`, [workspace.id, new Date(startOfDayIST())]);
    for (let i = n; i < maxPerDay; i += 1) {
      await pool.query(`insert into refresh_requests (workspace_id, reason, status, created_at, finished_at) values ($1, 'button', 'done', greatest(now() - make_interval(mins => $2), $3), now())`, [workspace.id, cooldown + 3, new Date(startOfDayIST() + 1000)]);
    }
    const r = await requestRefresh({ workspaceId: workspace.id });
    assert.equal(r.ok, false);
    assert.equal(r.message, `You've used all ${maxPerDay} refreshes for today. You can refresh again tomorrow.`);
    assert.ok(Date.parse(r.nextAllowedAt) >= startOfDayIST() + 24 * 3_600_000);
    const f = await requestRefresh({ workspaceId: workspace.id, reason: 'follow' });
    assert.deepEqual([f.ok, f.message, f.silent], [false, null, true]);
    const s = await getRefreshStatus(workspace.id);
    assert.equal(s.remainingToday, 0);
    assert.equal(s.nextAllowedAt, r.nextAllowedAt);
  });

  await check('housekeeping fails a request queued 30+ minutes ago and one running 2+ hours', async () => {
    const [stale] = await q(`insert into refresh_requests (workspace_id, reason, created_at) values ($1, 'button', now() - interval '31 minutes') returning id`, [workspace.id]);
    const [stuck] = await q(`insert into refresh_requests (workspace_id, reason, status, created_at, started_at) values ($1, 'button', 'running', now() - interval '3 hours', now() - interval '3 hours') returning id`, [workspace.id]);
    const out = await runHousekeepingJob({ task: 'stuck_reports', log: quiet });
    assert.ok(out.refreshes.queued >= 1 && out.refreshes.running >= 1, JSON.stringify(out.refreshes));
    const rows = await q('select id, status, error, finished_at from refresh_requests where id = any($1::uuid[])', [[stale.id, stuck.id]]);
    assert.ok(rows.every((r) => r.status === 'failed' && r.finished_at));
    assert.equal(rows.find((r) => r.id === stale.id).error, WORKER_DOWN_ERROR);
    const s = await getRefreshStatus(workspace.id);
    assert.equal(s.state, 'idle');
    assert.equal(s.lastError, WORKER_DOWN_ERROR);
  });

  await check('a spend cap during a refresh fails the request with the budget message; a closed request is skipped', async () => {
    const [req] = await q(`insert into refresh_requests (workspace_id, reason) values ($1, 'button') returning id`, [workspace.id]);
    const capped = { runRefresh: async () => { throw new SpendCapReached('apify', 10, 10); } };
    await assert.rejects(() => runRefreshJob({ requestId: req.id, log: quiet, pipeline: capped }), SpendCapReached);
    const [row] = await q('select status, error, run_id from refresh_requests where id = $1', [req.id]);
    assert.deepEqual([row.status, row.error], ['failed', CAP_REACHED_ERROR]);
    assert.equal((await q('select status from runs where id = $1', [row.run_id]))[0].status, 'failed');
    const again = await runRefreshJob({ requestId: req.id, log: quiet, pipeline: capped });
    assert.equal(again.skipped, true);
  });

  await check('the collection run is keyed by IST date and hour; a refresh by its workspace', async () => {
    const sent = [];
    const fakeBoss = { send: async (queue, data, options) => sent.push({ queue, data, options }) };
    await enqueue(fakeBoss, QUEUES.daily, {});
    await enqueue(fakeBoss, QUEUES.daily, { date: '2026-01-02' });
    await enqueue(fakeBoss, QUEUES.refresh, { requestId: 'x', workspaceId: workspace.id });
    assert.match(sent[0].options.singletonKey, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
    assert.equal(sent[0].options.singletonKey, sent[0].data.slot);
    assert.match(sent[1].options.singletonKey, /^2026-01-02T\d{2}$/);
    assert.equal(sent[2].options.singletonKey, workspace.id);
  });

  await check('the watcher finds only the collection line changed when the interval changes', async () => {
    const base = { ...DEFAULTS, refresh_every_hours: 24, refresh_start_hour_ist: 6 };
    const six = { ...base, refresh_every_hours: 6 };
    assert.deepEqual(changedSchedules(schedulesFor(base), schedulesFor(base)), []);
    const changed = changedSchedules(schedulesFor(base), schedulesFor(six));
    assert.deepEqual(changed.map((s) => [s.queue, s.key, s.from, s.cron]), [['daily', 'daily', '0 6 * * *', '0 0,6,12,18 * * *']]);
    const digest = changedSchedules(schedulesFor(base), schedulesFor({ ...base, digest_hour_ist: 9 }));
    assert.deepEqual(digest.map((s) => [s.queue, s.cron]), [['digest', '0 9 * * *']]);
    assert.equal(nextRunAt([0, 6, 12, 18], Date.UTC(2026, 8, 16, 7, 0)), Date.UTC(2026, 8, 16, 12, 30)); // 12:30 IST -> 18:00 IST
    assert.equal(nextRunAt([6], Date.UTC(2026, 8, 16, 7, 0)), Date.UTC(2026, 8, 17, 0, 30)); // 12:30 IST -> 06:00 IST tomorrow
  });

  await check('a settings change is picked up by the watcher and rescheduled in pg-boss, then restored', async () => {
    boss = await startBoss({ lightweight: true, log: quiet });
    const original = await boss.getSchedules(QUEUES.daily, 'daily');
    const current = schedulesFor(await getSettings());
    const watcher = watchSchedules(boss, { current, log: quiet, intervalMs: 3_600_000 });
    try {
      // Hours well away from now, so the changed line cannot fire while the test runs.
      const istHour = new Date(Date.now() + 5.5 * 3_600_000).getUTCHours();
      const next = await saveSettings({ refresh_every_hours: 12, refresh_start_hour_ist: (istHour + 3) % 24 });
      const changed = await watcher.tick();
      assert.deepEqual(changed.map((s) => `${s.queue}/${s.key}`), ['daily/daily']);
      const [row] = await boss.getSchedules(QUEUES.daily, 'daily');
      assert.equal(row.cron, refreshCron(next));
      assert.equal(row.timezone, 'Asia/Kolkata');
      assert.deepEqual(await watcher.tick(), [], 'nothing re-applied when nothing changed');
    } finally {
      watcher.stop();
      await restoreSettings();
      if (original[0]) await boss.schedule(QUEUES.daily, original[0].cron, original[0].data ?? {}, { ...(original[0].options ?? {}), tz: original[0].timezone, key: 'daily' });
      else await boss.unschedule(QUEUES.daily, 'daily');
    }
    const [after] = await boss.getSchedules(QUEUES.daily, 'daily');
    assert.equal(after?.cron, original[0]?.cron);
  });

  await check('scheduleSummary returns the timetable and a cost estimate', async () => {
    const s = await scheduleSummary();
    const now = await getSettings();
    assert.equal(s.everyHours, now.refresh_every_hours);
    assert.equal(s.hoursIst.length, Math.ceil(24 / now.refresh_every_hours));
    assert.equal(s.cron, refreshCron(now));
    assert.ok(Date.parse(s.nextRunAt) > Date.now() && Date.parse(s.nextRunAt) <= Date.now() + 24 * 3_600_000);
    assert.equal(s.digestHourIst, now.digest_hour_ist);
    assert.equal(s.runsPerDay, 24 / now.refresh_every_hours);
    assert.equal(typeof s.avgUsdPerRun7d, 'number'); // this test's refresh run counts
    assert.ok(Math.abs(s.estUsdPerDay - s.avgUsdPerRun7d * s.runsPerDay) < 1e-5);
    assert.ok(s.lastRun === null || ['running', 'done', 'failed'].includes(s.lastRun.status));
  });

  await check('with on-demand refreshes turned off, the button says so', async () => {
    try {
      await saveSettings({ on_demand_enabled: false });
      const r = await requestRefresh({ workspaceId: workspace.id });
      assert.deepEqual([r.ok, r.message], [false, 'Refreshing on demand is turned off right now.']);
      assert.equal((await getRefreshStatus(workspace.id)).enabled, false);
    } finally {
      await restoreSettings();
    }
  });
} finally {
  const cleanup = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      results.push(['FAIL', `cleanup ${name}: ${err.message}`]);
    }
  };
  await cleanup('settings', restoreSettings);
  await cleanup('pg-boss jobs', dropJobs);
  if (boss) await cleanup('boss', () => boss.stop({ graceful: false, close: true }));
  await cleanup('sender', closeRefreshSender);
  const runIds = (await q(`select id from runs where workspace_id = $1`, [workspace.id])).map((r) => r.id);
  if (collected) {
    const c = collected.collected;
    await cleanup('new comments', () => pool.query('delete from comments where id = any($1::text[])', [c.newCommentIds]));
    await cleanup('new posts', () => pool.query('delete from posts where id = any($1::text[])', [c.newPostIds]));
    await cleanup('metrics snapshots', () => pool.query('delete from post_metrics where captured_at = any($1::timestamptz[])', [snapshots]));
    await cleanup('post_queries', () => pool.query('delete from post_queries where workspace_id is null and found_at >= $1', [startedAt]));
  }
  await cleanup('captures', async () => {
    await pool.query('update posts set raw_capture_id = null where raw_capture_id in (select id from raw_captures where run_id = any($1::uuid[]))', [runIds]);
    await pool.query('delete from raw_captures where run_id = any($1::uuid[])', [runIds]);
    await pool.query('delete from cost_events where run_id = any($1::uuid[])', [runIds]);
  });
  await cleanup('last_collected_at', () =>
    pool.query(`update creator_handles h set last_collected_at = s.at from jsonb_to_recordset($1::jsonb) as s(id uuid, at timestamptz) where h.id = s.id`, [
      JSON.stringify(savedHandles.map((h) => ({ id: h.id, at: h.last_collected_at }))),
    ]),
  );
  // Runs point at the workspace without a cascade, so they go first; requests only set run_id null.
  await cleanup('runs', () => pool.query('delete from runs where id = any($1::uuid[])', [runIds]));
  await cleanup('workspace', () => pool.query('delete from workspaces where id = $1', [workspace.id])); // requests, targets, feed go with it
  await cleanup('user', () => pool.query('delete from users where id = $1', [user.id]));
  rmSync(overlay, { recursive: true, force: true });
  await pool.end();
}

// Puts app_settings back: rows this test inserted are deleted, rows it changed get their old value.
async function restoreSettings() {
  const had = new Map(savedSettings.map((r) => [r.key, r]));
  for (const key of settingKeys) {
    if (had.has(key)) {
      const r = had.get(key);
      await pool.query(`update app_settings set value = $2::jsonb, updated_by = $3 where key = $1`, [key, JSON.stringify(r.value), r.updated_by]);
    } else {
      await pool.query('delete from app_settings where key = $1', [key]);
    }
  }
}

console.log('');
for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
if (collected) {
  const c = collected.collected;
  console.log(`\nrefresh collected: ${c.handles} handles, ${c.posts} posts (${c.newPosts} new), ${c.comments} comments (${c.newComments} new), $${c.usd}`);
}
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
