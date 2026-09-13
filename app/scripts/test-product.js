// End-to-end check of accounts, watchlist, feed filters, saved stories and reports against the
// real database. Creates a throwaway account, runs each flow, prints PASS/FAIL, then deletes it.
// Usage: node scripts/test-product.js
import assert from 'node:assert/strict';
import { ensureAccount, getPlanState } from '../lib/accounts.js';
import { getBalance } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { TRIAL } from '../lib/pricing.js';
import { ReportError, cancelReport, listReports, requestReport, shiftDate, todayIST, updateReport } from '../lib/reports.js';
import { getFeed, getStoryContext, toggleSaved } from '../lib/stories.js';
import { WatchlistError, addCreator, addTopic, listTargets, parseHandle, removeTarget, setTargetActive } from '../lib/watchlist.js';

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
const clerkId = `test:${suffix}`;
const email = `product-test-${suffix}@content-story.dev`;
let session;

try {
  await check('first sign-in creates a user, an owned workspace and trial credits', async () => {
    const [a, b] = await Promise.all([ensureAccount(clerkId, async () => ({ email, name: 'Test Person' })), ensureAccount(clerkId, async () => ({ email, name: 'Test Person' }))]);
    assert.equal(a.workspace.id, b.workspace.id);
    session = a;
    assert.equal(session.role, 'owner');
    assert.equal((await getBalance(session.workspace.id)).balance, TRIAL.credits);
    const { rows } = await pool.query('select count(*)::int as n from memberships where user_id = $1', [session.user.id]);
    assert.equal(rows[0].n, 1);
  });

  await check('signing in again reuses the account and grants nothing more', async () => {
    const again = await ensureAccount(clerkId, async () => assert.fail('profile should not be loaded again'));
    assert.equal(again.workspace.id, session.workspace.id);
    assert.equal((await getBalance(session.workspace.id)).balance, TRIAL.credits);
  });

  await check('pasted profile links and handles become the stored handle form', async () => {
    assert.deepEqual(parseHandle('x', 'https://twitter.com/mreflow?lang=en'), { handle: '@mreflow', url: 'https://x.com/mreflow' });
    assert.equal(parseHandle('youtube', 'youtube.com/@mreflow/videos').handle, '@mreflow');
    assert.equal(parseHandle('instagram', '@mr.eflow').handle, '@mr.eflow');
    assert.equal(parseHandle('linkedin', 'https://www.linkedin.com/in/Matt-Wolfe-30841712/').handle, 'matt-wolfe-30841712');
    assert.throws(() => parseHandle('x', 'not a handle!'), WatchlistError);
  });

  await check('adding a creator we already collect matches them by handle', async () => {
    const res = await addCreator(session.workspace.id, { name: '', handles: { x: 'x.com/mreflow' } });
    assert.equal(res.matchedExisting, true);
    assert.equal(res.creatorName, 'Matt Wolfe');
    const [target] = await listTargets(session.workspace.id);
    assert.ok(target.handles.length >= 3, 'fills in their other platforms');
    assert.ok(target.posts_collected > 0);
  });

  await check('the same creator can’t be added twice', async () => {
    await assert.rejects(addCreator(session.workspace.id, { handles: { youtube: '@mreflow' } }), /already on your watchlist/);
  });

  await check('stories involving the watchlist show under “From your watchlist”', async () => {
    const all = await getFeed({ workspaceId: session.workspace.id });
    const mine = await getFeed({ workspaceId: session.workspace.id, scope: 'watchlist' });
    assert.ok(mine.length > 0 && mine.length <= all.length);
    assert.ok(mine.every((s) => s.tracked.includes('Matt Wolfe')));
  });

  await check('a keyword and a subreddit are added; the trial limit is enforced', async () => {
    await addTopic(session.workspace.id, { kind: 'community', query: 'https://www.reddit.com/r/LocalLLaMA/' });
    await addTopic(session.workspace.id, { kind: 'keyword', query: 'GPT-6', platforms: ['x', 'youtube'] });
    await assert.rejects(addTopic(session.workspace.id, { kind: 'keyword', query: 'Gemini', platforms: ['x'] }), /includes 1 active/);
    const targets = await listTargets(session.workspace.id);
    assert.equal(targets.length, 3);
    assert.deepEqual(targets.find((t) => t.kind === 'keyword').platforms, ['x', 'youtube']);
  });

  await check('pausing frees a slot; resuming past the limit is refused', async () => {
    const keyword = (await listTargets(session.workspace.id)).find((t) => t.kind === 'keyword');
    await setTargetActive(session.workspace.id, keyword.id, false);
    await addTopic(session.workspace.id, { kind: 'keyword', query: 'Gemini', platforms: ['x'] });
    await assert.rejects(setTargetActive(session.workspace.id, keyword.id, true), WatchlistError);
    await removeTarget(session.workspace.id, keyword.id);
  });

  await check('search, category and platform filters narrow the feed', async () => {
    const all = await getFeed({ workspaceId: session.workspace.id });
    const story = all[0];
    const byCategory = await getFeed({ workspaceId: session.workspace.id, category: story.category });
    assert.ok(byCategory.every((s) => s.category === story.category));
    const bySearch = await getFeed({ workspaceId: session.workspace.id, q: story.main_character });
    assert.ok(bySearch.some((s) => s.id === story.id));
    assert.equal((await getFeed({ workspaceId: session.workspace.id, q: 'zzqx%_no-such-thing' })).length, 0);
    const reddit = await getFeed({ workspaceId: session.workspace.id, platform: 'reddit' });
    assert.ok(reddit.length < all.length || reddit.length === all.length);
  });

  await check('saving a story toggles it in and out of Saved', async () => {
    const [story] = await getFeed({ workspaceId: session.workspace.id });
    assert.equal(await toggleSaved(session.workspace.id, session.user.id, story.id), true);
    assert.equal((await getStoryContext(story.id, session.workspace.id)).saved, true);
    assert.equal((await getFeed({ workspaceId: session.workspace.id, scope: 'saved' })).length, 1);
    assert.equal(await toggleSaved(session.workspace.id, session.user.id, story.id), false);
  });

  const today = todayIST();
  let reportId;
  await check('a report request holds its quote', async () => {
    const res = await requestReport({ workspaceId: session.workspace.id, userId: session.user.id }, { query: 'GPT-6 Astra launch', platforms: ['x', 'youtube', 'reddit', 'linkedin'], dateFrom: shiftDate(today, -4), dateTo: today });
    reportId = res.reportId;
    assert.equal(res.quoted, 300 + 80 + 100);
    assert.equal((await getBalance(session.workspace.id)).held, 480);
  });

  await check('report requests are validated before anything is held', async () => {
    const ws = { workspaceId: session.workspace.id, userId: session.user.id };
    await assert.rejects(requestReport(ws, { query: 'x', platforms: ['x'], dateFrom: today, dateTo: today }), ReportError);
    await assert.rejects(requestReport(ws, { query: 'Long one', platforms: ['x'], dateFrom: shiftDate(today, -9), dateTo: today }), /up to 7 days/);
    await assert.rejects(requestReport(ws, { query: 'Too dear', platforms: ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'], dateFrom: shiftDate(today, -6), dateTo: today }), /available/);
    assert.equal((await getBalance(session.workspace.id)).held, 480);
  });

  await check('marking a report ready charges what it used, never more than the quote', async () => {
    const [story] = await getFeed();
    await assert.rejects(updateReport(reportId, { status: 'ready' }), /Link the finished story/);
    await updateReport(reportId, { status: 'ready', storyId: story.id, usedCredits: '350', note: 'Done' });
    const [report] = await listReports(session.workspace.id);
    assert.equal(report.status, 'ready');
    assert.equal(report.charged, 350);
    const balance = await getBalance(session.workspace.id);
    assert.equal(balance.held, 0);
    assert.equal(balance.balance, TRIAL.credits - 350);
  });

  await check('cancelling a queued report releases its hold', async () => {
    const { reportId: second } = await requestReport({ workspaceId: session.workspace.id, userId: session.user.id }, { query: 'Second topic', platforms: ['x'], dateFrom: today, dateTo: today });
    assert.equal((await getBalance(session.workspace.id)).held, 300);
    assert.equal(await cancelReport(session.workspace.id, second), true);
    assert.equal((await getBalance(session.workspace.id)).held, 0);
    assert.equal(await cancelReport(session.workspace.id, second), false);
  });

  await check('a workspace without a subscription is on the free trial', async () => {
    const plan = await getPlanState(session.workspace.id);
    assert.equal(plan.status, 'trial');
    assert.equal(plan.maxSources, TRIAL.maxSources);
  });
} finally {
  if (session) {
    await pool.query('delete from workspaces where id = $1', [session.workspace.id]);
    await pool.query('delete from users where id = $1', [session.user.id]);
  }
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
