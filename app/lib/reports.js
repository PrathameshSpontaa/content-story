// On-demand story reports. A request holds its quoted credits. During the beta the team prepares
// each report and marks it ready (charging at most the quote) or failed (releasing the hold).
import { randomUUID } from 'node:crypto';
import { InsufficientCredits, release, reserve, settle } from './credits.js';
import { pool, tx } from './db.js';
import { PLATFORMS, REPORT_LOOKBACK_DAYS, REPORT_MAX_DAYS, daysBetween, quoteReport } from './pricing.js';

export class ReportError extends Error {}

export const REPORT_STATUS = { queued: 'Queued', in_progress: 'Being prepared', ready: 'Ready', failed: 'Couldn’t be made', cancelled: 'Cancelled' };
const HOLD_MINUTES = 7 * 24 * 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const shiftDate = (ymd, days) => new Date(Date.parse(ymd) + days * 86_400_000).toISOString().slice(0, 10);

export async function requestReport({ workspaceId, userId }, { query, platforms, dateFrom, dateTo }) {
  const topic = String(query ?? '').trim().replace(/\s+/g, ' ');
  if (topic.length < 3 || topic.length > 80) throw new ReportError('Describe the topic in 3 to 80 characters, like “GPT-6 launch” or “boAt Airdopes”.');
  const chosen = PLATFORMS.filter((p) => (platforms ?? []).includes(p));
  if (!chosen.length) throw new ReportError('Pick at least one platform.');
  if (!DATE.test(dateFrom ?? '') || !DATE.test(dateTo ?? '')) throw new ReportError('Choose both dates.');
  const today = todayIST();
  if (dateTo > today) throw new ReportError('The end date can’t be in the future.');
  if (dateFrom > dateTo) throw new ReportError('The start date must be on or before the end date.');
  if (dateFrom < shiftDate(today, -REPORT_LOOKBACK_DAYS)) throw new ReportError(`Reports cover the last ${REPORT_LOOKBACK_DAYS} days.`);
  const days = daysBetween(dateFrom, dateTo);
  if (days > REPORT_MAX_DAYS) throw new ReportError(`A report covers up to ${REPORT_MAX_DAYS} days. Split longer periods into several reports.`);

  const quoted = quoteReport({ platforms: chosen.length, days });
  const reportId = randomUUID();
  let reservationId;
  try {
    reservationId = await reserve(workspaceId, quoted, { reference: `report:${reportId}`, ttlMinutes: HOLD_MINUTES });
  } catch (err) {
    if (err instanceof InsufficientCredits) {
      throw new ReportError(`This report needs ${quoted} credits and you have ${err.available} available. Top up on the Billing page.`);
    }
    throw err;
  }
  try {
    await pool.query(
      `insert into reports (id, workspace_id, requested_by, query, platforms, date_from, date_to, quoted_credits, reservation_id)
       values ($1, $2, $3, $4, $5::platform[], $6, $7, $8, $9)`,
      [reportId, workspaceId, userId, topic, chosen, dateFrom, dateTo, quoted, reservationId],
    );
  } catch (err) {
    await release(reservationId);
    throw err;
  }
  return { reportId, quoted };
}

const REPORT_COLUMNS = `
  r.id, r.query, r.platforms::text[] as platforms, r.date_from::text, r.date_to::text, r.quoted_credits,
  r.status, r.note, r.story_id, r.created_at, r.updated_at,
  (select -sum(e.amount)::int from credit_entries e where e.reference = 'report:' || r.id and e.kind = 'debit') as charged,
  (select coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline')
     from story_versions v where v.story_id = r.story_id and v.passed order by v.version desc limit 1) as story_headline`;

export async function listReports(workspaceId) {
  const { rows } = await pool.query(`select ${REPORT_COLUMNS} from reports r where r.workspace_id = $1 order by r.created_at desc`, [workspaceId]);
  return rows;
}

export async function cancelReport(workspaceId, reportId) {
  const reservationId = await tx(async (client) => {
    const { rows } = await client.query(`select reservation_id from reports where id = $1 and workspace_id = $2 and status = 'queued' for update`, [reportId, workspaceId]);
    if (!rows[0]) return null;
    await client.query(`update reports set status = 'cancelled', updated_at = now() where id = $1`, [reportId]);
    return rows[0].reservation_id;
  });
  if (reservationId) await release(reservationId);
  return Boolean(reservationId);
}

// Admin: every workspace's requests, oldest open ones first.
export async function listAllReports() {
  const { rows } = await pool.query(
    `select ${REPORT_COLUMNS}, w.name as workspace_name,
            (select u.email from users u where u.id = r.requested_by) as requested_by_email
       from reports r join workspaces w on w.id = r.workspace_id
      order by (r.status in ('queued', 'in_progress')) desc, r.created_at`,
  );
  return rows;
}

export async function updateReport(reportId, { status, storyId, usedCredits, note }) {
  if (!['in_progress', 'ready', 'failed'].includes(status)) throw new ReportError('Choose a status.');
  if (storyId && !/^[0-9a-f-]{36}$/i.test(storyId)) throw new ReportError('Pick a story from the list.');
  if (status === 'ready' && !storyId) throw new ReportError('Link the finished story before marking the report ready.');

  const report = await tx(async (client) => {
    const { rows } = await client.query(`select * from reports where id = $1 and status in ('queued', 'in_progress') for update`, [reportId]);
    if (!rows[0]) throw new ReportError('This report is already closed.');
    await client.query(
      `update reports set status = $2, story_id = coalesce($3::uuid, story_id), note = coalesce(nullif($4, ''), note), updated_at = now() where id = $1`,
      [reportId, status, storyId || null, note ?? ''],
    );
    return rows[0];
  });

  if (status === 'ready' && report.reservation_id) {
    const used = Number.isFinite(Number(usedCredits)) && usedCredits !== '' ? Number(usedCredits) : report.quoted_credits;
    await settle(report.reservation_id, used, { idempotencyKey: `report:${reportId}` });
  }
  if (status === 'failed' && report.reservation_id) await release(report.reservation_id);
}
