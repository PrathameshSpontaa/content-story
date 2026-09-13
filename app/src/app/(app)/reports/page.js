import Link from 'next/link';
import { getBalance } from '../../../../lib/credits.js';
import { PLATFORM_NAMES, dayRange, fmtDay, fmtNum, plural } from '../../../../lib/format.js';
import { PLATFORMS, REPORT_LOOKBACK_DAYS, REPORT_MAX_DAYS } from '../../../../lib/pricing.js';
import { REPORT_STATUS, listReports, shiftDate, todayIST } from '../../../../lib/reports.js';
import { requireSession } from '../../../../lib/session.js';
import ReportForm from '../../components/report-form.js';
import { cancelReportAction, requestReportAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports' };

const platformList = (platforms) => (platforms.length === PLATFORMS.length ? 'All platforms' : platforms.map((p) => PLATFORM_NAMES[p]).join(', '));
const OPEN = ['queued', 'in_progress'];

export default async function ReportsPage() {
  const session = await requireSession();
  const [reports, credits] = await Promise.all([listReports(session.workspace.id), getBalance(session.workspace.id)]);
  const today = todayIST();

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Reports</h1>
        <p>
          Ask about any topic, brand or launch from the last {REPORT_LOOKBACK_DAYS} days. You get one story: what creators said, how each platform’s audience reacted, and a
          link to every source.
        </p>
      </header>

      <div className="split">
        <section className="panel">
          <h2>Request a report</h2>
          <ReportForm
            action={requestReportAction}
            today={today}
            minDate={shiftDate(today, -REPORT_LOOKBACK_DAYS)}
            defaultFrom={shiftDate(today, -(REPORT_MAX_DAYS - 1))}
            maxDays={REPORT_MAX_DAYS}
            available={credits.available}
            platformNames={PLATFORM_NAMES}
          />
        </section>
        <aside className="panel quiet">
          <h2>How it works</h2>
          <ol className="howlist">
            <li>Requesting holds the quoted credits. A report never costs more than its quote.</li>
            <li>During the beta, our team prepares each report within 2 business days.</li>
            <li>It opens as a full story with sources. We charge what it used; if we can’t make it, the hold is released.</li>
            <li>You can cancel any time before work starts.</li>
          </ol>
        </aside>
      </div>

      <section className="fsection" aria-labelledby="h-yours">
        <div className="fsection-head">
          <h2 id="h-yours">Your reports</h2>
          {reports.length ? <p>{plural(reports.length, 'report')}</p> : null}
        </div>
        {reports.length ? (
          <ul className="rlist">
            {reports.map((r) => (
              <li key={r.id} className="ritem">
                <div className="ritem-main">
                  <b>{r.query}</b>
                  <span className="ritem-meta">
                    {dayRange(r.date_from, r.date_to)} · {platformList(r.platforms)} · requested {fmtDay(r.created_at)}
                  </span>
                  {r.note ? <span className="ritem-note">{r.note}</span> : null}
                </div>
                <span className={`status ${r.status}`}>{REPORT_STATUS[r.status] ?? r.status}</span>
                <span className="ritem-credits">
                  <b>{fmtNum(r.charged ?? r.quoted_credits)}</b>
                  <span>{r.charged != null ? `of ${fmtNum(r.quoted_credits)} quoted` : OPEN.includes(r.status) ? 'credits on hold' : 'not charged'}</span>
                </span>
                <div className="ritem-actions">
                  {r.status === 'ready' && r.story_id ? (
                    <Link className="btn primary sm" href={`/stories/${r.story_id}`}>
                      Open
                    </Link>
                  ) : null}
                  {r.status === 'queued' ? (
                    <form action={cancelReportAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="btn ghost sm">
                        Cancel
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">
            <h2>No reports yet</h2>
            <p>Try a launch or a brand from last week to see how it played out across platforms.</p>
          </div>
        )}
      </section>
    </div>
  );
}
