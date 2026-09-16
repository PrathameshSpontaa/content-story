// End-to-end check of collection and understanding in fake mode against the real database: the
// dry-run files stand in for Apify and Gemini, so nothing is spent. Creates a run and a throwaway
// workspace tracking every dry-run creator and subreddit, runs the daily pass and the cheap-model
// pass, prints PASS/FAIL, then removes everything it added and restores what it touched.
// Usage: node scripts/test-collect.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../lib/db.js';

process.env.PIPELINE_PROVIDER = 'fake';
const { collectDaily, loadHandles } = await import('../pipeline/collect.js');
const { fixtureDir, readFixtureMeta, readRawFixture } = await import('../pipeline/fixtures.js');
const { normalizeComments, normalizePosts } = await import('../pipeline/normalize.js');
const { PROMPT_VERSION, understandNewPosts } = await import('../pipeline/understand.js');

const DAY = 86_400_000;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name}: ${err.message}`]);
  }
}
const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(`  | ${line}`);
};
const q = async (sql, params) => (await pool.query(sql, params)).rows;

const suffix = Date.now();
const startedAt = new Date().toISOString();
const meta = readFixtureMeta();
assert.ok(meta, `no dry-run fixtures at ${fixtureDir()}`);
const fixturePosts = JSON.parse(readFileSync(join(fixtureDir(), 'posts.json'), 'utf8'));
const fixtureComments = JSON.parse(readFileSync(join(fixtureDir(), 'comments.json'), 'utf8'));

let runId;
let workspaceId;
let collected;
const snapshots = []; // captured_at of every metrics snapshot this test wrote
const before = {};
try {
  runId = (await q(`insert into runs (kind, status) values ('daily', 'running') returning id`))[0].id;
  before.handles = await q('select id, last_collected_at from creator_handles');
  before.queries = await q('select query_key, platform::text as platform, last_collected_at from query_collections');
  before.posts = Number((await q('select count(*)::int as n from posts'))[0].n);

  await check('the normalizer reproduces the dry run: same post ids and comment ids from the raw files', async () => {
    const handles = await loadHandles();
    const raw = { x: readRawFixture('x', 'posts'), instagram: readRawFixture('instagram', 'posts'), linkedin: readRawFixture('linkedin', 'posts'), youtube: readRawFixture('youtube', 'posts'), tiktok: readRawFixture('tiktok', 'posts'), reddit: readRawFixture('reddit', 'threads') };
    const subtitles = new Map();
    for (const v of raw.tiktok) {
      try {
        subtitles.set(String(v.id), readFileSync(join(fixtureDir(), 'raw', 'tiktok', 'subtitles', `${v.id}.vtt`), 'utf8'));
      } catch {
        // no subtitle for this video
      }
    }
    const { posts, comments } = normalizePosts(raw, { handles, collectedAt: Date.parse(meta.collected_at), windowFrom: Date.parse(meta.window_from), subtitles });
    const want = new Set(fixturePosts.map((p) => p.post_id));
    const got = new Set(posts.map((p) => p.post_id));
    const missing = [...want].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !want.has(id));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
    assert.ok(posts.every((p) => p.platform === 'reddit' ? p.community && !p.handle_id : p.handle_id && p.creator));
    const separate = { x: readRawFixture('x', 'replies'), instagram: readRawFixture('instagram', 'comments'), linkedin: readRawFixture('linkedin', 'comments'), youtube: readRawFixture('youtube', 'comments'), tiktok: readRawFixture('tiktok', 'comments') };
    const all = [...comments, ...normalizeComments(separate, { posts, collectedAt: Date.parse(meta.collected_at) }).comments];
    const ids = new Set(all.map((c) => c.comment_id));
    const wantC = new Set(fixtureComments.map((c) => c.comment_id));
    assert.equal(ids.size, all.length, 'comment ids unique');
    assert.deepEqual([...wantC].filter((id) => !ids.has(id)).length, 0, 'every dry-run comment is found');
    assert.deepEqual([...ids].filter((id) => !wantC.has(id)).length, 0, 'no comment the dry run did not have');
    const byId = new Map(fixtureComments.map((c) => [c.comment_id, c]));
    assert.ok(all.every((c) => byId.get(c.comment_id).is_creator === c.is_creator), 'creator replies flagged the same way');
  });

  await check('a throwaway workspace tracks every dry-run creator, subreddit and one keyword', async () => {
    workspaceId = (await q(`insert into workspaces (name) values ($1) returning id`, [`collect-test-${suffix}`]))[0].id;
    const { rowCount } = await pool.query(
      `insert into tracking_targets (workspace_id, kind, creator_id, platforms)
       select $1, 'creator', c.id, array_agg(distinct h.platform)
         from creators c join creator_handles h on h.creator_id = c.id and h.verified
        group by c.id`,
      [workspaceId],
    );
    assert.ok(rowCount >= 10, `expected the dry-run creators, got ${rowCount}`);
    for (const sub of ['r/singularity', 'r/OpenAI', 'r/LocalLLaMA']) {
      await pool.query(`insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, 'community', $2, '{reddit}')`, [workspaceId, sub]);
    }
    await pool.query(`insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, 'keyword', $2, '{x,youtube,instagram}')`, [workspaceId, `Astra test ${suffix}`]);
  });

  await check('collectDaily runs every fixture through the real pipeline without spending', async () => {
    const windowDays = (Date.now() - Date.parse(meta.window_from)) / DAY;
    collected = await collectDaily({ runId, log, minHours: 0, windowDays, commentBudget: 1500 });
    snapshots.push(...collected.capturedAt);
    assert.ok(collected.handles >= 40, `handles collected: ${collected.handles}`);
    assert.ok(collected.posts >= 150, `posts: ${collected.posts}`);
    assert.ok(collected.comments >= 800, `comments: ${collected.comments}`);
    assert.equal(collected.usd, 0);
    assert.ok(lines.some((l) => /no search actor for instagram/.test(l)), 'Instagram search is reported as skipped');
    assert.ok(lines.some((l) => /fake mode: no fixture/.test(l)), 'a missing search fixture is logged and skipped');
  });

  await check('posts landed on their existing rows: no duplicates, few or no new posts', async () => {
    const dupes = await q('select platform, platform_post_id from posts group by 1, 2 having count(*) > 1');
    assert.deepEqual(dupes, []);
    const after = Number((await q('select count(*)::int as n from posts'))[0].n);
    assert.equal(after - before.posts, collected.newPosts);
    assert.ok(collected.newPosts <= 5, `${collected.newPosts} new posts (expected 0 or a few)`);
    assert.ok(collected.newComments <= 20, `${collected.newComments} new comments`);
  });

  await check('every post got a metrics snapshot for this capture', async () => {
    const [{ n }] = await q('select count(*)::int as n from post_metrics where captured_at = any($1::timestamptz[])', [collected.capturedAt]);
    assert.equal(n, collected.postIds.length);
    assert.ok(n > 0);
    const [{ lifted }] = await q('select count(*)::int as lifted from post_metrics where captured_at = any($1::timestamptz[]) and lift is not null', [collected.capturedAt]);
    assert.equal(lifted, n);
  });

  await check('raw captures keep the items, and each Apify call is a cost event on this run', async () => {
    const captures = await q('select platform::text as platform, source, storage_path, items, usd, jsonb_array_length(payload) as stored from raw_captures where run_id = $1', [runId]);
    assert.ok(captures.length >= 10, `${captures.length} captures`);
    assert.ok(captures.every((c) => c.stored === c.items && c.storage_path === `db:${c.storage_path.slice(3)}` && Number(c.usd) === 0));
    assert.ok(captures.some((c) => c.platform === 'reddit' && c.items === 360));
    const costs = await q(`select provider, detail, usd, units from cost_events where run_id = $1 and provider = 'apify'`, [runId]);
    assert.equal(costs.length, captures.length);
    assert.ok(costs.every((c) => c.provider === 'apify' && Number(c.usd) === 0 && typeof c.units.items === 'number'));
    const [{ n }] = await q('select count(*)::int as n from posts where raw_capture_id = any($1::uuid[])', [collected.captureIds]);
    assert.ok(n >= 150, `${n} posts point at this run's captures`);
  });

  await check('last_collected_at moved forward on every collected handle and the keyword', async () => {
    const rows = await q(
      `select h.id, h.last_collected_at from creator_handles h join creators c on c.id = h.creator_id
        where h.verified and h.platform in ('x', 'youtube', 'linkedin', 'instagram', 'tiktok')`,
    );
    assert.ok(rows.length > 0 && rows.every((r) => r.last_collected_at && r.last_collected_at.toISOString() >= startedAt));
    const kw = await q('select platform::text as platform from query_collections where query_key = $1 order by 1', [`astra test ${suffix}`]);
    assert.deepEqual(kw.map((k) => k.platform), ['x', 'youtube']);
    const subs = await q(`select query_key from query_collections where platform = 'reddit' and query_key like 'r/%' and last_collected_at >= $1 order by 1`, [startedAt]);
    assert.deepEqual(subs.map((s) => s.query_key), ['r/localllama', 'r/openai', 'r/singularity']);
  });

  await check('a second daily pass within COLLECT_MIN_HOURS collects nothing', async () => {
    const again = await collectDaily({ runId, log, minHours: 20, windowDays: 7 });
    snapshots.push(...again.capturedAt);
    assert.equal(again.handles, 0);
    assert.equal(again.communities, 0);
    assert.equal(again.posts, 0);
  });

  await check('understandNewPosts writes cards, claims, entities and groups from the cheap model', async () => {
    const [pick] = await q(
      `select p.id from posts p join story_cards sc on sc.post_id = p.id join comment_groups g on g.post_id = p.id
        where p.id = any($1::text[]) and p.platform = 'x' group by p.id order by count(g.id) desc limit 1`,
      [collected.postIds],
    );
    assert.ok(pick, 'a collected X post with a card and groups');
    const [other] = await q(`select p.id from posts p join story_cards sc on sc.post_id = p.id where p.platform = 'reddit' and p.id = any($1::text[]) limit 1`, [collected.postIds]);
    const ids = [pick.id, other.id];
    // Whole rows, so cleanup puts back exactly what the imported dry run had.
    before.understood = {
      ids,
      cards: await q('select * from story_cards where post_id = any($1::text[])', [ids]),
      claims: await q('select * from claims where post_id = any($1::text[])', [ids]),
      postEntities: await q('select * from post_entities where post_id = any($1::text[])', [ids]),
      groups: await q('select * from comment_groups where post_id = any($1::text[])', [ids]),
      entityIds: (await q('select id from entities')).map((e) => e.id),
    };
    const wasClaims = Number((await q('select count(*)::int as n from claims where post_id = any($1::text[])', [ids]))[0].n);
    const wasEntities = Number((await q('select count(*)::int as n from post_entities where post_id = any($1::text[])', [ids]))[0].n);
    const counts = await understandNewPosts({ runId, postIds: ids, force: true, log });
    assert.equal(counts.cards, 2);
    assert.ok(counts.groups >= 1, `groups written: ${counts.groups}`);
    const cards = await q('select post_id, model, prompt_version from story_cards where post_id = any($1::text[])', [ids]);
    assert.ok(cards.every((c) => c.prompt_version === PROMPT_VERSION && c.model));
    assert.equal(Number((await q('select count(*)::int as n from claims where post_id = any($1::text[])', [ids]))[0].n), wasClaims);
    assert.equal(Number((await q('select count(*)::int as n from post_entities where post_id = any($1::text[])', [ids]))[0].n), wasEntities);
    const groups = await q('select id, comment_ids, sample_ids, prompt_version from comment_groups where post_id = $1', [pick.id]);
    assert.ok(groups.length >= 1 && groups.every((g) => g.prompt_version === PROMPT_VERSION && g.comment_ids.length && g.sample_ids.every((s) => g.comment_ids.includes(s))));
    const [{ n }] = await q('select count(*)::int as n from comments where id = any($1::text[]) and post_id = $2', [groups.flatMap((g) => g.comment_ids), pick.id]);
    assert.equal(n, groups.reduce((s, g) => s + g.comment_ids.length, 0), 'every grouped comment id is a real comment on the post');
  });

  await check('understandNewPosts on posts that already have cards and groups does nothing', async () => {
    const counts = await understandNewPosts({ runId, postIds: collected.postIds.slice(0, 20), log });
    assert.deepEqual([counts.cards, counts.groups], [0, 0]);
  });
} finally {
  const cleanup = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      results.push(['FAIL', `cleanup ${name}: ${err.message}`]);
    }
  };
  if (collected) {
    await cleanup('new comments', () => pool.query('delete from comments where id = any($1::text[])', [collected.newCommentIds]));
    await cleanup('new posts', () => pool.query('delete from posts where id = any($1::text[])', [collected.newPostIds]));
    await cleanup('metrics snapshots', () => pool.query('delete from post_metrics where captured_at = any($1::timestamptz[])', [snapshots]));
    await cleanup('post_queries', () => pool.query('delete from post_queries where workspace_id is null and found_at >= $1', [startedAt]));
  }
  if (runId) {
    await cleanup('captures', async () => {
      await pool.query('update posts set raw_capture_id = null where raw_capture_id in (select id from raw_captures where run_id = $1)', [runId]);
      await pool.query('delete from raw_captures where run_id = $1', [runId]);
      await pool.query('delete from cost_events where run_id = $1', [runId]);
    });
  }
  if (before.handles) {
    await cleanup('last_collected_at', () =>
      pool.query(
        `update creator_handles h set last_collected_at = s.at from jsonb_to_recordset($1::jsonb) as s(id uuid, at timestamptz) where h.id = s.id`,
        [JSON.stringify(before.handles.map((h) => ({ id: h.id, at: h.last_collected_at })))],
      ),
    );
  }
  if (before.queries) {
    await cleanup('query_collections', async () => {
      await pool.query('delete from query_collections where last_collected_at >= $1', [startedAt]);
      if (before.queries.length) {
        await pool.query(
          `insert into query_collections (query_key, platform, last_collected_at)
           select query_key, platform::platform, at from jsonb_to_recordset($1::jsonb) as s(query_key text, platform text, at timestamptz)
           on conflict (query_key, platform) do update set last_collected_at = excluded.last_collected_at`,
          [JSON.stringify(before.queries.map((r) => ({ query_key: r.query_key, platform: r.platform, at: r.last_collected_at })))],
        );
      }
    });
  }
  if (before.understood) {
    const u = before.understood;
    const restore = (table, rows) => (rows.length ? pool.query(`insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`, [JSON.stringify(rows)]) : null);
    await cleanup('understood rows', async () => {
      await pool.query('delete from claims where post_id = any($1::text[])', [u.ids]);
      await pool.query('delete from post_entities where post_id = any($1::text[])', [u.ids]);
      await pool.query('delete from comment_groups where post_id = any($1::text[])', [u.ids]);
      await pool.query('delete from story_cards where post_id = any($1::text[])', [u.ids]);
      await restore('story_cards', u.cards);
      await restore('claims', u.claims);
      await restore('post_entities', u.postEntities);
      await restore('comment_groups', u.groups);
      // Entities the test created that nothing points at any more.
      await pool.query(
        `delete from entities e where e.id <> all($1::uuid[])
           and not exists (select 1 from post_entities pe where pe.entity_id = e.id)
           and not exists (select 1 from stories s where s.main_entity_id = e.id)`,
        [u.entityIds],
      );
    });
  }
  if (workspaceId) await cleanup('workspace', () => pool.query('delete from workspaces where id = $1', [workspaceId]));
  if (runId) await cleanup('run', () => pool.query('delete from runs where id = $1', [runId]));
  await pool.end();
}

console.log('');
for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
if (collected) console.log(`\ncollected: ${collected.handles} handles, ${collected.posts} posts (${collected.newPosts} new), ${collected.comments} comments (${collected.newComments} new), $${collected.usd}`);
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
