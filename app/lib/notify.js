// Sends email and keeps a record of every one in notifications. Resend when RESEND_API_KEY is
// set; otherwise a fake provider that logs and marks the row sent (development and tests).
import { pool } from './db.js';
import { loadEnv, requireEnv } from './env.js';

export const APP_URL = () => (process.env.APP_URL ?? '').trim().replace(/\/$/, '') || 'https://content-story.onrender.com';

export function emailProvider() {
  loadEnv();
  return (process.env.RESEND_API_KEY ?? '').trim() ? 'resend' : 'fake';
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Plain wrapper every email shares: a title, the body, and where it came from.
export function emailLayout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1b18">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e3da;border-radius:10px;padding:26px 28px">
<p style="margin:0 0 14px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b675d">Content-Story</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(title)}</h1>
${bodyHtml}
<p style="margin:24px 0 0;font-size:12px;color:#8a8578">Sent by Content-Story. Change what you receive under <a href="${APP_URL()}/settings" style="color:#1d4ed8">Settings</a>.</p>
</div></body></html>`;
}

async function deliver({ to, subject, html, text }, log) {
  if (emailProvider() === 'fake') {
    log(`[email:fake] to ${to} · ${subject}`);
    return { providerId: `fake_${Date.now().toString(36)}` };
  }
  const apiKey = requireEnv('RESEND_API_KEY');
  const from = requireEnv('EMAIL_FROM');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body?.message ?? body?.name ?? 'request failed'}`);
  return { providerId: body?.id ?? null };
}

async function markSent(id, providerId) {
  await pool.query('update notifications set sent_at = now(), provider_id = $2, error = null where id = $1', [id, providerId]);
}
async function markFailed(id, err) {
  await pool.query('update notifications set error = $2 where id = $1', [id, String(err?.message ?? err).slice(0, 500)]);
}

// Records the email, then sends it. Returns the notifications row id whether or not the send worked.
export async function sendEmail({ to, subject, html, text, workspaceId = null, kind, storyId = null, note = null, log = console.log }) {
  if (!to) throw new Error('sendEmail needs a destination');
  if (!kind) throw new Error('sendEmail needs a kind');
  const { rows } = await pool.query(
    `insert into notifications (workspace_id, kind, story_id, destination, subject, note) values ($1, $2, $3, $4, $5, $6) returning id`,
    [workspaceId, kind, storyId, to, subject, note],
  );
  const id = rows[0].id;
  try {
    const { providerId } = await deliver({ to, subject, html, text: text ?? stripTags(html) }, log);
    await markSent(id, providerId);
  } catch (err) {
    await markFailed(id, err);
  }
  return id;
}

const stripTags = (html) => String(html ?? '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Subject and body for rows other code inserts with only kind, destination and note.
function compose(row) {
  const app = APP_URL();
  const workspace = row.workspace_name ? `${row.workspace_name}` : 'your workspace';
  const note = row.note ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(row.note)}</p>` : '';
  if (row.kind === 'low_credits') {
    const subject = row.subject || `Credits are running low in ${workspace}`;
    return {
      subject,
      html: emailLayout(subject, `${note}<p style="margin:0 0 12px;font-size:15px;line-height:1.5">When credits run out, tracking pauses and alerts stop until you top up.</p><p style="margin:16px 0 0"><a href="${app}/billing" style="display:inline-block;padding:10px 16px;background:#1c1b18;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Top up credits</a></p>`),
    };
  }
  if (row.kind === 'ops') {
    const first = String(row.note ?? '').split('\n')[0].slice(0, 80);
    const subject = row.subject || `Content-Story ops: ${first || 'something needs a look'}`;
    return { subject, html: emailLayout(subject, `<pre style="margin:0;white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace">${escapeHtml(row.note ?? '')}</pre>`) };
  }
  if (row.subject) return { subject: row.subject, html: emailLayout(row.subject, note) };
  return null;
}

// Sends every row still waiting. One bad email never stops the rest: its error is recorded on the row.
export async function flushNotifications({ log = console.log } = {}) {
  const { rows } = await pool.query(
    `select n.id, n.kind, n.destination, n.subject, n.note, w.name as workspace_name
       from notifications n left join workspaces w on w.id = n.workspace_id
      where n.sent_at is null and n.error is null
      order by n.created_at
      limit 500`,
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const email = compose(row);
      if (!email) throw new Error(`nothing to send for kind "${row.kind}"`);
      const { providerId } = await deliver({ to: row.destination, subject: email.subject, html: email.html, text: stripTags(email.html) }, log);
      await pool.query('update notifications set sent_at = now(), provider_id = $2, subject = $3, error = null where id = $1', [row.id, providerId, email.subject]);
      sent += 1;
    } catch (err) {
      failed += 1;
      log(`[email] ${row.kind} to ${row.destination} failed: ${err.message}`);
      await markFailed(row.id, err).catch(() => {});
    }
  }
  return { sent, failed };
}
