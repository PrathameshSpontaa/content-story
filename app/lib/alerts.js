// Alerts: one email when a story involving a workspace's watchlist crosses its heat threshold.
// Each story is alerted once per workspace and charged once, by idempotency key.
import { InsufficientCredits, charge } from './credits.js';
import { pool } from './db.js';
import { APP_URL, emailLayout, escapeHtml, sendEmail } from './notify.js';
import { getFeed } from './stories.js';

const DEFAULT_MIN_HEAT = 50;

async function ownerEmail(workspaceId) {
  const { rows } = await pool.query(
    `select u.email from memberships m join users u on u.id = m.user_id
      where m.workspace_id = $1 order by (m.role = 'owner') desc, u.created_at limit 1`,
    [workspaceId],
  );
  return rows[0]?.email ?? '';
}

export async function getAlertSettings(workspaceId) {
  const { rows } = await pool.query('select id, min_heat, destination, active from alert_rules where workspace_id = $1 order by id limit 1', [workspaceId]);
  const rule = rows[0];
  if (!rule) return { active: false, minHeat: DEFAULT_MIN_HEAT, destination: await ownerEmail(workspaceId) };
  return { active: rule.active, minHeat: rule.min_heat, destination: rule.destination };
}

export async function saveAlertSettings(workspaceId, { minHeat, destination, active }) {
  const heat = Math.min(100, Math.max(0, Math.round(Number(minHeat)) || 0));
  const to = String(destination ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Enter the email address alerts should go to.');
  const { rows } = await pool.query('select id from alert_rules where workspace_id = $1 order by id limit 1', [workspaceId]);
  if (rows[0]) {
    await pool.query('update alert_rules set min_heat = $2, destination = $3, active = $4 where id = $1', [rows[0].id, heat, to, Boolean(active)]);
  } else {
    await pool.query(`insert into alert_rules (workspace_id, min_heat, channel, destination, active) values ($1, $2, 'email', $3, $4)`, [workspaceId, heat, to, Boolean(active)]);
  }
  return { active: Boolean(active), minHeat: heat, destination: to };
}

function alertEmail(story, tracked) {
  const app = APP_URL();
  const link = `${app}/stories/${story.id}`;
  const who = tracked.length ? `This involves ${tracked.join(', ')}, which you follow.` : 'This involves something you follow.';
  const html = emailLayout(
    story.headline,
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(story.dek ?? '')}</p>
     <p style="margin:0 0 12px;font-size:14px;color:#6b675d">Heat ${escapeHtml(story.heat)} · ${escapeHtml(who)}</p>
     <p style="margin:16px 0 0"><a href="${link}" style="display:inline-block;padding:10px 16px;background:#1c1b18;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Read the story</a></p>`,
  );
  const text = `${story.headline}\n\n${story.dek ?? ''}\n\nHeat ${story.heat}. ${who}\n\n${link}`;
  return { subject: `Alert: ${story.headline}`, html, text };
}

// Sends what is due for every active rule. Returns how many went out and how many were skipped.
export async function sendDueAlerts({ log = console.log } = {}) {
  const { rows: rules } = await pool.query('select id, workspace_id, min_heat, destination from alert_rules where active order by workspace_id');
  let sent = 0;
  let skipped = 0;
  for (const rule of rules) {
    let stories;
    try {
      stories = await getFeed({ workspaceId: rule.workspace_id, scope: 'watchlist' });
    } catch (err) {
      log(`[alerts] ${rule.workspace_id}: could not read the feed: ${err.message}`);
      continue;
    }
    const { rows: done } = await pool.query(`select story_id from notifications where workspace_id = $1 and kind = 'alert' and story_id is not null`, [rule.workspace_id]);
    const alerted = new Set(done.map((r) => r.story_id));
    for (const story of stories) {
      if (story.heat == null || story.heat < rule.min_heat || alerted.has(story.id)) continue;
      try {
        await charge(rule.workspace_id, 'alert', 1, { reference: `story:${story.id}`, idempotencyKey: `alert:${rule.workspace_id}:${story.id}` });
      } catch (err) {
        if (!(err instanceof InsufficientCredits)) throw err;
        await pool.query(`insert into notifications (workspace_id, kind, story_id, destination, error) values ($1, 'alert', $2, $3, 'out of credits')`, [rule.workspace_id, story.id, rule.destination]);
        skipped += 1;
        log(`[alerts] ${rule.workspace_id}: out of credits, skipped ${story.id}`);
        continue;
      }
      const email = alertEmail(story, story.tracked ?? []);
      await sendEmail({ ...email, to: rule.destination, workspaceId: rule.workspace_id, kind: 'alert', storyId: story.id, log });
      sent += 1;
    }
  }
  return { sent, skipped };
}
