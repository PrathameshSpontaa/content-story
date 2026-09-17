// The production pipeline's entry points, called by the job layer (pipeline/jobs.js): the scheduled
// run, one workspace's on-demand refresh, and one report. Posts are collected and understood once for
// everyone; stories are private, built per workspace from only what it follows.
import { pool } from '../lib/db.js';
import { aiProvider } from '../lib/env.js';
import { collectMinHours, getSettings } from '../lib/settings.js';
import { isFake } from './fixtures.js';
import { buildStories } from './storybuild.js';

export const SHARED_FEED_NAME = 'AI & tech (shared)';

// Collection and understanding are separate modules; imported when used so this file loads without them.
const load = (name) => import(`./${name}.js`);

// PIPELINE_SKIP_COLLECT=1 (tests) skips collection and understanding and builds from what's saved.
const skipCollect = () => process.env.PIPELINE_SKIP_COLLECT === '1';

export async function sharedFeedId() {
  const { rows } = await pool.query('select id from feeds where workspace_id is null limit 1');
  if (rows[0]) return rows[0].id;
  // The unique index on shared feeds means a second insert racing this one does nothing.
  await pool.query(`insert into feeds (name) select $1 where not exists (select 1 from feeds where workspace_id is null)`, [SHARED_FEED_NAME]);
  return (await pool.query('select id from feeds where workspace_id is null limit 1')).rows[0].id;
}

// A workspace's feed of one kind: 'reports' (stories from reports it ordered) or 'following' (its
// stories from what it follows). Made on first use; the unique index makes a racing insert a no-op.
export async function workspaceFeedId(workspaceId, kind = 'reports') {
  const find = () => pool.query('select id from feeds where workspace_id = $1 and kind = $2', [workspaceId, kind]);
  const { rows } = await find();
  if (rows[0]) return rows[0].id;
  const { rows: ws } = await pool.query('select name from workspaces where id = $1', [workspaceId]);
  await pool.query(
    `insert into feeds (workspace_id, kind, name) values ($1, $2, $3) on conflict (workspace_id, kind) where workspace_id is not null do nothing`,
    [workspaceId, kind, `${ws[0]?.name ?? 'Workspace'} ${kind === 'following' ? 'stories' : 'reports'}`],
  );
  return (await find()).rows[0].id;
}

export const followingFeedId = (workspaceId) => workspaceFeedId(workspaceId, 'following');

// Builds one workspace's stories from the posts of what it follows. A workspace that follows nothing
// has no stories to build.
async function buildWorkspaceStories({ runId, workspaceId, feedId = null, log }) {
  return buildStories({ runId, feedId: feedId ?? (await followingFeedId(workspaceId)), log });
}

// How recently a source may have been collected and still be skipped by the scheduled run: most of
// the interval from the settings, unless COLLECT_MIN_HOURS is set (tests and manual runs).
export async function scheduledMinHours(settings = null) {
  const env = process.env.COLLECT_MIN_HOURS;
  if (env != null && env.trim() !== '' && Number.isFinite(Number(env))) return Number(env);
  return collectMinHours(settings ?? (await getSettings()));
}

// Collect everything tracked, understand the new posts, then build each following workspace's stories.
// One workspace failing doesn't stop the others; the run fails only when every one failed, or at once
// when a spend cap or used-up AI quota means the rest would fail too.
export async function runDaily({ runId, log = console.log }) {
  let collected = { skipped: true };
  let understood = { skipped: true };
  if (!skipCollect()) {
    const { collectDaily } = await load('collect');
    collected = await collectDaily({ runId, log, minHours: await scheduledMinHours() });
    const { understandNewPosts } = await load('understand');
    understood = await understandNewPosts({ runId, log });
  } else log('[daily] PIPELINE_SKIP_COLLECT=1: collection and understanding skipped');
  const { rows: workspaces } = await pool.query(
    `select w.id, w.name from workspaces w where exists (select 1 from tracking_targets t where t.workspace_id = w.id and t.active) order by w.created_at`,
  );
  const stories = [];
  const failed = [];
  for (const w of workspaces) {
    try {
      stories.push(...(await buildWorkspaceStories({ runId, workspaceId: w.id, log })));
    } catch (err) {
      if (err?.name === 'SpendCapReached' || err?.dailyQuota) throw err;
      log(`[daily] stories for workspace ${w.id} (${w.name}) failed: ${String(err.message).slice(0, 300)}`);
      failed.push({ workspaceId: w.id, error: String(err.message).slice(0, 300) });
    }
  }
  if (failed.length && failed.length === workspaces.length) throw new Error(`Stories failed for every workspace: ${failed[0].error}`);
  return { collected, understood, stories, workspaces: workspaces.length, failed };
}

// One workspace's refresh: collect only what it tracks (a source anyone collected within the
// on-demand cooldown is not scraped again), understand the new posts, and build the workspace's
// stories from its posts of the last week, including any a failed run left without a story.
// `feedId` is for tests. Throws the spend-cap error when the cap stopped collection before anything came in.
export async function runRefresh({ runId, workspaceId, log = console.log, feedId = null }) {
  if (!workspaceId) throw new Error('runRefresh needs a workspaceId');
  const settings = await getSettings();
  if (!isFake()) {
    const { assertUnderDailyCap } = await import('../lib/spend.js');
    await assertUnderDailyCap('apify');
    await assertUnderDailyCap(aiProvider());
  }
  const { collectDaily } = await load('collect');
  const collected = await collectDaily({ runId, workspaceId, log, minHours: settings.on_demand_cooldown_minutes / 60 });
  if (collected.capReached && !collected.posts) throw collected.capReached;
  let understood = { skipped: true };
  if (collected.newPostIds.length) {
    const { understandNewPosts } = await load('understand');
    understood = await understandNewPosts({ runId, postIds: collected.newPostIds, log });
  }
  const stories = await buildWorkspaceStories({ runId, workspaceId, feedId, log });
  return { collected, understood, stories };
}

async function markReport(reportId, status, { storyId = null, note = null } = {}) {
  await pool.query(
    `update reports set status = $2, story_id = coalesce($3, story_id), note = coalesce($4, note), updated_at = now() where id = $1`,
    [reportId, status, storyId, note],
  );
}

// One report: search-based collection for its query and dates, understanding, and one story in the
// workspace's own feed, published when its checks pass. Credits are settled by the job layer.
export async function runReport({ reportId, runId, log = console.log }) {
  const { rows } = await pool.query(
    `select id, workspace_id, query, platforms::text[] as platforms, date_from::text as date_from, date_to::text as date_to from reports where id = $1`,
    [reportId],
  );
  const report = rows[0];
  if (!report) throw new Error(`report ${reportId} does not exist`);
  // A story that was built but failed its checks stays linked, unpublished, for the review queue.
  let storyId = null;
  try {
    let postIds;
    if (skipCollect()) {
      // Tests: build from posts already saved for this query and workspace.
      const saved = await pool.query(`select post_id from post_queries where lower(query) = lower($1) and workspace_id = $2`, [report.query, report.workspace_id]);
      postIds = saved.rows.map((r) => r.post_id);
    } else {
      const { collectForQuery } = await load('collect');
      ({ postIds } = await collectForQuery({
        runId, workspaceId: report.workspace_id, query: report.query, platforms: report.platforms, dateFrom: report.date_from, dateTo: report.date_to, log,
      }));
      const { understandNewPosts } = await load('understand');
      await understandNewPosts({ runId, postIds, log });
    }
    if (!postIds?.length) throw new Error(`No posts were found for “${report.query}” on those platforms and dates`);

    const feedId = await workspaceFeedId(report.workspace_id);
    const built = await buildStories({ runId, feedId, postIds, single: true, log, title: report.query });
    const story = built.find((b) => b.storyId && !b.error);
    if (!story) throw new Error(built.find((b) => b.error)?.error ?? 'No story could be built from the posts found');
    storyId = story.storyId;
    if (!story.passed) throw new Error('The story did not pass its citation and number checks');

    await markReport(reportId, 'ready', { storyId: story.storyId });
    log(`[report] ${reportId} ready: story ${story.storyId} v${story.version}`);
    return { storyId: story.storyId };
  } catch (err) {
    await markReport(reportId, 'failed', { storyId, note: `Couldn’t be prepared automatically: ${String(err.message).slice(0, 300)}. Your credits were released.` });
    throw err;
  }
}
