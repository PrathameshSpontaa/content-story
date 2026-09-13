import Link from 'next/link';
import { getBalance } from '../../../../lib/credits.js';
import { PLATFORM_NAMES, dayRange, fmtDay, fmtNum } from '../../../../lib/format.js';
import { PLATFORMS, REPORT_LOOKBACK_DAYS, REPORT_MAX_DAYS } from '../../../../lib/pricing.js';
import { REPORT_STATUS, listReports, shiftDate, todayIST } from '../../../../lib/reports.js';
import { requireSession } from '../../../../lib/session.js';
import ReportForm from '../../components/report-form.js';
import { cancelReportAction, requestReportAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports' };

const platformList = (platforms) => (platforms.length === PLATFORMS.length ? 'All platforms' : platforms.map((p) => PLATFORM_NAMES[p]).join(', '));

export default async function ReportsPage() {
  const session = await requireSession();
  const [reports, credits] = await Promise.all([listReports(session.workspace.id), getBalance(session.workspace.id)]);
  const today = todayIST();

  return (
    <main className="apppage">
      <header className="pagehead">
        <h1>Reports</h1>
        <p className="dek">
          One story on any topic, brand or launch from the last {REPORT_LOOKBACK_DAYS} days: what creators said, how each platform’s audience reacted, and a link to every
          source.
        </p>
      </header>

      <div className="addgrid">
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
        <section className="panel quiet">
          <h2>How reports work</h2>
          <ol className="howlist">
            <li>Requesting holds the quoted credits. A report never costs more than its quote.</li>
            <li>During the beta, our team prepares each report within 2 business days.</li>
            <li>When it’s ready it opens as a full story with sources, and we charge what it used. If we can’t make it, the hold is released.</li>
            <li>You can cancel until work starts.</li>
          </ol>
        </section>
      </div>

      <h2 className="sect">Your reports</h2>
      {reports.length ? (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Period</th>
                <th className="num">Credits</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.query}</b>
                    <span className="sub">
                      {platformList(r.platforms)} · requested {fmtDay(r.created_at)}
                    </span>
                    {r.note ? <span className="sub">{r.note}</span> : null}
                  </td>
                  <td>{dayRange(r.date_from, r.date_to)}</td>
                  <td className="num">
                    {r.charged != null ? fmtNum(r.charged) : fmtNum(r.quoted_credits)}
                    <span className="sub">{r.charged != null ? `of ${fmtNum(r.quoted_credits)} quoted` : ['queued', 'in_progress'].includes(r.status) ? 'on hold' : 'not charged'}</span>
                  </td>
                  <td>
                    <span className={`status ${r.status}`}>{REPORT_STATUS[r.status] ?? r.status}</span>
                  </td>
                  <td className="actions">
                    {r.status === 'ready' && r.story_id ? (
                      <Link className="btn ghost sm" href={`/stories/${r.story_id}`}>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <b>No reports yet.</b>
          <span>Try a launch or a brand from the last week to see how it played out across platforms.</span>
        </div>
      )}
    </main>
  );
}
