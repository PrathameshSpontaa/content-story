// The production pipeline's two entry points, called by the job layer (pipeline/jobs.js): the daily
// run for the shared feed, and one on-demand report into its workspace's own feed.
import { pool } from '../lib/db.js';
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

export async function workspaceFeedId(workspaceId) {
  const { rows } = await pool.query('select id from feeds where workspace_id = $1 order by id limit 1', [workspaceId]);
  if (rows[0]) return rows[0].id;
  const { rows: ws } = await pool.query('select name from workspaces where id = $1', [workspaceId]);
  const { rows: created } = await pool.query('insert into feeds (workspace_id, name) values ($1, $2) returning id', [workspaceId, `${ws[0]?.name ?? 'Workspace'} reports`]);
  return created[0].id;
}

// Collect everything tracked, understand the new posts, then group and write the shared feed's stories.
export async function runDaily({ runId, log = console.log }) {
  let collected = { skipped: true };
  let understood = { skipped: true };
  if (!skipCollect()) {
    const { collectDaily } = await load('collect');
    collected = await collectDaily({ runId, log });
    const { understandNewPosts } = await load('understand');
    understood = await understandNewPosts({ runId, log });
  } else log('[daily] PIPELINE_SKIP_COLLECT=1: collection and understanding skipped');
  const stories = await buildStories({ runId, feedId: await sharedFeedId(), log });
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
