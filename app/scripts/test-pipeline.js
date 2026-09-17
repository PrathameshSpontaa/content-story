// End-to-end check of the story builder in fake mode (no Gemini calls, no spend) against the real
// database: grouping, new and attached stories, versions, checks, lifecycle, split-story flags, the
// publish rule, a report, and the AI editor's publish, hold, reject and merge decisions. Prints
// PASS/FAIL, then deletes everything it created, restores the heat and status of the stories that were
// already there and puts the app_settings rows it changed back as they were.
// The AI editor checks run in a throwaway workspace feed with buildStories' treatAsShared option, so no
// story the test publishes is ever in the real shared feed (workspace stories show only to members).
// Usage: node scripts/test-pipeline.js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake provider, no collection: set before the pipeline modules load.
const overlay = join(tmpdir(), `content-story-pipeline-test-${Date.now()}`);
process.env.PIPELINE_PROVIDER = 'fake';
process.env.PIPELINE_SKIP_COLLECT = '1';
process.env.PIPELINE_FIXTURE_OVERLAY = overlay;

const { pool } = await import('../lib/db.js');
const { generateJson } = await import('../pipeline/ai.js');
const { computeStats, entityRanking, heatScore } = await import('../pipeline/stats.js');
const { lengthProblems, verifyStory } = await import('../pipeline/verify.js');
const { PROMPT_VERSION, STATUSES, buildStories, findAliasMerges, loadWorld, nextStatus, splitCandidates } = await import('../pipeline/storybuild.js');
const { runDaily, runReport, sharedFeedId, workspaceFeedId } = await import('../pipeline/index.js');

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
const PLATFORM_ORDER = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];
const writeFixture = (step, label, value) => {
  mkdirSync(join(overlay, step), { recursive: true });
  writeFileSync(join(overlay, step, `${label}.json`), JSON.stringify(value, null, 2));
};
const removeFixture = (step, label) => rmSync(join(overlay, step, `${label}.json`), { force: true });

// The settings the pipeline reads, switched through app_settings rows. The rows as they were are read
// first and put back exactly at the end; rows the test inserted are deleted.
const SETTING_KEYS = ['auto_publish', 'auto_merge', 'merge_min_confidence'];
const settingsBefore = await q('select key, value, updated_at, updated_by from app_settings where key = any($1::text[])', [SETTING_KEYS]);
async function setSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    await q(`insert into app_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
  }
}

// Fixtures for the four story steps, built from the real posts so every cited ID exists. The first
// writer answer has 6 sentences and the first feed headline 14 words, so each step must be re-run.
async function storyFixtures(label, postIds, { mainCharacter = null, tooLong = false } = {}) {
  const world = await loadWorld(postIds);
  const ranking = entityRanking(world, postIds);
  const main = mainCharacter ?? ranking[0].name;
  const evidence = (postId) => {
    const claim = world.cardByPost.get(postId)?.claims[0];
    return [{ source_id: claim?.claim_id ?? postId, post_id: postId, relation: 'supports', note: 'test evidence' }];
  };
  const groups = [...world.groupById.values()];
  writeFixture('builder', label, {
    story_id: label,
    main_character: { name: main, reason: 'Top-ranked entity in the test posts' },
    supporting_cast: [],
    beats: postIds.map((id) => ({ what: 'A creator posted about it', source_post_ids: [id], source_comment_ids: [], turning_point_candidate: false, reason: '' })),
    angles: [
      { title: 'It matters', thesis: 'People say it matters.', kind: 'opinion', evidence: evidence(postIds[0]) },
      { title: 'It is overblown', thesis: 'People say it is overblown.', kind: 'opinion', evidence: evidence(postIds.at(-1)) },
    ],
    reactions: groups.flatMap((g) => [
      { group_id: g.id, angle_index: 0, relation: 'agrees' },
      { group_id: g.id, angle_index: 1, relation: 'disagrees' },
    ]),
    open_questions: [],
  });
  const sentence = (id) => ({ sentence: `${main} came up in this post [${id}].`, cites: [id] });
  const written = (count) => ({
    story_id: label,
    headline: `${main} draws attention across platforms`,
    narrative: Array.from({ length: count }, (_, i) => sentence(postIds[i % postIds.length])),
    beat_lines: postIds.map(() => 'A creator posted about it'),
    angle_blurbs: [],
    quotes: [],
  });
  writeFixture('writer', label, written(tooLong ? 6 : 3));
  if (tooLong) writeFixture('writer', `${label}.retry`, written(3));
  const platforms = PLATFORM_ORDER.filter((pl) => postIds.some((id) => world.postById.get(id).platform === pl));
  writeFixture('lens', label, {
    story_id: label,
    contrast: [{ sentence: 'The platforms cover the same event.', cites: [postIds[0]] }],
    platforms: platforms.map((platform) => ({
      platform,
      take: `${platform} talks about ${main}`,
      creators_say: { text: 'Creators here posted about it.', cites: postIds.filter((id) => world.postById.get(id).platform === platform) },
      audience_says: null,
      quote: null,
      distinct: '',
    })),
  });
  const edit = (headline) => ({ story_id: label, headline, dek: 'Platforms split on how much it matters.', platform_strip: platforms.map((platform) => ({ platform, gist: 'covers the story' })) });
  writeFixture('edit', label, edit(tooLong ? `${main} story headline that runs well past the twelve word limit for feeds today` : `${main} draws attention across platforms`));
  if (tooLong) writeFixture('edit', `${label}.retry`, edit(`${main} draws attention across platforms`));
  return { main };
}

const feedId = await sharedFeedId();
const before = await q(`select id::text, heat, status::text, published_at, first_post_at, last_post_at from stories where feed_id = $1`, [feedId]);
const beforeIds = new Set(before.map((s) => s.id));
const aliasSnapshot = await q('select alias, entity_id::text from entity_aliases');
const { rows: runRows } = await pool.query(`insert into runs (kind) values ('test') returning id`);
const runId = runRows[0].id;
const [{ now: testStart }] = await q('select now()');
let workspaceId = null;
let editorWorkspaceId = null;

try {
  // ── Code-only pieces ──────────────────────────────────────────────────────
  await check('alias rule joins "Astra" to "GPT-6 Astra" but not "iPhone" to "iPhone Duo" or generic words', async () => {
    const merges = findAliasMerges([
      { name: 'Astra', type: 'product' }, { name: 'GPT-6 Astra', type: 'product' },
      { name: 'iPhone', type: 'product' }, { name: 'iPhone Duo', type: 'product' },
      { name: 'Flash', type: 'product' }, { name: 'Gemini Flash', type: 'product' },
      { name: 'OpenAI', type: 'org' }, { name: 'OpenAI Codex', type: 'product' },
    ]);
    assert.deepEqual(merges.map((m) => [m.alias, m.into]), [['astra', 'GPT-6 Astra']]);
  });

  await check('heat decays with time since the last post (36h half-life)', async () => {
    const at = Date.parse('2026-09-10T00:00:00Z');
    const fresh = heatScore({ maxLift: 3, sources: 3, platforms: 2, split: 0.5, lastPostAt: at, now: at });
    const later = heatScore({ maxLift: 3, sources: 3, platforms: 2, split: 0.5, lastPostAt: at, now: at + 72 * 3.6e6 });
    assert.ok(fresh > 0 && Math.abs(later - fresh / 4) <= 1, `${fresh} → ${later}`);
  });

  await check('lifecycle: emerging, active, peaked, dormant; reviewer statuses are never changed', async () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const recent = '2026-09-15T12:00:00Z';
    assert.equal(nextStatus({ sources: 1, comments: 0, heat: 10, lastPostAt: recent, now }), 'emerging');
    assert.equal(nextStatus({ sources: 2, comments: 5, heat: 30, lastPostAt: recent, now }), 'active');
    assert.equal(nextStatus({ previous: 'active', sources: 2, comments: 5, heat: 20, previousHeat: 30, lastPostAt: recent, now }), 'peaked');
    assert.equal(nextStatus({ previous: 'peaked', gotNewPosts: true, sources: 3, comments: 5, heat: 40, previousHeat: 20, lastPostAt: recent, now }), 'active');
    assert.equal(nextStatus({ previous: 'active', sources: 2, comments: 5, heat: 5, previousHeat: 30, lastPostAt: '2026-09-10T00:00:00Z', now }), 'dormant');
    assert.equal(nextStatus({ previous: 'rejected', sources: 5, comments: 5, heat: 90, lastPostAt: recent, now }), 'rejected');
  });

  await check('length limits: a 14-word feed headline and 6 sentences are hard failures', async () => {
    const p = lengthProblems({
      written: { headline: 'Short headline', narrative: Array.from({ length: 6 }, () => ({ sentence: 'x', cites: ['a'] })) },
      edit: { headline: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen', dek: '' },
    });
    assert.ok(p.writer.some((x) => x.hard && /6 sentences/.test(x.text)));
    assert.ok(p.edit.some((x) => x.hard && /14 words/.test(x.text)));
  });

  await check('split check pairs stories with the same main entity and overlapping dates, once, smaller id first', async () => {
    const pairs = splitCandidates([
      { id: 'b0000000-0000-0000-0000-000000000000', entity: 'e1', first_post_at: '2026-09-10', last_post_at: '2026-09-12' },
      { id: 'a0000000-0000-0000-0000-000000000000', entity: 'e1', first_post_at: '2026-09-11', last_post_at: '2026-09-13' },
      { id: 'c0000000-0000-0000-0000-000000000000', entity: 'e1', first_post_at: '2026-09-14', last_post_at: '2026-09-15' },
      { id: 'd0000000-0000-0000-0000-000000000000', entity: 'e2', first_post_at: '2026-09-10', last_post_at: '2026-09-15' },
    ]);
    assert.deepEqual(pairs.map((p) => [p.story_a[0], p.story_b[0]]), [['a', 'b']]);
  });

  await check('ported stats and citation check reproduce the 8 imported dry-run stories', async () => {
    const rows = await q(
      `select s.id, v.narrative, v.stats, v.written, v.platform_takes, v.feed_edit, v.checks, array(select post_id from story_posts sp where sp.story_id = s.id) as post_ids
         from stories s join story_versions v on v.story_id = s.id and v.version = 1 where s.id = any($1::uuid[])`,
      [[...beforeIds]],
    );
    assert.ok(rows.length >= 8, `${rows.length} imported stories`);
    process.env.STORY_HEAT_HALF_LIFE_HOURS = '72'; // the dry run's setting
    try {
      for (const r of rows) {
        const world = await loadWorld(r.post_ids);
        const now = Date.parse(r.stats.last_post_at) + r.stats.age_hours * 3.6e6;
        const stats = computeStats({ storyId: r.id, narrative: r.narrative, world, postIds: r.post_ids, now });
        for (const key of ['creators', 'sources', 'platforms', 'comments_counted', 'heat', 'turning_points', 'angle_reactions', 'beat_order']) {
          assert.deepStrictEqual(stats[key], r.stats[key], `${r.narrative.main_character.name}: ${key}`);
        }
        const checks = verifyStory({ world, postIds: r.post_ids, narrative: r.narrative, stats: r.stats, written: r.written, lens: r.platform_takes, edit: r.feed_edit });
        assert.equal(checks.pass, r.checks.pass, `${r.narrative.main_character.name}: pass`);
      }
    } finally {
      delete process.env.STORY_HEAT_HALF_LIFE_HOURS;
    }
  });

  await check('fake AI answers a batch from the dry-run fixtures by post_id and logs a $0 cost row', async () => {
    const items = [{ post_id: 'rd_1wcbid7' }, { post_id: 'yt_U-rsvXds9ck' }];
    const out = await generateJson({ model: 'gemini-3.5-flash-lite', system: '', user: `The input is a JSON array of 2 items. Apply the instructions.\n\nInput:\n${JSON.stringify(items)}`, step: 'cards', label: 'test-batch', runId });
    assert.deepEqual(out.map((c) => c.post_id), ['rd_1wcbid7', 'yt_U-rsvXds9ck']);
    const [cost] = await q(`select usd::float, units from cost_events where run_id = $1 and units ->> 'label' = 'test-batch'`, [runId]);
    assert.equal(cost.usd, 0);
    assert.equal(cost.units.step, 'cards');
  });

  // ── The shared feed, three runs ───────────────────────────────────────────
  // The AI editor and merge stay off here, so test stories in the real shared feed are never published
  // and the imported Anthropic story is never merged. They are checked further down in a throwaway feed.
  await setSettings({ auto_publish: false, auto_merge: false, merge_min_confidence: 0.7 });
  // Posts the dry run left out of every story: a threat-report story (two sources) and a second
  // Anthropic story whose dates overlap it and the imported Anthropic story.
  const A = 'tt_7684466722178469150';
  const B = 'x_2098930251656986889';
  const C = 'tt_7684805549627591967';
  const D = 'tt_7684307899639745805';
  const E = 'li_7504765849485082624';
  const free = await q(
    `select p.id from posts p join story_cards sc on sc.post_id = p.id and sc.newsworthy
      where p.id = any($1::text[]) and not exists (select 1 from story_posts sp join stories s on s.id = sp.story_id where sp.post_id = p.id and s.feed_id = $2)`,
    [[A, B, C, D, E], feedId],
  );
  assert.equal(free.length, 5, 'the five test posts must be newsworthy and in no shared-feed story');
  const [{ max: lastPost }] = await q(`select max(p.published_at) from posts p join story_cards sc on sc.post_id = p.id`);
  const now = new Date(lastPost).getTime() + 3.6e6;
  const groupingLabel = `feed-${feedId}`;

  writeFixture('grouping', groupingLabel, {
    stories: [
      { story_id: 't1', existing_story_id: null, working_title: 'Anthropic threat report', post_ids: [A, B], why: 'test', confidence: 0.8 },
      { story_id: 't2', existing_story_id: null, working_title: 'Anthropic blocks research help', post_ids: [D, E], why: 'test', confidence: 0.6 },
      { story_id: 't3', existing_story_id: null, working_title: 'Already in a story', post_ids: ['rd_1wcbid7'], why: 'test', confidence: 0.9 },
    ],
    unassigned: [C],
    uncertain: [],
  });
  await storyFixtures('t1', [A, B], { tooLong: true });
  await storyFixtures('t2', [D, E], { mainCharacter: 'Anthropic' });

  let first = [];
  let t1;
  let t2;
  await check('first run makes two new stories from new posts and ignores posts already in a story', async () => {
    first = await buildStories({ runId, feedId, log: quiet, now });
    assert.equal(first.filter((r) => r.error).length, 0, JSON.stringify(first.filter((r) => r.error)));
    assert.equal(first.length, 2);
    assert.ok(first.every((r) => r.isNew && r.version === 1));
    const rows = await q(`select sp.story_id::text, array_agg(sp.post_id order by sp.post_id) as posts from story_posts sp where sp.story_id = any($1::uuid[]) group by 1`, [first.map((r) => r.storyId)]);
    t1 = rows.find((r) => r.posts.includes(A))?.story_id;
    t2 = rows.find((r) => r.posts.includes(D))?.story_id;
    assert.deepEqual(rows.find((r) => r.story_id === t1).posts, [A, B].sort());
    assert.deepEqual(rows.find((r) => r.story_id === t2).posts, [D, E].sort());
    assert.equal((await q(`select count(*)::int as n from story_posts where post_id = 'rd_1wcbid7'`))[0].n, 1);
  });

  await check('versions carry every field the story page reads, checks ran, and too-long steps were re-run once', async () => {
    const [v] = await q(`select * from story_versions where story_id = $1 and version = 1`, [t1]);
    assert.equal(typeof v.feed_edit.headline, 'string');
    assert.equal(typeof v.written.headline, 'string');
    assert.equal(typeof v.narrative.main_character.name, 'string');
    for (const key of ['creators', 'sources', 'platforms', 'beat_times', 'beat_order', 'turning_points', 'angle_reactions']) assert.ok(key in v.stats, `stats.${key}`);
    assert.ok(v.written.narrative.every((s) => typeof s.sentence === 'string'));
    assert.ok(Array.isArray(v.feed_edit.platform_strip) && v.feed_edit.platform_strip.length === 2);
    assert.ok(Array.isArray(v.platform_takes.platforms));
    assert.ok(Array.isArray(v.checks.errors) && Array.isArray(v.checks.warnings) && typeof v.checks.pass === 'boolean');
    assert.equal(v.passed, v.checks.pass);
    assert.equal(v.passed, true, v.checks.errors.join('; '));
    assert.deepEqual(v.checks.retried, ['writer', 'edit']);
    assert.equal(v.written.narrative.length, 3);
    assert.ok(v.feed_edit.headline.split(/\s+/).length <= 12);
    assert.equal(v.models.prompt_version, PROMPT_VERSION);
    assert.equal(v.stats.sources, 2);
  });

  await check('new shared-feed stories stay unpublished, with a heat number, an allowed status and the main entity', async () => {
    const rows = await q(`select s.published_at, s.heat, s.status::text, e.name from stories s left join entities e on e.id = s.main_entity_id where s.id = any($1::uuid[])`, [[t1, t2]]);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.published_at, null);
      assert.ok(Number.isInteger(r.heat));
      assert.ok(STATUSES.includes(r.status), r.status);
      assert.equal(r.name, 'Anthropic');
    }
  });

  await check('split check flags the overlapping Anthropic stories for review', async () => {
    const pairs = await q(`select story_a::text, story_b::text from merge_candidates where story_a = any($1::uuid[]) or story_b = any($1::uuid[])`, [[t1, t2]]);
    const has = (x, y) => pairs.some((p) => (p.story_a === x && p.story_b === y) || (p.story_a === y && p.story_b === x));
    assert.ok(has(t1, t2), 'the two test stories');
    assert.ok(pairs.every((p) => p.story_a < p.story_b));
    const [anthropic] = before.length ? await q(`select s.id::text from stories s join entities e on e.id = s.main_entity_id where s.id = any($1::uuid[]) and e.name = 'Anthropic'`, [[...beforeIds]]) : [];
    if (anthropic) assert.ok(has(t2, anthropic.id), 'the new story and the imported Anthropic story');
  });

  await check('published stories that were already there keep published_at and gain no versions or posts', async () => {
    const rows = await q(
      `select s.id::text, s.published_at, (select count(*)::int from story_versions v where v.story_id = s.id) as versions, (select count(*)::int from story_posts sp where sp.story_id = s.id) as posts
         from stories s where s.id = any($1::uuid[])`,
      [[...beforeIds]],
    );
    for (const r of rows) {
      const old = before.find((b) => b.id === r.id);
      assert.equal(String(r.published_at), String(old.published_at));
      assert.equal(r.versions, 1);
    }
  });

  await check('a second run with nothing new creates no stories and no versions', async () => {
    const again = await buildStories({ runId, feedId, log: quiet, now });
    assert.deepEqual(again, []);
    const [counts] = await q(
      `select (select count(*)::int from stories where feed_id = $1) as stories, (select max(version)::int from story_versions where story_id = any($2::uuid[])) as version`,
      [feedId, [t1, t2]],
    );
    assert.equal(counts.stories, beforeIds.size + 2);
    assert.equal(counts.version, 1);
  });

  await check('a new post attaches to its existing story: same id, version 2, nothing duplicated', async () => {
    writeFixture('grouping', groupingLabel, {
      stories: [{ story_id: 'x1', existing_story_id: t1, working_title: 'Anthropic threat report', post_ids: [C], why: 'same report', confidence: 0.9 }],
      unassigned: [],
      uncertain: [],
    });
    await storyFixtures(t1, [A, B, C]);
    const third = await buildStories({ runId, feedId, log: quiet, now });
    assert.equal(third.length, 1);
    assert.deepEqual({ ...third[0], status: undefined }, { storyId: t1, isNew: false, version: 2, passed: true, status: undefined });
    const posts = await q(`select post_id from story_posts where story_id = $1 order by post_id`, [t1]);
    assert.deepEqual(posts.map((p) => p.post_id), [A, B, C].sort());
    const [{ n }] = await q(`select count(*)::int as n from stories where feed_id = $1`, [feedId]);
    assert.equal(n, beforeIds.size + 2);
    const [{ published_at: publishedAt }] = await q(`select published_at from stories where id = $1`, [t1]);
    assert.equal(publishedAt, null);
  });

  await check('runDaily (collection skipped) rebuilds nothing unchanged and refreshes heat for today', async () => {
    const out = await runDaily({ runId, log: quiet });
    assert.equal(out.collected.skipped, true);
    assert.ok(Array.isArray(out.stories) && out.stories.every((s) => !s.isNew));
    const rows = await q(`select status::text, heat from stories where feed_id = $1`, [feedId]);
    assert.ok(rows.every((r) => STATUSES.includes(r.status) && Number.isInteger(r.heat)));
  });

  // ── A report into a workspace's own feed ─────────────────────────────────
  await check('runReport builds one published story in the workspace feed and marks the report ready', async () => {
    workspaceId = (await q(`insert into workspaces (name) values ('Pipeline test ${Date.now()}') returning id::text`))[0].id;
    const wsFeed = await workspaceFeedId(workspaceId);
    const [report] = await q(
      `insert into reports (workspace_id, query, platforms, date_from, date_to, quoted_credits, status)
       values ($1, 'Anthropic threat report', '{tiktok,x}', '2026-09-10', '2026-09-13', 300, 'in_progress') returning id::text`,
      [workspaceId],
    );
    for (const id of [A, B]) await q(`insert into post_queries (post_id, query, workspace_id) values ($1, 'Anthropic threat report', $2)`, [id, workspaceId]);
    await storyFixtures(`report-${wsFeed}`, [A, B]);
    const { storyId } = await runReport({ reportId: report.id, runId, log: quiet });
    const [row] = await q(
      `select r.status, r.story_id::text, s.published_at, f.workspace_id::text, (select count(*)::int from story_posts sp where sp.story_id = s.id) as posts
         from reports r join stories s on s.id = r.story_id join feeds f on f.id = s.feed_id where r.id = $1`,
      [report.id],
    );
    assert.equal(row.status, 'ready');
    assert.equal(row.story_id, storyId);
    assert.equal(row.workspace_id, workspaceId);
    assert.notEqual(row.published_at, null);
    assert.equal(row.posts, 2);
  });

  // ── The AI editor and same-story merge, in a throwaway feed ───────────────
  // A workspace with no members, its feed built with treatAsShared: the shared feed's rules apply, but
  // nothing here shows to any user.
  editorWorkspaceId = (await q(`insert into workspaces (name) values ('Pipeline editor test ${Date.now()}') returning id::text`))[0].id;
  const edFeed = await workspaceFeedId(editorWorkspaceId);
  const edBuild = () => buildStories({ runId, feedId: edFeed, log: quiet, now, treatAsShared: true });
  const DEEPSEEK = ['rd_1wcbid7', 'yt_U-rsvXds9ck'];
  const CHATGPT = ['ig_DdCDFZdRJtG', 'yt_1OmRxol201U'];
  const story = async (id) => (await q(`select id::text, status::text, published_at, merged_into::text, review_source, review_note, reviewed_at, reviewed_by from stories where id = $1`, [id]))[0];
  const latest = async (id) => (await q(`select version, passed, editor, models, stats from story_versions where story_id = $1 order by version desc limit 1`, [id]))[0];
  const postsOf = async (id) => (await q(`select post_id from story_posts where story_id = $1 order by post_id`, [id])).map((r) => r.post_id);

  // Run 1: auto_publish on, auto_merge off. Four new stories; the editor holds one and rejects one.
  await setSettings({ auto_publish: true, auto_merge: false, merge_min_confidence: 0.7 });
  writeFixture('grouping', `feed-${edFeed}`, {
    stories: [
      { story_id: 'ed-pub', existing_story_id: null, working_title: 'Anthropic threat report', post_ids: [A, B], why: 'test', confidence: 0.8 },
      { story_id: 'ed-m2', existing_story_id: null, working_title: 'Anthropic blocks research help', post_ids: [D, E, C], why: 'test', confidence: 0.8 },
      { story_id: 'ed-hold', existing_story_id: null, working_title: 'DeepSeek release', post_ids: DEEPSEEK, why: 'test', confidence: 0.8 },
      { story_id: 'ed-rej', existing_story_id: null, working_title: 'ChatGPT connectors', post_ids: CHATGPT, why: 'test', confidence: 0.8 },
    ],
    unassigned: [],
    uncertain: [],
  });
  await storyFixtures('ed-pub', [A, B], { mainCharacter: 'Anthropic' });
  await storyFixtures('ed-m2', [D, E, C], { mainCharacter: 'Anthropic' });
  await storyFixtures('ed-hold', DEEPSEEK, { mainCharacter: 'DeepSeek' });
  await storyFixtures('ed-rej', CHATGPT);
  writeFixture('editor', 'ed-hold', { decision: 'hold', reason: 'Test: a person should look first.', confidence: 0.6 });
  writeFixture('editor', 'ed-rej', { decision: 'reject', reason: 'Test: routine promotion.', confidence: 0.85 });

  let pub;
  let m2;
  let held;
  let rejected;
  await check('AI editor publishes a new shared-feed story that passes its checks, marked as the AI with its verdict on the version', async () => {
    const out = await edBuild();
    assert.equal(out.filter((r) => r.error).length, 0, JSON.stringify(out.filter((r) => r.error)));
    assert.equal(out.length, 4);
    assert.ok(out.every((r) => r.isNew && r.passed), JSON.stringify(out));
    const owner = async (postId) => (await q(`select sp.story_id::text from story_posts sp join stories s on s.id = sp.story_id where s.feed_id = $1 and sp.post_id = $2`, [edFeed, postId]))[0]?.story_id;
    [pub, m2, held, rejected] = [await owner(A), await owner(D), await owner(DEEPSEEK[0]), await owner(CHATGPT[0])];
    const s = await story(pub);
    assert.notEqual(s.published_at, null);
    assert.equal(s.review_source, 'ai');
    assert.match(s.review_note, /^AI: /);
    assert.notEqual(s.reviewed_at, null);
    assert.equal(s.reviewed_by, null);
    const v = await latest(pub);
    assert.equal(v.editor.decision, 'publish');
    assert.equal(v.editor.confidence, 0.9);
    assert.equal(typeof v.models.editor, 'string');
    const [{ n }] = await q(`select count(*)::int as n from cost_events where run_id = $1 and units ->> 'step' = 'editor' and usd = 0`, [runId]);
    assert.equal(n, 4, 'one $0 cost row per editor call');
  });

  await check('an editor verdict of hold leaves the story unpublished, marked as the AI', async () => {
    const s = await story(held);
    assert.equal(s.published_at, null);
    assert.notEqual(s.status, 'rejected');
    assert.equal(s.review_source, 'ai');
    assert.equal(s.review_note, 'AI: Test: a person should look first.');
    assert.equal((await latest(held)).editor.decision, 'hold');
  });

  await check('an editor verdict of reject marks the story rejected and unpublished', async () => {
    const s = await story(rejected);
    assert.equal(s.status, 'rejected');
    assert.equal(s.published_at, null);
    assert.equal(s.review_source, 'ai');
    assert.equal((await latest(rejected)).editor.decision, 'reject');
  });

  const [pairA, pairB] = [pub, m2].sort();
  const candidate = async () => (await q(`select resolved_at, decision from merge_candidates where story_a = $1 and story_b = $2`, [pairA, pairB]))[0];
  await check('with auto_merge off, two overlapping stories with the same main entity are only flagged', async () => {
    const c = await candidate();
    assert.ok(c, 'the pair is in merge_candidates');
    assert.equal(c.resolved_at, null);
    assert.equal(c.decision, null);
    assert.deepEqual([(await story(pub)).status === 'merged', (await story(m2)).status === 'merged'], [false, false]);
    assert.equal((await postsOf(pub)).length, 2);
    assert.equal((await postsOf(m2)).length, 3);
  });

  // Run 2: auto_merge on. A person has taken over the held story and a new post attaches to it; the
  // same-story judge is forced to a low-confidence answer.
  await setSettings({ auto_merge: true });
  await q(`update stories set review_source = 'human', review_note = 'Test: a person keeps this unpublished', reviewed_at = now() where id = $1`, [held]);
  writeFixture('grouping', `feed-${edFeed}`, {
    stories: [{ story_id: 'x1', existing_story_id: held, working_title: 'DeepSeek release', post_ids: ['rd_1wbfrut'], why: 'same release', confidence: 0.9 }],
    unassigned: [],
    uncertain: [],
  });
  await storyFixtures(held, [...DEEPSEEK, 'rd_1wbfrut'], { mainCharacter: 'DeepSeek' });
  writeFixture('same_story', `${pairA}_${pairB}`, { same_story: true, keep: 'a', reason: 'Test: maybe the same.', confidence: 0.4 });
  const pubBefore = await story(pub);
  const m2Before = await story(m2);

  let second = [];
  await check('a story a person reviewed is never changed by the AI editor', async () => {
    second = await edBuild();
    assert.equal(second.filter((r) => r.error).length, 0, JSON.stringify(second.filter((r) => r.error)));
    const rebuilt = second.find((r) => r.storyId === held);
    assert.ok(rebuilt && rebuilt.version === 2 && rebuilt.passed, JSON.stringify(second));
    const s = await story(held);
    assert.equal(s.published_at, null);
    assert.notEqual(s.status, 'rejected');
    assert.equal(s.review_source, 'human');
    assert.equal(s.review_note, 'Test: a person keeps this unpublished');
    assert.equal((await latest(held)).editor, null);
    const [{ n }] = await q(`select count(*)::int as n from cost_events where run_id = $1 and units ->> 'step' = 'editor' and units ->> 'label' = $2`, [runId, held]);
    assert.equal(n, 0, 'the editor was not asked');
  });

  await check('a low-confidence same-story verdict leaves the pair unresolved with the verdict, and merges nothing', async () => {
    const c = await candidate();
    assert.equal(c.resolved_at, null);
    assert.equal(c.decision.same_story, true);
    assert.equal(c.decision.confidence, 0.4);
    for (const [id, was, posts] of [[pub, pubBefore, 2], [m2, m2Before, 3]]) {
      const s = await story(id);
      assert.notEqual(s.status, 'merged');
      assert.equal(s.merged_into, null);
      assert.equal(String(s.published_at), String(was.published_at));
      assert.equal((await postsOf(id)).length, posts);
    }
  });

  // Run 3: the pair is asked again as if new, with the fake judge's default answer (same main entity,
  // 0.8, keep the story with more posts). Fixtures for the rebuild are written under both ids.
  await q(`update merge_candidates set decision = null where story_a = $1 and story_b = $2`, [pairA, pairB]);
  removeFixture('same_story', `${pairA}_${pairB}`);
  writeFixture('grouping', `feed-${edFeed}`, { stories: [], unassigned: [], uncertain: [] });
  await storyFixtures(pub, [A, B, C, D, E], { mainCharacter: 'Anthropic' });
  await storyFixtures(m2, [A, B, C, D, E], { mainCharacter: 'Anthropic' });

  await check('AI merges two overlapping same-entity stories: posts moved, the other marked merged, pair resolved, kept story rebuilt', async () => {
    const third = await edBuild();
    assert.equal(third.filter((r) => r.error).length, 0, JSON.stringify(third.filter((r) => r.error)));
    const rebuilt = third.find((r) => r.storyId === m2);
    assert.ok(rebuilt && rebuilt.merged && rebuilt.version === 2 && rebuilt.passed, JSON.stringify(third));
    const absorbed = await story(pub);
    assert.equal(absorbed.status, 'merged');
    assert.equal(absorbed.merged_into, m2);
    assert.equal(absorbed.published_at, null);
    assert.equal(absorbed.review_source, 'ai');
    assert.ok(absorbed.review_note.startsWith(`AI merged into ${m2}: `), absorbed.review_note);
    assert.deepEqual(await postsOf(pub), []);
    assert.deepEqual(await postsOf(m2), [A, B, C, D, E].sort());
    const c = await candidate();
    assert.notEqual(c.resolved_at, null);
    assert.equal(c.decision.same_story, true);
    assert.equal(c.decision.kept_id, m2);
    const kept = await story(m2);
    assert.equal(kept.status === 'merged', false);
    assert.equal(String(kept.published_at), String(m2Before.published_at));
    const v = await latest(m2);
    assert.equal(v.version, 2);
    assert.equal(v.stats.posts, 5);
    assert.equal(v.editor, null, 'an already published story is not judged again');
  });
} catch (err) {
  results.push(['FAIL', `setup: ${err.message}`]);
} finally {
  // Settings first, so the live pipeline has its own settings back even if a later cleanup step fails.
  for (const key of SETTING_KEYS) {
    const old = settingsBefore.find((s) => s.key === key);
    if (!old) await q('delete from app_settings where key = $1', [key]);
    else {
      await q(
        `insert into app_settings (key, value, updated_at, updated_by) values ($1, $2::jsonb, $3, $4)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [key, JSON.stringify(old.value), old.updated_at, old.updated_by],
      );
    }
  }
  // Everything this test created goes; stories that were there before get their heat and status back.
  const created = (await q(`select id::text from stories where feed_id = $1`, [feedId])).map((r) => r.id).filter((id) => !beforeIds.has(id));
  if (created.length) await q(`delete from stories where id = any($1::uuid[])`, [created]);
  await q(`delete from merge_candidates where created_at >= $1`, [testStart]);
  for (const s of before) {
    await q(`update stories set heat = $2, status = $3::story_status, first_post_at = $4, last_post_at = $5 where id = $1`, [s.id, s.heat, s.status, s.first_post_at, s.last_post_at]);
  }
  const aliasesNow = await q('select alias, entity_id::text from entity_aliases');
  const old = new Map(aliasSnapshot.map((a) => [a.alias, a.entity_id]));
  for (const a of aliasesNow) {
    if (!old.has(a.alias)) await q('delete from entity_aliases where alias = $1', [a.alias]);
    else if (old.get(a.alias) !== a.entity_id) await q('update entity_aliases set entity_id = $2 where alias = $1', [a.alias, old.get(a.alias)]);
  }
  if (workspaceId) await q('delete from workspaces where id = $1', [workspaceId]);
  if (editorWorkspaceId) {
    await q(`update stories set merged_into = null where feed_id in (select id from feeds where workspace_id = $1)`, [editorWorkspaceId]);
    await q('delete from workspaces where id = $1', [editorWorkspaceId]);
  }
  await q('delete from cost_events where run_id = $1', [runId]);
  await q('delete from runs where id = $1', [runId]);
  rmSync(overlay, { recursive: true, force: true });
  const [left] = await q(`select count(*)::int as n from stories where feed_id = $1`, [feedId]);
  if (left.n !== beforeIds.size) results.push(['FAIL', `cleanup: ${left.n} shared-feed stories left, expected ${beforeIds.size}`]);
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
