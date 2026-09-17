// End-to-end check of watchlists against the real database, in fake AI mode (no spend): the first
// watchlist and its tags, following into a chosen watchlist, tags, taking follows out, deleting, and story
// building per watchlist (only its follows, only its tags, each tag's minimum, noise left out, grouping
// again after a tag changes) with the Stories feed filters. Creates throwaway accounts, prints PASS/FAIL,
// then deletes everything it created and puts back what it changed.
// Usage: node scripts/test-watchlists.js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const overlay = join(tmpdir(), `content-story-watchlists-test-${Date.now()}`);
process.env.PIPELINE_PROVIDER = 'fake';
process.env.PIPELINE_SKIP_COLLECT = '1';
process.env.PIPELINE_FIXTURE_OVERLAY = overlay;

const { pool } = await import('../lib/db.js');
const { ensureAccount } = await import('../lib/accounts.js');
const { getFeed, getFeedCounts } = await import('../lib/stories.js');
const { defaultTemplates } = await import('../lib/tags.js');
const { WatchlistError, completeOnboarding, followCreator, listFollowing } = await import('../lib/watchlist.js');
const W = await import('../lib/watchlists.js');
const { buildStories, loadWorld } = await import('../pipeline/storybuild.js');
const { entityRanking } = await import('../pipeline/stats.js');
const { watchlistFeedId } = await import('../pipeline/index.js');

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
const writeFixture = (step, label, value) => {
  mkdirSync(join(overlay, step), { recursive: true });
  writeFileSync(join(overlay, step, `${label}.json`), JSON.stringify(value, null, 2));
};

// Fixtures for the four story steps of a one-post story, built from the real post so every cited ID exists.
async function storyFixtures(label, postId) {
  const world = await loadWorld([postId]);
  const main = entityRanking(world, [postId])[0].name;
  const claim = world.cardByPost.get(postId)?.claims[0];
  const evidence = [{ source_id: claim?.claim_id ?? postId, post_id: postId, relation: 'supports', note: 'test evidence' }];
  const platform = world.postById.get(postId).platform;
  writeFixture('builder', label, {
    story_id: label,
    main_character: { name: main, reason: 'Top-ranked entity in the test post' },
    supporting_cast: [],
    beats: [{ what: 'A creator posted about it', source_post_ids: [postId], source_comment_ids: [], turning_point_candidate: false, reason: '' }],
    angles: [
      { title: 'It matters', thesis: 'People say it matters.', kind: 'opinion', evidence },
      { title: 'It is overblown', thesis: 'People say it is overblown.', kind: 'opinion', evidence },
    ],
    reactions: [],
    open_questions: [],
  });
  writeFixture('writer', label, {
    story_id: label,
    headline: `${main} gets a creator's attention`,
    narrative: [0, 1, 2].map(() => ({ sentence: `${main} came up in this post [${postId}].`, cites: [postId] })),
    beat_lines: ['A creator posted about it'],
    angle_blurbs: [],
    quotes: [],
  });
  writeFixture('lens', label, {
    story_id: label,
    contrast: [{ sentence: 'One platform covers it.', cites: [postId] }],
    platforms: [{ platform, take: `${platform} talks about ${main}`, creators_say: { text: 'A creator posted about it.', cites: [postId] }, audience_says: null, quote: null, distinct: '' }],
  });
  writeFixture('edit', label, { story_id: label, headline: `${main} gets a creator's attention`, dek: 'One creator covers it so far.', platform_strip: [{ platform, gist: 'covers the story' }] });
}

const suffix = Date.now();
const accounts = [];
const signIn = async (tag) => {
  const session = await ensureAccount(`test:${suffix}:${tag}`, async () => ({ email: `watchlists-test-${suffix}-${tag}@content-story.dev`, name: 'Watchlist Tester' }));
  accounts.push(session);
  return session;
};
const aliasSnapshot = await q('select alias, entity_id::text from entity_aliases');
const [{ id: runId }] = await q(`insert into runs (kind) values ('test') returning id`);
let noisePost = null;

// Dry-run posts whose creators the story-building checks follow.
const A = 'tt_7684466722178469150'; // Nate B. Jones, lift 2.7
const C = 'tt_7684805549627591967'; // Nate B. Jones
const D = 'tt_7684307899639745805'; // Matthew Berman, lift 0.9
const E = 'li_7504765849485082624'; // Ruben Hassid
const creatorOf = Object.fromEntries(
  (await q(`select p.id, h.creator_id::text from posts p join creator_handles h on h.id = p.handle_id where p.id = any($1::text[])`, [[A, C, D, E]])).map((r) => [r.id, r.creator_id]),
);

try {
  const agency = await signIn('agency');
  const ws = agency.workspace.id;
  let first;
  let second;

  await check('onboarding makes the first watchlist with the tags for its use case and every pick in it', async () => {
    await completeOnboarding(ws, { useCase: 'agency', creatorIds: [creatorOf[A]], communities: [], keywords: ['boAt'] });
    const lists = await W.listWatchlists(ws);
    assert.equal(lists.length, 1);
    first = lists[0];
    assert.equal(first.name, W.FIRST_WATCHLIST_NAME);
    assert.deepEqual(first.tags.map((t) => t.name), defaultTemplates('agency').map((t) => t.name));
    assert.equal(first.follows, 2);
  });

  await check('an older workspace gets its first watchlist on first use, with its follows and its following feed', async () => {
    const old = await signIn('old');
    await q(`insert into tracking_targets (workspace_id, kind, creator_id, platforms) values ($1, 'creator', $2, '{tiktok}')`, [old.workspace.id, creatorOf[D]]);
    const [feed] = await q(`insert into feeds (workspace_id, kind, name) values ($1, 'following', 'Old stories') returning id`, [old.workspace.id]);
    const firstId = await W.ensureWatchlists(old.workspace.id);
    const [{ n }] = await q('select count(*)::int as n from watchlist_targets where watchlist_id = $1', [firstId]);
    assert.equal(n, 1);
    const [linked] = await q('select watchlist_id::text from feeds where id = $1', [feed.id]);
    assert.equal(linked.watchlist_id, firstId);
    assert.equal(await W.ensureWatchlists(old.workspace.id), firstId, 'a second call makes nothing new');
    assert.equal((await W.listWatchlists(old.workspace.id)).length, 1);
  });

  await check('a follow goes into the chosen watchlist; following someone again into a second one takes no slot', async () => {
    second = await W.createWatchlist(ws, { name: 'Client B', userId: agency.user.id });
    await assert.rejects(() => W.createWatchlist(ws, { name: 'client b' }), WatchlistError);
    await followCreator(ws, creatorOf[E], { watchlistIds: [second.id] });
    const [{ n: before }] = await q('select count(*)::int as n from tracking_targets where workspace_id = $1 and active', [ws]);
    assert.equal(await followCreator(ws, creatorOf[A], { watchlistIds: [second.id] }), true);
    const [{ n: after }] = await q('select count(*)::int as n from tracking_targets where workspace_id = $1 and active', [ws]);
    assert.equal(after, before);
    const byName = Object.fromEntries((await listFollowing(ws)).map((t) => [t.creator_id ?? t.name, t.watchlist_ids.slice().sort()]));
    assert.deepEqual(byName[creatorOf[E]], [second.id]);
    assert.deepEqual(byName[creatorOf[A]], [first.id, second.id].sort());
    assert.equal(await followCreator(ws, creatorOf[A], { watchlistIds: [second.id] }), false, 'already in it');
    await followCreator(ws, creatorOf[D], { watchlistIds: ['00000000-0000-0000-0000-000000000000'] });
    assert.deepEqual(byName[creatorOf[D]] ?? (await listFollowing(ws)).find((t) => t.creator_id === creatorOf[D]).watchlist_ids, [first.id], 'an unknown watchlist means the first');
  });

  await check('tags: ready-made and written from scratch, no duplicates, removed', async () => {
    const trends = await W.saveTag(ws, second.id, { template: 'trends' });
    assert.equal(trends.minSources, 2);
    const own = await W.saveTag(ws, second.id, { name: 'Competitor launches', rule: 'A competitor launches a product with a creator.', minSources: '1' });
    await assert.rejects(() => W.saveTag(ws, second.id, { name: 'competitor launches', rule: 'Something else that counts here.' }), WatchlistError);
    await assert.rejects(() => W.saveTag(ws, second.id, { name: 'Too short', rule: 'short' }), WatchlistError);
    const edited = await W.saveTag(ws, second.id, { id: own.id, name: 'Competitor launches', rule: 'A competitor of the client launches a product.', minSources: '2' });
    assert.equal(edited.minSources, 2);
    assert.equal(await W.removeTag(ws, second.id, trends.id), true);
    assert.equal(await W.removeTag((await signIn('other')).workspace.id, second.id, own.id), false, 'another workspace cannot remove it');
  });

  await check('taking a follow out of its last watchlist unfollows it; out of one of two keeps it', async () => {
    const targets = await listFollowing(ws);
    const a = targets.find((t) => t.creator_id === creatorOf[A]);
    const out = await W.setWatchlistTargets(ws, second.id, []);
    assert.deepEqual(out, { added: 0, removed: 2, unfollowed: 1 });
    const left = await listFollowing(ws);
    assert.ok(left.some((t) => t.id === a.id), 'still followed through the first watchlist');
    assert.ok(!left.some((t) => t.creator_id === creatorOf[E]), 'only in Client B, so unfollowed');
    const back = await W.setWatchlistTargets(ws, second.id, [a.id]);
    assert.deepEqual(back, { added: 1, removed: 0, unfollowed: 0 });
  });

  await check('deleting a watchlist archives its feed and unfollows who was only in it; the last one stays', async () => {
    const temp = await W.createWatchlist(ws, { name: 'Short campaign' });
    const feedId = await watchlistFeedId(temp.id);
    await followCreator(ws, creatorOf[E], { watchlistIds: [temp.id] });
    const { unfollowed } = await W.deleteWatchlist(ws, temp.id);
    assert.equal(unfollowed, 1);
    const [feed] = await q('select kind, watchlist_id from feeds where id = $1', [feedId]);
    assert.deepEqual(feed, { kind: 'archived', watchlist_id: null });
    const solo = await signIn('solo');
    await completeOnboarding(solo.workspace.id, { useCase: 'media', creatorIds: [], communities: [], keywords: [] });
    const [only] = await W.listWatchlists(solo.workspace.id);
    await assert.rejects(() => W.deleteWatchlist(solo.workspace.id, only.id), WatchlistError);
  });

  // ── Story building for one watchlist ────────────────────────────────────
  const builder = await signIn('builder');
  const bws = builder.workspace.id;
  await completeOnboarding(bws, { useCase: 'agency', creatorIds: [creatorOf[A], creatorOf[D]], communities: [], keywords: [] });
  const [wl] = await W.listWatchlists(bws);
  for (const t of wl.tags) await W.removeTag(bws, wl.id, t.id);
  const deals = await W.saveTag(bws, wl.id, { template: 'brand_deals' });
  const news = await W.saveTag(bws, wl.id, { template: 'news' });
  const feedId = await watchlistFeedId(wl.id);
  const [{ max: lastPost }] = await q(`select max(published_at) from posts where id = any($1::text[])`, [[A, C, D]]);
  const now = new Date(lastPost).getTime() + 3.6e6;
  const windowPosts = async () =>
    (
      await q(
        `select p.id, coalesce(sc.noise, false) as noise from posts p join story_cards sc on sc.post_id = p.id join creator_handles h on h.id = p.handle_id
          where h.creator_id = any($1::uuid[]) and p.published_at >= $2 and p.published_at <= $3`,
        [[creatorOf[A], creatorOf[D]], new Date(now - 7 * 86_400_000), new Date(now)],
      )
    );
  // One other post of theirs becomes noise for this test, and is put back afterwards.
  const candidates = (await windowPosts()).filter((p) => ![A, C, D].includes(p.id) && !p.noise);
  if (candidates.length) {
    noisePost = { id: candidates[0].id, noise: (await q('select noise from story_cards where post_id = $1', [candidates[0].id]))[0].noise };
    await q('update story_cards set noise = true where post_id = $1', [noisePost.id]);
  }
  writeFixture('grouping', `feed-${feedId}`, {
    stories: [
      { story_id: 'w1', existing_story_id: null, tag: 'Brand deals', working_title: 'Nate B. Jones covers a launch', post_ids: [A], why: 'test', confidence: 0.9 },
      { story_id: 'w2', existing_story_id: null, tag: 'News', working_title: 'Matthew Berman alone on the news', post_ids: [D], why: 'test', confidence: 0.8 },
      { story_id: 'w3', existing_story_id: null, tag: 'Giveaways', working_title: 'Not a tag of this watchlist', post_ids: [C], why: 'test', confidence: 0.8 },
    ],
    unassigned: [],
    uncertain: [],
  });
  await storyFixtures('w1', A);
  const lines = [];
  const log = (line) => lines.push(String(line));
  let storyId = null;

  await check('a watchlist groups only its follows’ posts that aren’t noise, makes stories for its tags only, and checks each tag’s minimum', async () => {
    const expected = (await windowPosts()).filter((p) => !p.noise).length;
    const built = await buildStories({ runId, feedId, log, now });
    assert.equal(built.filter((b) => b.error).length, 0, JSON.stringify(built.filter((b) => b.error)));
    assert.ok(lines.some((l) => l.includes(`grouping ${expected} posts`)), `expected "grouping ${expected} posts" in:\n${lines.join('\n')}`);
    assert.equal(built.length, 1);
    storyId = built[0].storyId;
    const [story] = await q('select tag, tag_id::text from stories where id = $1', [storyId]);
    assert.deepEqual(story, { tag: 'Brand deals', tag_id: deals.id });
    assert.ok(lines.some((l) => l.includes('"Matthew Berman alone on the news" left unassigned: News needs 2 sources')));
    assert.ok(lines.some((l) => l.includes(`"Not a tag of this watchlist" left unassigned: "Giveaways" is not one of the watchlist's tags`)));
    assert.equal(built[0].passed, true, 'the test story passes its checks');
  });

  await check('the next run skips grouping when nothing changed, and groups again after a tag changes', async () => {
    lines.length = 0;
    await buildStories({ runId, feedId, log, now });
    assert.ok(lines.some((l) => l.includes('nothing new since the last grouping')), lines.join('\n'));
    await W.saveTag(bws, wl.id, { id: news.id, name: 'News', rule: 'A specific launch or controversy in AI this week.', minSources: 2 });
    lines.length = 0;
    await buildStories({ runId, feedId, log, now });
    assert.ok(lines.some((l) => l.includes('grouping ')) && !lines.some((l) => l.includes('nothing new since')), lines.join('\n'));
  });

  await check('the Stories feed shows a watchlist’s stories with their tag, counts them, and filters by tag', async () => {
    const mine = await getFeed({ workspaceId: bws, watchlistId: wl.id });
    assert.deepEqual(mine.map((s) => [s.id, s.tag]), [[storyId, 'Brand deals']]);
    assert.equal((await getFeed({ workspaceId: bws, watchlistId: wl.id, tagId: news.id })).length, 0);
    assert.equal((await getFeed({ workspaceId: bws, watchlistId: wl.id, tagId: deals.id })).length, 1);
    const counts = await getFeedCounts(bws);
    assert.equal(counts.watchlists[wl.id], 1);
    assert.equal(counts.tags[deals.id], 1);
    assert.equal((await getFeed({ workspaceId: ws })).some((s) => s.id === storyId), false, 'never in another workspace');
    await W.setWatchlistTargets(bws, wl.id, []);
    assert.equal((await getFeed({ workspaceId: bws, watchlistId: wl.id })).length, 0, 'a watchlist following nobody shows no stories');
  });
} finally {
  if (noisePost) await q('update story_cards set noise = $2 where post_id = $1', [noisePost.id, noisePost.noise]);
  const aliasesNow = await q('select alias, entity_id::text from entity_aliases');
  const old = new Map(aliasSnapshot.map((a) => [a.alias, a.entity_id]));
  for (const a of aliasesNow) {
    if (!old.has(a.alias)) await q('delete from entity_aliases where alias = $1', [a.alias]);
    else if (old.get(a.alias) !== a.entity_id) await q('update entity_aliases set entity_id = $2 where alias = $1', [a.alias, old.get(a.alias)]);
  }
  for (const account of accounts) {
    await q('delete from workspaces where id = $1', [account.workspace.id]);
    await q('delete from users where id = $1', [account.user.id]);
  }
  await q('delete from cost_events where run_id = $1', [runId]);
  await q('delete from runs where id = $1', [runId]);
  rmSync(overlay, { recursive: true, force: true });
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
