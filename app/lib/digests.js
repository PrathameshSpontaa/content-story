// Digests: a daily or weekly email with the top stories for a workspace. Days are IST; weekly
// digests go out on Monday. One digest per workspace per day, charged once by idempotency key.
import { InsufficientCredits, charge } from './credits.js';
import { pool } from './db.js';
import { plural } from './format.js';
import { APP_URL, emailLayout, escapeHtml, sendEmail } from './notify.js';
import { getFeed } from './stories.js';

export const FREQUENCIES = ['off', 'daily', 'weekly'];
const MAX_STORIES = 8;

export const dateIST = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
const weekdayIST = (now = new Date()) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now);

async function ownerEmail(workspaceId) {
  const { rows } = await pool.query(
    `select u.email from memberships m join users u on u.id = m.user_id
      where m.workspace_id = $1 order by (m.role = 'owner') desc, u.created_at limit 1`,
    [workspaceId],
  );
  return rows[0]?.email ?? '';
}

export async function getDigestSettings(workspaceId) {
  const { rows } = await pool.query('select frequency, destination, last_sent_on from digest_settings where workspace_id = $1', [workspaceId]);
  const row = rows[0];
  if (!row) return { frequency: 'off', destination: await ownerEmail(workspaceId), lastSentOn: null };
  return { frequency: row.frequency, destination: row.destination, lastSentOn: row.last_sent_on };
}

export async function saveDigestSettings(workspaceId, { frequency, destination }) {
  if (!FREQUENCIES.includes(frequency)) throw new Error('Choose off, daily or weekly.');
  const to = String(destination ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Enter the email address the digest should go to.');
  await pool.query(
    `insert into digest_settings (workspace_id, frequency, destination) values ($1, $2, $3)
     on conflict (workspace_id) do update set frequency = excluded.frequency, destination = excluded.destination, updated_at = now()`,
    [workspaceId, frequency, to],
  );
  return { frequency, destination: to };
}

// The workspace's own stories, hottest first, up to MAX_STORIES. Nothing from other workspaces.
export async function digestStories(workspaceId) {
  return (await getFeed({ workspaceId })).slice(0, MAX_STORIES);
}

function digestEmail(stories, { frequency, date }) {
  const app = APP_URL();
  const title = frequency === 'weekly' ? 'Your weekly digest' : 'Your daily digest';
  const items = stories
    .map((s) => {
      const link = `${app}/stories/${s.id}`;
      const meta = [`Heat ${s.heat ?? '–'}`, plural(s.sources ?? s.creators ?? 0, 'source'), s.tracked?.length ? `you follow ${s.tracked.join(', ')}` : ''].filter(Boolean).join(' · ');
      return `<li style="margin:0 0 16px;padding:0 0 16px;border-bottom:1px solid #eeece5">
        <a href="${link}" style="font-size:16px;font-weight:700;color:#1c1b18;text-decoration:none">${escapeHtml(s.headline)}</a>
        <p style="margin:6px 0 4px;font-size:14px;line-height:1.5">${escapeHtml(s.dek ?? '')}</p>
        <p style="margin:0;font-size:12.5px;color:#6b675d">${escapeHtml(meta)}</p></li>`;
    })
    .join('');
  const html = emailLayout(
    title,
    `<p style="margin:0 0 16px;font-size:14px;color:#6b675d">${escapeHtml(date)} · ${plural(stories.length, 'story', 'stories')}</p>
     <ul style="margin:0;padding:0;list-style:none">${items}</ul>
     <p style="margin:16px 0 0"><a href="${app}/stories" style="display:inline-block;padding:10px 16px;background:#1c1b18;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open your feed</a></p>`,
  );
  const text = [`${title} · ${date}`, '', ...stories.map((s) => `${s.headline}\n${s.dek ?? ''}\nHeat ${s.heat ?? '–'} · ${app}/stories/${s.id}\n`)].join('\n');
  return { subject: `${title}: ${stories[0].headline}`, html, text };
}

function isDue(row, today, weekday) {
  if (row.frequency === 'off') return false;
  if (row.last_sent_on && row.last_sent_on >= today) return false;
  if (row.frequency === 'weekly' && weekday !== 'Mon') return false;
  return true;
}

// Sends every digest due today (IST). Returns how many went out and how many were skipped.
export async function sendDueDigests({ now = new Date(), log = console.log } = {}) {
  const today = dateIST(now);
  const weekday = weekdayIST(now);
  const { rows } = await pool.query(`select workspace_id, frequency, destination, to_char(last_sent_on, 'YYYY-MM-DD') as last_sent_on from digest_settings where frequency <> 'off'`);
  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isDue(row, today, weekday)) continue;
    let stories;
    try {
      stories = await digestStories(row.workspace_id);
    } catch (err) {
      log(`[digests] ${row.workspace_id}: could not read the feed: ${err.message}`);
      continue;
    }
    if (!stories.length) {
      skipped += 1;
      log(`[digests] ${row.workspace_id}: nothing to send today`);
      continue;
    }
    try {
      await charge(row.workspace_id, 'digest', 1, { reference: `digest:${today}`, idempotencyKey: `digest:${row.workspace_id}:${today}` });
    } catch (err) {
      if (!(err instanceof InsufficientCredits)) throw err;
      await pool.query(`insert into notifications (workspace_id, kind, destination, error, note) values ($1, 'digest', $2, 'out of credits', $3)`, [row.workspace_id, row.destination, today]);
      await pool.query('update digest_settings set last_sent_on = $2 where workspace_id = $1', [row.workspace_id, today]);
      skipped += 1;
      log(`[digests] ${row.workspace_id}: out of credits, skipped`);
      continue;
    }
    const email = digestEmail(stories, { frequency: row.frequency, date: today });
    await sendEmail({ ...email, to: row.destination, workspaceId: row.workspace_id, kind: 'digest', note: today, log });
    await pool.query('update digest_settings set last_sent_on = $2 where workspace_id = $1', [row.workspace_id, today]);
    sent += 1;
  }
  return { sent, skipped };
}
