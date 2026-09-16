// Operations dashboard: the last runs with their cost, spend per day against the caps, margin
// per action, and emails that failed or never went out.
import Link from 'next/link';
import { costByDay, listNotificationProblems, listRuns, marginByAction, spendToday } from '../../../../../lib/admin.js';
import { fmtDay, fmtNum, fmtTime, plural } from '../../../../../lib/format.js';
import { requireAdmin } from '../../../../../lib/session.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Runs and spend' };

const usd = (n) => `$${Number(n || 0).toFixed(n && n < 1 ? 3 : 2)}`;
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const duration = (s) => (s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const summaryText = (summary) => {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  return Object.entries(summary)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
};

function AdminNav({ current }) {
  return (
    <nav className="tabs admin-tabs" aria-label="Admin pages">
      <Link href="/admin" className={current === 'admin' ? 'on' : undefined}>
        Review and reports
      </Link>
      <Link href="/admin/runs" className={current === 'runs' ? 'on' : undefined}>
        Runs and spend
      </Link>
    </nav>
  );
}

export default async function RunsPage() {
  await requireAdmin();
  const [runs, days, today, margin, problems] = await Promise.all([listRuns(50), costByDay(14), spendToday(), marginByAction(30), listNotificationProblems(20)]);
  const failed = runs.filter((r) => r.status === 'failed').length;

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Runs and spend</h1>
        <p className="dek">Every pipeline run with what it cost, spend against the daily caps, margin by action, and emails that didn’t go out.</p>
      </header>
      <AdminNav current="runs" />

      <dl className="stats">
        {today.map((t) => (
          <div key={t.provider}>
            <dt>{t.provider === 'apify' ? 'Apify' : 'Gemini'} today (India time)</dt>
            <dd>
              {usd(t.usd)} <small className="muted">of {usd(t.cap)}</small>
              <span className={`cap${t.pct >= 100 ? ' over' : t.pct >= 80 ? ' warn' : ''}`}>
                <i style={{ width: `${Math.min(100, t.pct)}%` }} />
              </span>
            </dd>
          </div>
        ))}
        <div>
          <dt>Failed runs in the last 50</dt>
          <dd>{fmtNum(failed)}</dd>
        </div>
        <div>
          <dt>Emails failed or unsent</dt>
          <dd>{fmtNum(problems.length)}</dd>
        </div>
      </dl>

      <h2 className="sect">
        Runs <span>last {runs.length}, newest first</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Started</th>
              <th className="num">Took</th>
              <th className="num">Cost</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} id={`run-${r.id}`}>
                <td>
                  <b>{r.kind}</b>
                  <span className="sub">{r.workspace_name ?? 'shared'}</span>
                </td>
                <td>
                  <span className={`status ${r.status === 'failed' ? 'failed' : r.status === 'running' ? 'queued' : r.status === 'done' || r.status === 'finished' || r.status === 'succeeded' ? 'ready' : ''}`}>
                    {r.status}
                  </span>
                  {r.error ? <span className="sub err">{r.error}</span> : null}
                </td>
                <td>
                  {fmtTime(r.started_at)}
                  {r.finished_at ? <span className="sub">finished {fmtTime(r.finished_at)}</span> : null}
                </td>
                <td className="num">{duration(r.seconds)}</td>
                <td className="num">
                  {usd(r.usd)}
                  {r.cost_events ? <span className="sub">{plural(r.cost_events, 'cost event')}</span> : null}
                </td>
                <td className="summary">{summaryText(r.summary) || '—'}</td>
              </tr>
            ))}
            {!runs.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  No runs yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Spend by day <span>last 14 days, India time, in USD</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Apify</th>
              <th className="num">Gemini</th>
              <th className="num">Other</th>
              <th className="num">Total</th>
              <th className="num">Events</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{fmtDay(`${d.day}T12:00:00+05:30`)}</td>
                <td className="num">{usd(d.apify)}</td>
                <td className="num">{usd(d.gemini)}</td>
                <td className="num">{d.other ? usd(d.other) : '—'}</td>
                <td className="num">
                  <b>{usd(d.total)}</b>
                </td>
                <td className="num">{fmtNum(d.events)}</td>
              </tr>
            ))}
            {!days.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing spent in the last 14 days.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Margin <span>last {margin.days} days</span>
      </h2>
      <p className="muted-note">
        Rule of thumb: 1 credit = {inr(margin.inrPerCredit)} (CREDIT_INR) and $1 = {inr(margin.inrPerUsd)} (USD_INR). Cost is grouped by the run kind behind each cost event; credits by the
        action charged.
      </p>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Action</th>
              <th className="num">Charges</th>
              <th className="num">Credits</th>
              <th className="num">Revenue</th>
              <th className="num">Cost</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {margin.rows.map((b) => (
              <tr key={b.bucket}>
                <td>
                  <b>{b.label}</b>
                  {b.actions.length ? <span className="sub">{b.actions.join(', ')}</span> : null}
                </td>
                <td className="num">{fmtNum(b.entries)}</td>
                <td className="num">{fmtNum(b.credits)}</td>
                <td className="num">{inr(b.revenueInr)}</td>
                <td className="num">
                  {usd(b.usd)}
                  <span className="sub">{inr(b.costInr)}</span>
                </td>
                <td className={`num ${b.marginInr < 0 ? 'err' : 'plus'}`}>
                  {inr(b.marginInr)}
                  {b.marginPct != null ? <span className="sub">{b.marginPct}%</span> : null}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Total</b>
              </td>
              <td className="num" />
              <td className="num">{fmtNum(margin.total.credits)}</td>
              <td className="num">{inr(margin.total.revenueInr)}</td>
              <td className="num">
                {usd(margin.total.usd)}
                <span className="sub">{inr(margin.total.costInr)}</span>
              </td>
              <td className={`num ${margin.total.marginInr < 0 ? 'err' : 'plus'}`}>{inr(margin.total.marginInr)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="sect">
        Emails not sent <span>failed or still waiting, last 20</span>
      </h2>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>To</th>
              <th>Created</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((n) => (
              <tr key={n.id}>
                <td>
                  <b>{n.kind}</b>
                  <span className="sub">
                    {n.subject ?? n.note ?? ''}
                    {n.story_id ? (
                      <>
                        {' · '}
                        <Link href={`/admin/stories/${n.story_id}`}>story</Link>
                      </>
                    ) : null}
                  </span>
                </td>
                <td>
                  {n.destination}
                  <span className="sub">{n.workspace_name ?? 'ops'}</span>
                </td>
                <td>{fmtTime(n.created_at)}</td>
                <td>{n.error ? <span className="err">{n.error}</span> : <span className="status queued">not sent yet</span>}</td>
              </tr>
            ))}
            {!problems.length ? (
              <tr>
                <td colSpan={4} className="muted">
                  Every email went out.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
