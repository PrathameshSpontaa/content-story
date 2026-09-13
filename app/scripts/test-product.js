// End-to-end check of accounts, onboarding, following, story filters, saved stories and reports
// against the real database. Creates throwaway accounts, runs each flow, prints PASS/FAIL, then
// deletes them.
// Usage: node scripts/test-product.js
import assert from 'node:assert/strict';
import { ensureAccount, getPlanState } from '../lib/accounts.js';
import { getCatalog } from '../lib/catalog.js';
import { getBalance } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { TRIAL } from '../lib/pricing.js';
import { ReportError, cancelReport, listReports, requestReport, shiftDate, todayIST, updateReport } from '../lib/reports.js';
import { getFeed, getFeedCounts, getStoryContext, toggleSaved } from '../lib/stories.js';
import {
  WatchlistError,
  addByLink,
  addCreator,
  addTopic,
  completeOnboarding,
  detectPlatform,
  followCreator,
  listFollowing,
  listTargets,
  parseHandle,
  removeTarget,
  setTargetActive,
} from '../lib/watchlist.js';

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
const accounts = [];
const signIn = async (tag, name) => {
  const session = await ensureAccount(`test:${suffix}:${tag}`, async () => ({ email: `product-test-${suffix}-${tag}@content-story.dev`, name }));
  if (!accounts.some((a) => a.workspace.id === session.workspace.id)) accounts.push(session);
  return session;
};

try {
  let session;
  await check('first sign-in creates a user, an owned workspace and trial credits', async () => {
    const [a, b] = await Promise.all([signIn('a', 'Test Person'), signIn('a', 'Test Person')]);
    assert.equal(a.workspace.id, b.workspace.id);
    session = a;
    assert.equal(session.role, 'owner');
    assert.equal(session.workspace.onboardedAt, null);
    assert.equal((await getBalance(session.workspace.id)).balance, TRIAL.credits);
  });
  const ws = session.workspace.id;

  await check('signing in again reuses the account and grants nothing more', async () => {
    const again = await ensureAccount(`test:${suffix}:a`, async () => assert.fail('profile should not be loaded again'));
    assert.equal(again.workspace.id, ws);
    assert.equal((await getBalance(ws)).balance, TRIAL.credits);
  });

  await check('the catalog lists covered creators, subreddits and brands with their stories', async () => {
    const { creators, communities, topics } = await getCatalog(ws);
    assert.ok(creators.length >= 10);
    assert.ok(creators.every((c) => c.handles.length && c.target_id === null));
    assert.ok(creators.some((c) => c.story_ids.length > 0));
    assert.ok(communities.some((c) => c.name === 'r/OpenAI'));
    assert.ok(topics.some((t) => t.name === 'OpenAI' && t.story_ids.length > 0));
    assert.ok(!topics.some((t) => ['linkedin', 'youtube', 'x'].includes(t.name.toLowerCase())));
  });

  await check('onboarding saves picks up to the plan limits and marks the workspace set up', async () => {
    const fresh = await signIn('b', 'Second Person');
    const { creators, communities } = await getCatalog(fresh.workspace.id);
    const added = await completeOnboarding(fresh.workspace.id, {
      useCase: 'brand',
      creatorIds: creators.map((c) => c.id),
      communities: communities.map((c) => c.name),
      keywords: ['OpenAI', 'openai', 'Apple', 'Anthropic', 'Google'],
    });
    assert.equal(added.creators + added.communities, Math.min(TRIAL.maxSources, creators.length + communities.length));
    assert.equal(added.keywords, TRIAL.maxKeywords);
    const after = await ensureAccount(`test:${suffix}:b`, async () => assert.fail('already created'));
    assert.ok(after.workspace.onboardedAt);
    assert.equal(after.workspace.useCase, 'brand');
    const counts = await getFeedCounts(fresh.workspace.id);
    assert.ok(counts.for_you > 0 && counts.for_you <= counts.total);
    assert.equal((await listFollowing(fresh.workspace.id)).length, TRIAL.maxSources + TRIAL.maxKeywords);
  });

  await check('pasted profile links and handles become the stored handle form', async () => {
    assert.deepEqual(parseHandle('x', 'https://twitter.com/mreflow?lang=en'), { handle: '@mreflow', url: 'https://x.com/mreflow' });
    assert.equal(parseHandle('youtube', 'youtube.com/@mreflow/videos').handle, '@mreflow');
    assert.equal(parseHandle('instagram', '@mr.eflow').handle, '@mr.eflow');
    assert.equal(parseHandle('linkedin', 'https://www.linkedin.com/in/Matt-Wolfe-30841712/').handle, 'matt-wolfe-30841712');
    assert.throws(() => parseHandle('x', 'not a handle!'), WatchlistError);
    assert.equal(detectPlatform('https://www.instagram.com/mkbhd/'), 'instagram');
    assert.equal(detectPlatform('reddit.com/r/IndianGaming'), 'reddit');
    assert.equal(detectPlatform('@mkbhd'), null);
  });

  await check('adding a creator we already collect matches them by handle', async () => {
    const res = await addCreator(ws, { name: '', handles: { x: 'x.com/mreflow' } });
    assert.equal(res.matchedExisting, true);
    assert.equal(res.creatorName, 'Matt Wolfe');
    const [target] = await listTargets(ws);
    assert.ok(target.handles.length >= 3, 'fills in their other platforms');
    await assert.rejects(addCreator(ws, { handles: { youtube: '@mreflow' } }), /already follow/);
  });

  await check('following from the catalog, unfollowing, and following again', async () => {
    const berman = (await getCatalog(ws)).creators.find((c) => c.name === 'Matthew Berman');
    assert.equal(await followCreator(ws, berman.id), true);
    assert.equal(await followCreator(ws, berman.id), false);
    const followed = (await getCatalog(ws)).creators.find((c) => c.id === berman.id);
    assert.ok(followed.target_id);
    await removeTarget(ws, followed.target_id);
    assert.equal(await followCreator(ws, berman.id), true);
  });

  await check('a pasted link finds its platform; a bare handle needs one', async () => {
    await assert.rejects(addByLink(ws, { link: '@someone' }), /which platform/);
    const res = await addByLink(ws, { link: 'https://www.tiktok.com/@mrwhosetheboss' });
    assert.equal(res.kind, 'creator');
    assert.equal(res.matchedExisting, true);
    const sub = await addByLink(ws, { link: 'https://www.reddit.com/r/LocalLLaMA/' });
    assert.equal(sub.name, 'r/LocalLLaMA');
  });

  await check('stories involving who you follow show under For you', async () => {
    const all = await getFeed({ workspaceId: ws });
    const mine = await getFeed({ workspaceId: ws, scope: 'watchlist' });
    assert.ok(mine.length > 0 && mine.length <= all.length);
    assert.ok(mine.every((s) => s.tracked.length > 0));
    assert.ok(all.some((s) => s.creator_names.length > 0));
    const [wolfe] = (await listFollowing(ws)).filter((t) => t.name === 'Matt Wolfe');
    const onlyWolfe = await getFeed({ workspaceId: ws, followTargetId: wolfe.id });
    assert.ok(onlyWolfe.length > 0 && onlyWolfe.every((s) => s.tracked.includes('Matt Wolfe')));
  });

  await check('brands and topics are limited by the plan; unfollowing frees a slot', async () => {
    for (let i = 0; i < TRIAL.maxKeywords; i += 1) await addTopic(ws, { kind: 'keyword', query: `Keyword ${i}`, platforms: ['x', 'youtube'] });
    await assert.rejects(addTopic(ws, { kind: 'keyword', query: 'One too many' }), new RegExp(`includes ${TRIAL.maxKeywords}`));
    const keyword = (await listTargets(ws)).find((t) => t.kind === 'keyword');
    assert.deepEqual(keyword.platforms, ['x', 'youtube']);
    await setTargetActive(ws, keyword.id, false);
    await addTopic(ws, { kind: 'keyword', query: 'Gemini' });
    await assert.rejects(setTargetActive(ws, keyword.id, true), WatchlistError);
    await removeTarget(ws, keyword.id);
  });

  await check('search and platform filters narrow the stories', async () => {
    const all = await getFeed({ workspaceId: ws });
    const story = all[0];
    const bySearch = await getFeed({ workspaceId: ws, q: story.main_character });
    assert.ok(bySearch.some((s) => s.id === story.id));
    assert.equal((await getFeed({ workspaceId: ws, q: 'zzqx%_no-such-thing' })).length, 0);
    const reddit = await getFeed({ workspaceId: ws, platform: 'reddit' });
    assert.ok(reddit.length <= all.length);
  });

  await check('saving a story toggles it in and out of Saved', async () => {
    const [story] = await getFeed({ workspaceId: ws });
    assert.equal(await toggleSaved(ws, session.user.id, story.id), true);
    assert.equal((await getStoryContext(story.id, ws)).saved, true);
    assert.equal((await getFeedCounts(ws)).saved, 1);
    assert.equal(await toggleSaved(ws, session.user.id, story.id), false);
  });

  const today = todayIST();
  let reportId;
  await check('a report request holds its quote', async () => {
    const res = await requestReport({ workspaceId: ws, userId: session.user.id }, { query: 'GPT-6 Astra launch', platforms: ['x', 'youtube', 'reddit', 'linkedin'], dateFrom: shiftDate(today, -4), dateTo: today });
    reportId = res.reportId;
    assert.equal(res.quoted, 300 + 80 + 100);
    assert.equal((await getBalance(ws)).held, 480);
  });

  await check('report requests are validated before anything is held', async () => {
    const who = { workspaceId: ws, userId: session.user.id };
    await assert.rejects(requestReport(who, { query: 'x', platforms: ['x'], dateFrom: today, dateTo: today }), ReportError);
    await assert.rejects(requestReport(who, { query: 'Long one', platforms: ['x'], dateFrom: shiftDate(today, -9), dateTo: today }), /up to 7 days/);
    await assert.rejects(requestReport(who, { query: 'Too dear', platforms: ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'], dateFrom: shiftDate(today, -6), dateTo: today }), /available/);
    assert.equal((await getBalance(ws)).held, 480);
  });

  await check('marking a report ready charges what it used, never more than the quote', async () => {
    const [story] = await getFeed();
    await assert.rejects(updateReport(reportId, { status: 'ready' }), /Link the finished story/);
    await updateReport(reportId, { status: 'ready', storyId: story.id, usedCredits: '350', note: 'Done' });
    const [report] = await listReports(ws);
    assert.equal(report.status, 'ready');
    assert.equal(report.charged, 350);
    const balance = await getBalance(ws);
    assert.equal(balance.held, 0);
    assert.equal(balance.balance, TRIAL.credits - 350);
  });

  await check('cancelling a queued report releases its hold', async () => {
    const { reportId: second } = await requestReport({ workspaceId: ws, userId: session.user.id }, { query: 'Second topic', platforms: ['x'], dateFrom: today, dateTo: today });
    assert.equal((await getBalance(ws)).held, 300);
    assert.equal(await cancelReport(ws, second), true);
    assert.equal((await getBalance(ws)).held, 0);
    assert.equal(await cancelReport(ws, second), false);
  });

  await check('a workspace without a subscription is on the free trial', async () => {
    const plan = await getPlanState(ws);
    assert.equal(plan.status, 'trial');
    assert.equal(plan.maxSources, TRIAL.maxSources);
  });
} finally {
  for (const account of accounts) {
    await pool.query('delete from workspaces where id = $1', [account.workspace.id]);
    await pool.query('delete from users where id = $1', [account.user.id]);
  }
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
