// End-to-end check of the story review queue (approve, reject, merge, keep separate), report-story
// access and the operations helpers against the real database. Creates throwaway stories, posts,
// a workspace and a reviewer, prints PASS/FAIL, then deletes everything it made.
// Usage: node scripts/test-admin.js
import assert from 'node:assert/strict';
import {
  costByDay,
  getStoryForReview,
  keepSeparate,
  listNotificationProblems,
  listReportRuns,
  listRuns,
  listStoriesForReview,
  marginByAction,
  mergeStory,
  rejectStory,
  setStoryPublished,
  spendToday,
} from '../lib/admin.js';
import { pool } from '../lib/db.js';
import { getFeed, getStory } from '../lib/stories.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name}: ${err.message}`]);
  }
}

const suffix = Date.now();
const made = { stories: [], posts: [], runs: [], users: [], workspaces: [], feeds: [] };
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

// A version with the same JSON shape the pipeline writes, small enough to read.
function version(storyId, n, { passed = true, errors = [], warnings = [], headline = `Admin test story ${suffix}` } = {}) {
  return q(
    `insert into story_versions (story_id, version, narrative, stats, written, platform_takes, feed_edit, checks, passed, models)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      storyId,
      n,
      { main_character: { name: 'Test Character' }, supporting_cast: [], beats: [], angles: [], open_questions: [] },
      { heat: 40, posts: 2, sources: 2, creators: 1, platforms: 2, beat_order: [], beat_times: [], turning_points: [], angle_reactions: [], warnings: [] },
      { headline, narrative: [{ sentence: 'A throwaway story for the admin test.', cites: [] }], beat_lines: [], angle_blurbs: [] },
      { platforms: [], contrast: [] },
      { headline, dek: 'Created and deleted by scripts/test-admin.js.', platform_strip: [{ platform: 'x', gist: 'Testing.' }] },
      { pass: passed, errors, warnings, hidden_quotes: [], quote_sources: {} },
      passed,
      { writer: 'test', checks: 'test' },
    ],
  );
}

async function story(feedId, { status = 'emerging', published = false, headline } = {}) {
  const [row] = await q(
    `insert into stories (feed_id, status, category, heat, published_at, first_post_at, last_post_at)
     values ($1, $2, 'AI & tech', 40, $3, now() - interval '2 hours', now()) returning id`,
    [feedId, status, published ? new Date() : null],
  );
  made.stories.push(row.id);
  await version(row.id, 1, { headline });
  return row.id;
}

async function post(tag, storyId) {
  const id = `admintest_${suffix}_${tag}`;
  await q(`insert into posts (id, platform, platform_post_id, url, kind, text, published_at) values ($1, 'x', $1, 'https://example.com/' || $1, 'post', 'test post', now())`, [id]);
  made.posts.push(id);
  if (storyId) await q('insert into story_posts (story_id, post_id, reason) values ($1, $2, $3)', [storyId, id, 'test']);
  return id;
}

try {
  const [shared] = await q('select id from feeds where workspace_id is null');
  const [reviewer] = await q(`insert into users (email, name) values ($1, 'Admin Test') returning id`, [`admin-test-${suffix}@content-story.dev`]);
  made.users.push(reviewer.id);
  const by = { reviewerId: reviewer.id, note: 'test note' };
  const [{ now: startedAt }] = await q('select now()');
  const publishedBefore = (await q('select id, published_at, status from stories where published_at is not null and created_at < $1 order by id', [startedAt]));

  const a = await story(shared.id, { headline: `Admin test A ${suffix}` });
  const b = await story(shared.id, { headline: `Admin test B ${suffix}` });
  // Story A has a second, failing version on top: the queue shows the newest one.
  await version(a, 2, { passed: false, errors: ['Number 12 not found in stats'], warnings: ['Quote shortened'], headline: `Admin test A ${suffix}` });
  const shared1 = await post('shared1', a);
  await post('a_only', a);
  await q('insert into story_posts (story_id, post_id, reason) values ($1, $2, $3)', [b, shared1, 'test']);
  await post('b_only', b);
  await q(`insert into merge_candidates (story_a, story_b, reason) values ($1, $2, 'same launch')`, [a, b]);

  await check('a new pipeline story shows as waiting, with its newest version, checks and merge flag', async () => {
    const waiting = await listStoriesForReview('unreviewed');
    const row = waiting.find((s) => s.id === a);
    assert.ok(row, 'story A missing from the waiting list');
    assert.equal(row.version, 2);
    assert.equal(row.passed, false);
    assert.equal(row.has_passed_version, true);
    assert.equal(row.error_count, 1);
    assert.equal(row.warning_count, 1);
    assert.equal(row.merge_candidates, 1);
    assert.equal(row.sources, 2);
    assert.equal(row.post_count, 2);
    assert.ok(!(await listStoriesForReview('published')).some((s) => s.id === a));
    const all = await listStoriesForReview();
    assert.ok(all.findIndex((s) => s.id === a) < all.findIndex((s) => s.published_at), 'waiting stories come before published ones');
  });

  await check('the review view has the latest version, checks, history, posts and candidates', async () => {
    const r = await getStoryForReview(a);
    assert.equal(r.checks.errors[0], 'Number 12 not found in stats');
    assert.deepEqual(
      r.versions.map((v) => [v.version, v.passed]),
      [
        [2, false],
        [1, true],
      ],
    );
    assert.equal(r.posts.length, 2);
    assert.equal(r.candidates[0].other_id, b);
    assert.equal(r.feed_workspace_id, null);
    assert.equal(await getStoryForReview('not-a-uuid'), null);
  });

  await check('approve publishes only a story with a passed version, and records the reviewer', async () => {
    const neverPassed = await story(shared.id);
    await q('update story_versions set passed = false where story_id = $1', [neverPassed]);
    assert.equal(await setStoryPublished(neverPassed, true, by), false);
    assert.equal(await setStoryPublished(a, true, by), true);
    const [row] = await q('select published_at, reviewed_at, reviewed_by, review_note from stories where id = $1', [a]);
    assert.ok(row.published_at && row.reviewed_at);
    assert.equal(row.reviewed_by, reviewer.id);
    assert.equal(row.review_note, 'test note');
    assert.ok((await listStoriesForReview('published')).some((s) => s.id === a));
    assert.ok((await getFeed()).some((s) => s.id === a));
    assert.ok(await getStory(a, null), 'published shared story opens for anyone');
  });

  await check('reject unpublishes and sets the status; approving again brings it back', async () => {
    assert.equal(await rejectStory(a, { reviewerId: reviewer.id, note: 'off topic' }), true);
    const [row] = await q('select status, published_at, review_note from stories where id = $1', [a]);
    assert.equal(row.status, 'rejected');
    assert.equal(row.published_at, null);
    assert.equal(row.review_note, 'off topic');
    assert.ok((await listStoriesForReview('rejected')).some((s) => s.id === a));
    assert.ok(!(await getFeed()).some((s) => s.id === a));
    assert.equal(await setStoryPublished(a, true, by), true);
    assert.equal((await q('select status from stories where id = $1', [a]))[0].status, 'active');
  });

  await check('unpublish takes a story off the feed', async () => {
    assert.equal(await setStoryPublished(a, false, by), true);
    assert.ok(!(await getFeed()).some((s) => s.id === a));
    assert.equal(await getStory(a, null), null);
    await setStoryPublished(a, true, by);
  });

  await check('keep separate resolves a candidate without merging', async () => {
    const c = await story(shared.id);
    await q(`insert into merge_candidates (story_a, story_b, reason) values ($1, $2, 'similar')`, [c, a]);
    assert.equal(await keepSeparate(a, c), true);
    assert.equal(await keepSeparate(a, c), false);
    assert.equal((await q('select status from stories where id = $1', [c]))[0].status, 'emerging');
  });

  await check('merge moves posts (skipping duplicates), marks merged, resolves the candidate and leaves the feed', async () => {
    await setStoryPublished(b, true, by);
    assert.ok((await getFeed()).some((s) => s.id === b));
    await mergeStory(b, a, by);
    const [row] = await q('select status, merged_into, published_at from stories where id = $1', [b]);
    assert.equal(row.status, 'merged');
    assert.equal(row.merged_into, a);
    assert.equal(row.published_at, null);
    const posts = (await q('select post_id from story_posts where story_id = $1 order by post_id', [a])).map((r) => r.post_id);
    assert.deepEqual(posts, [...new Set([`admintest_${suffix}_shared1`, `admintest_${suffix}_a_only`, `admintest_${suffix}_b_only`])].sort());
    assert.equal((await q('select count(*)::int as n from story_posts where story_id = $1', [b]))[0].n, 0);
    assert.ok((await q('select resolved_at from merge_candidates where story_a = $1 and story_b = $2', [a, b]))[0].resolved_at);
    assert.ok(!(await getFeed()).some((s) => s.id === b));
    assert.ok((await listStoriesForReview('merged')).some((s) => s.id === b));
    assert.equal(await setStoryPublished(b, true, by), false, 'a merged story cannot be published');
    await assert.rejects(mergeStory(b, a, by), /already merged/);
    await assert.rejects(mergeStory(a, a, by), /itself/);
  });

  await check('a finished report story opens for its own workspace only', async () => {
    const [ws] = await q(`insert into workspaces (name) values ($1) returning id`, [`billing test admin ${suffix}`]);
    made.workspaces.push(ws.id);
    const [feed] = await q(`insert into feeds (workspace_id, name) values ($1, 'Reports') returning id`, [ws.id]);
    made.feeds.push(feed.id);
    const reportStory = await story(feed.id, { status: 'active', published: true });
    assert.ok(await getStory(reportStory, ws.id), 'the owning workspace can open it');
    assert.equal(await getStory(reportStory, null), null, 'no workspace: not visible');
    const [other] = await q(`insert into workspaces (name) values ($1) returning id`, [`billing test admin other ${suffix}`]);
    made.workspaces.push(other.id);
    assert.equal(await getStory(reportStory, other.id), null, 'another workspace cannot open it');
    assert.equal(await getStory(reportStory), null, 'outside a request there is no session, so it stays hidden');
    assert.ok(!(await getFeed()).some((s) => s.id === reportStory), 'report stories never join the shared feed');

    const [run] = await q(`insert into runs (kind, workspace_id, status, finished_at, summary) values ('report', $1, 'done', now(), '{"posts": 3}') returning id`, [ws.id]);
    made.runs.push(run.id);
    const [report] = await q(
      `insert into reports (workspace_id, query, platforms, date_from, date_to, quoted_credits, story_id, status, created_at)
       values ($1, 'Admin test', '{x}', current_date, current_date, 100, $2, 'ready', now() - interval '1 minute') returning id`,
      [ws.id, reportStory],
    );
    assert.equal((await listReportRuns())[report.id]?.run_id, run.id);
  });

  await check('runs, spend, margin and notification helpers return rows', async () => {
    const [run] = await q(`insert into runs (kind, status, finished_at, summary) values ('daily', 'failed', now(), '{"stories": 2}') returning id`);
    made.runs.push(run.id);
    await q(`insert into cost_events (provider, detail, run_id, usd) values ('apify', 'admin-test', $1, 0.25), ('gemini', 'admin-test', $1, 0.05)`, [run.id]);
    const runs = await listRuns(50);
    const mine = runs.find((r) => r.id === run.id);
    assert.ok(mine, 'the test run is listed');
    assert.equal(Math.round(mine.usd * 100), 30);
    assert.equal(mine.summary.stories, 2);
    const days = await costByDay(14);
    assert.ok(days.length >= 1 && days[0].apify >= 0.25 && days[0].gemini >= 0.05);
    const today = await spendToday();
    assert.deepEqual(
      today.map((t) => t.provider),
      ['apify', 'gemini'],
    );
    assert.ok(today[0].usd >= 0.25 && today[0].cap > 0);
    const margin = await marginByAction(30);
    assert.ok(margin.inrPerCredit > 0 && Array.isArray(margin.rows));
    assert.ok(margin.rows.find((r) => r.bucket === 'tracking')?.usd >= 0.3);
    assert.ok(Array.isArray(await listNotificationProblems(20)));
  });

  await check('the existing published stories were not touched', async () => {
    const after = await q('select id, published_at, status from stories where published_at is not null and created_at < $1 order by id', [startedAt]);
    assert.deepEqual(after, publishedBefore);
  });
} finally {
  // Merged stories point at their target; clear that before deleting.
  if (made.runs.length) await q('delete from cost_events where run_id = any($1::uuid[])', [made.runs]);
  if (made.stories.length) {
    await q('update stories set merged_into = null where id = any($1::uuid[])', [made.stories]);
    await q('delete from stories where id = any($1::uuid[])', [made.stories]);
  }
  if (made.posts.length) await q('delete from posts where id = any($1::text[])', [made.posts]);
  if (made.runs.length) await q('delete from runs where id = any($1::uuid[])', [made.runs]);
  if (made.workspaces.length) await q('delete from workspaces where id = any($1::uuid[])', [made.workspaces]);
  if (made.users.length) await q('delete from users where id = any($1::uuid[])', [made.users]);
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
