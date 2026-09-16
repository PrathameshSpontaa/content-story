// End-to-end check of alerts, digests, the notification queue and team invites against the real
// database with the fake email provider. Creates a throwaway workspace, runs each flow, prints
// PASS/FAIL, then deletes everything it made.
// Usage: node scripts/test-notify.js
import assert from 'node:assert/strict';
import { sendDueAlerts } from '../lib/alerts.js';
import { addCredits, getBalance } from '../lib/credits.js';
import { pool } from '../lib/db.js';
import { getDigestSettings, saveDigestSettings, sendDueDigests } from '../lib/digests.js';
import { emailProvider, flushNotifications } from '../lib/notify.js';
import { TeamError, acceptInvite, changeRole, createInvite, listMembers, removeMember } from '../lib/team.js';

if (emailProvider() !== 'fake') {
  console.error('RESEND_API_KEY is set. This test only runs with the fake email provider so it never emails anyone.');
  process.exit(1);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name}: ${err.message}`]);
  }
}
const quiet = () => {};
const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

const suffix = Date.now();
const ownerEmail = `notify-test-${suffix}-owner@content-story.dev`;
const inviteeEmail = `Notify-Test-${suffix}-Invitee@content-story.dev`;
const userIds = [];
let ws;

try {
  const owner = (await pool.query('insert into users (email, name) values ($1, $2) returning id', [ownerEmail, 'Notify Owner'])).rows[0];
  userIds.push(owner.id);
  ws = (await pool.query('insert into workspaces (name) values ($1) returning id', [`billing test notify ${suffix}`])).rows[0].id;
  await pool.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, owner.id]);
  await addCredits(ws, 1000, { reference: 'test', idempotencyKey: `test:notify:${suffix}:grant`, note: 'test credits' });

  // A published story with a heat score, and a creator behind one of its posts.
  const { rows: picks } = await pool.query(
    `select s.id as story_id, s.heat, h.creator_id
       from stories s
       join feeds f on f.id = s.feed_id and f.workspace_id is null
       join story_posts sp on sp.story_id = s.id
       join posts p on p.id = sp.post_id
       join creator_handles h on h.id = p.handle_id
      where s.published_at is not null and s.heat is not null and s.status not in ('merged', 'rejected')
        and exists (select 1 from story_versions v where v.story_id = s.id and v.passed)
      order by s.heat desc limit 1`,
  );
  const pick = picks[0];
  assert.ok(pick, 'the database has no published story with a creator behind it');
  await pool.query(`insert into tracking_targets (workspace_id, kind, creator_id, platforms) values ($1, 'creator', $2, '{x}')`, [ws, pick.creator_id]);
  await pool.query(`insert into alert_rules (workspace_id, min_heat, channel, destination, active) values ($1, 0, 'email', $2, true)`, [ws, ownerEmail]);

  await check('an alert goes out once per hot story and costs 2 credits', async () => {
    const res = await sendDueAlerts({ log: quiet });
    assert.ok(res.sent >= 1, `expected at least one alert, got ${res.sent}`);
    const { rows } = await pool.query(`select story_id, sent_at, error, subject, provider_id from notifications where workspace_id = $1 and kind = 'alert'`, [ws]);
    assert.equal(rows.length, res.sent);
    assert.ok(rows.every((r) => r.sent_at && !r.error && r.subject && r.provider_id));
    assert.ok(rows.some((r) => r.story_id === pick.story_id));
    const charged = await count(`select coalesce(-sum(amount), 0) as n from credit_entries where workspace_id = $1 and action = 'alert'`, [ws]);
    assert.equal(charged, 2 * res.sent);
    assert.equal((await getBalance(ws)).balance, 1000 - 2 * res.sent);
  });

  let alertCount;
  await check('running alerts again sends nothing and charges nothing', async () => {
    alertCount = await count(`select count(*) as n from notifications where workspace_id = $1 and kind = 'alert'`, [ws]);
    const before = (await getBalance(ws)).balance;
    const res = await sendDueAlerts({ log: quiet });
    assert.equal(res.sent, 0);
    assert.equal(await count(`select count(*) as n from notifications where workspace_id = $1 and kind = 'alert'`, [ws]), alertCount);
    assert.equal((await getBalance(ws)).balance, before);
  });

  await check('a daily digest goes out once a day and costs 5 credits', async () => {
    assert.equal((await getDigestSettings(ws)).destination, ownerEmail);
    await saveDigestSettings(ws, { frequency: 'daily', destination: ownerEmail });
    const before = (await getBalance(ws)).balance;
    const res = await sendDueDigests({ log: quiet });
    assert.equal(res.sent, 1);
    const { rows } = await pool.query(`select sent_at, error, subject from notifications where workspace_id = $1 and kind = 'digest'`, [ws]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].sent_at && !rows[0].error && rows[0].subject.startsWith('Your daily digest'));
    assert.equal((await getBalance(ws)).balance, before - 5);
    assert.ok((await getDigestSettings(ws)).lastSentOn);
    const again = await sendDueDigests({ log: quiet });
    assert.equal(again.sent, 0);
    assert.equal((await getBalance(ws)).balance, before - 5);
  });

  await check('flushNotifications sends a queued low_credits row', async () => {
    const { rows } = await pool.query(
      `insert into notifications (workspace_id, kind, destination, note) values ($1, 'low_credits', $2, 'You have 150 credits left, under 20% of your monthly allowance.') returning id`,
      [ws, ownerEmail],
    );
    const res = await flushNotifications({ log: quiet });
    assert.ok(res.sent >= 1 && res.failed === 0, `sent ${res.sent}, failed ${res.failed}`);
    const row = (await pool.query('select sent_at, error, subject, provider_id from notifications where id = $1', [rows[0].id])).rows[0];
    assert.ok(row.sent_at && !row.error && row.provider_id);
    assert.match(row.subject, /running low/);
  });

  await check('a trial workspace cannot invite: one seat, clear message', async () => {
    await assert.rejects(
      createInvite({ workspaceId: ws, email: inviteeEmail, role: 'member', invitedBy: owner.id, log: quiet }),
      (err) => err instanceof TeamError && /free trial has one seat/.test(err.message),
    );
    assert.equal(await count('select count(*) as n from invites where workspace_id = $1', [ws]), 0);
  });

  let invite;
  await check('on a Pro plan the invite is created and emailed', async () => {
    await pool.query(
      `insert into subscriptions (workspace_id, plan_id, provider, provider_subscription_id, status, current_period_start, current_period_end)
       values ($1, 'pro', 'fake', $2, 'active', now(), now() + interval '30 days')`,
      [ws, `fake_sub_notify_${suffix}`],
    );
    invite = await createInvite({ workspaceId: ws, email: inviteeEmail, role: 'admin', invitedBy: owner.id, log: quiet });
    assert.match(invite.token, /^[0-9a-f]{32}$/);
    assert.equal(invite.email, inviteeEmail.toLowerCase());
    const { rows } = await pool.query(`select destination, sent_at, error, subject from notifications where workspace_id = $1 and kind = 'invite'`, [ws]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].destination, inviteeEmail.toLowerCase());
    assert.ok(rows[0].sent_at && !rows[0].error && /invited you/.test(rows[0].subject));
    await assert.rejects(createInvite({ workspaceId: ws, email: ownerEmail, role: 'member', invitedBy: owner.id, log: quiet }), /already in this workspace/);
  });

  let invitee;
  await check('accepting the invite creates the membership with its role', async () => {
    invitee = (await pool.query('insert into users (email, name) values ($1, $2) returning id', [inviteeEmail, 'Notify Invitee'])).rows[0];
    userIds.push(invitee.id);
    await assert.rejects(acceptInvite({ token: invite.token, userId: invitee.id, email: 'someone-else@content-story.dev' }), /was sent to/);
    const joined = await acceptInvite({ token: invite.token, userId: invitee.id, email: inviteeEmail.toUpperCase() });
    assert.equal(joined, ws);
    const members = await listMembers(ws);
    assert.deepEqual(
      members.map((m) => [m.email.toLowerCase(), m.role]),
      [
        [ownerEmail, 'owner'],
        [inviteeEmail.toLowerCase(), 'admin'],
      ],
    );
    await assert.rejects(acceptInvite({ token: invite.token, userId: invitee.id, email: inviteeEmail }), /already been used/);
    await assert.rejects(acceptInvite({ token: 'deadbeef'.repeat(4), userId: invitee.id, email: inviteeEmail }), /isn’t valid/);
  });

  await check('roles change by owners only; the last owner stays', async () => {
    await assert.rejects(changeRole({ workspaceId: ws, actorId: invitee.id, userId: owner.id, role: 'member' }), /Only workspace owners/);
    await assert.rejects(removeMember({ workspaceId: ws, actorId: owner.id, userId: owner.id }), /at least one owner/);
    await assert.rejects(changeRole({ workspaceId: ws, actorId: owner.id, userId: owner.id, role: 'admin' }), /at least one owner/);
    assert.equal(await changeRole({ workspaceId: ws, actorId: owner.id, userId: invitee.id, role: 'member' }), true);
    assert.equal((await listMembers(ws)).find((m) => m.user_id === invitee.id).role, 'member');
    assert.equal(await removeMember({ workspaceId: ws, actorId: owner.id, userId: invitee.id }), true);
    assert.equal((await listMembers(ws)).length, 1);
  });
} finally {
  if (ws) {
    // The workspace cascades memberships, tracking, rules, notifications, credits, invites, digest settings and subscriptions.
    await pool.query('delete from workspaces where id = $1', [ws]);
    for (const table of ['notifications', 'credit_entries', 'invites', 'digest_settings', 'subscriptions', 'alert_rules', 'tracking_targets']) {
      const left = await count(`select count(*) as n from ${table} where workspace_id = $1`, [ws]);
      if (left) console.log(`WARN  ${left} ${table} rows left behind for ${ws}`);
    }
  }
  if (userIds.length) await pool.query('delete from users where id = any($1::uuid[])', [userIds]);
  await pool.end();
}

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
