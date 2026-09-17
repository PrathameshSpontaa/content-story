// Operator settings: when collection runs and what it costs, whether the AI publishes and merges
// stories on its own, and the limits on users' on-demand refreshes.
import Link from 'next/link';
import { PROVIDER_LABEL, spendToday } from '../../../../../lib/admin.js';
import { fmtTime } from '../../../../../lib/format.js';
import { scheduleSummary } from '../../../../../lib/refresh.js';
import { SETTINGS, getSettings } from '../../../../../lib/settings.js';
import { requireAdmin } from '../../../../../lib/session.js';
import ActionForm from '../../../components/action-form.js';
import { runCollectionAction, saveOnDemandAction, saveReviewAction, saveTimingAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin settings' };

function AdminNav({ current }) {
  return (
    <nav className="tabs admin-tabs" aria-label="Admin pages">
      <Link href="/admin" className={current === 'admin' ? 'on' : undefined}>
        Review and reports
      </Link>
      <Link href="/admin/runs" className={current === 'runs' ? 'on' : undefined}>
        Runs and spend
      </Link>
      <Link href="/admin/settings" className={current === 'settings' ? 'on' : undefined}>
        Settings
      </Link>
    </nav>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const clock = (h) => `${String(h).padStart(2, '0')}:00`;
const usd = (n) => `$${Number(n || 0).toFixed(n && n < 1 ? 3 : 2)}`;
const everyLabel = (h) => (h === 1 ? '1 hour' : h === 24 ? '24 hours (once a day)' : `${h} hours`);
const listAnd = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const CONFIDENCE = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];

function runTimes({ hoursIst, everyHours }) {
  if (!hoursIst?.length) return 'No run times set.';
  if (everyHours === 1) return 'Runs every hour, on the hour (IST).';
  if (hoursIst.length === 1) return `Runs once a day at ${clock(hoursIst[0])} IST.`;
  return `Runs at ${listAnd(hoursIst.map(clock))} IST.`;
}

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [settings, schedule, today] = await Promise.all([getSettings(), scheduleSummary(), spendToday()]);
  const confidenceChoices = [...new Set([...CONFIDENCE, Number(settings.merge_min_confidence)])].sort((a, b) => a - b);
  const last = schedule.lastRun;
  const hasEstimate = last && schedule.estUsdPerDay != null && Number.isFinite(Number(schedule.estUsdPerDay));

  return (
    <div className="page wide">
      <header className="pagehead">
        <h1>Settings</h1>
        <p className="dek">When collection runs, whether the AI publishes and merges stories on its own, and how often people can refresh.</p>
      </header>
      <AdminNav current="settings" />

      <div className="split">
        <div className="stack">
          <section className="panel" aria-labelledby="timing-h">
            <h2 id="timing-h">Collection timing</h2>
            <p className="muted-note">
              Shorter intervals collect more often and raise Apify and AI spend. Customers are still charged tracking credits once a day.
            </p>
            <ActionForm action={saveTimingAction} submitLabel="Save timing" resetOnSuccess={false} className="topgap">
              <div className="field-row">
                <label className="field">
                  <span>{SETTINGS.refresh_every_hours.label}</span>
                  <select name="refresh_every_hours" defaultValue={String(settings.refresh_every_hours)}>
                    {SETTINGS.refresh_every_hours.choices.map((h) => (
                      <option key={h} value={h}>
                        {everyLabel(h)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    First run of the day <small>IST</small>
                  </span>
                  <select name="refresh_start_hour_ist" defaultValue={String(settings.refresh_start_hour_ist)}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {clock(h)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>
                  Digest emails at <small>IST</small>
                </span>
                <select name="digest_hour_ist" defaultValue={String(settings.digest_hour_ist)}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {clock(h)}
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>

            <dl className="details schedule">
              <div className="details-row">
                <dt>Schedule</dt>
                <dd>
                  {runTimes(schedule)} Digests go out at {clock(schedule.digestHourIst)} IST.
                </dd>
              </div>
              <div className="details-row">
                <dt>Next run</dt>
                <dd>{schedule.nextRunAt ? fmtTime(schedule.nextRunAt) : 'Not scheduled'}</dd>
              </div>
              <div className="details-row">
                <dt>Last run</dt>
                <dd>
                  {last ? (
                    <>
                      {fmtTime(last.startedAt)} · <span className={`status ${last.status === 'failed' ? 'failed' : last.status === 'running' ? 'queued' : last.status === 'done' ? 'ready' : ''}`}>{last.status}</span> ·{' '}
                      {last.usd != null ? usd(last.usd) : 'cost not recorded'}
                    </>
                  ) : (
                    'No runs yet'
                  )}
                </dd>
              </div>
              <div className="details-row">
                <dt>Cost</dt>
                <dd>{hasEstimate ? `About ${usd(schedule.estUsdPerDay)} a day at this timing, from the last 7 days.` : 'No runs yet, so no cost estimate.'}</dd>
              </div>
              <div className="details-row">
                <dt>Daily caps</dt>
                <dd>
                  {today.map((t, i) => (
                    <span key={t.provider}>
                      {i ? ' · ' : ''}
                      {PROVIDER_LABEL[t.provider]} {usd(t.usd)} of {usd(t.cap)} today
                    </span>
                  ))}
                  <span className="sub">Set by {today.map((t) => `${t.provider.toUpperCase()}_DAILY_CAP_USD`).join(' and ')}.</span>
                </dd>
              </div>
            </dl>
            <p className="hint">Changes apply within a minute while the worker is running.</p>

            <ActionForm action={runCollectionAction} submitLabel="Run collection now" pendingLabel="Queuing…" variant="ghost" resetOnSuccess={false} className="topgap">
              <p className="muted-note">Collects every tracked source and rebuilds stories now, outside the schedule. It counts toward today’s caps.</p>
            </ActionForm>
          </section>
        </div>

        <div className="stack">
          <section className="panel" aria-labelledby="review-h">
            <h2 id="review-h">AI review</h2>
            <ActionForm action={saveReviewAction} submitLabel="Save AI review" resetOnSuccess={false}>
              <div className="setting">
                <label className="check">
                  <input type="checkbox" name="auto_publish" defaultChecked={Boolean(settings.auto_publish)} />
                  <span>AI publishes stories that pass checks</span>
                </label>
                <p className="setting-note">Off: new stories wait for you in the review queue.</p>
              </div>
              <div className="setting">
                <label className="check">
                  <input type="checkbox" name="auto_merge" defaultChecked={Boolean(settings.auto_merge)} />
                  <span>AI merges duplicate stories</span>
                </label>
                <p className="setting-note">Off: possible duplicates are flagged for you instead.</p>
              </div>
              <label className="field">
                <span>Merge only when the AI is at least</span>
                <select name="merge_min_confidence" defaultValue={String(Number(settings.merge_min_confidence))}>
                  {confidenceChoices.map((c) => (
                    <option key={c} value={c}>
                      {Math.round(c * 100)}% sure
                    </option>
                  ))}
                </select>
              </label>
              <p className="setting-note flush">Pairs it is less sure about show under Unsure merges in the review queue.</p>
            </ActionForm>
          </section>

          <section className="panel" aria-labelledby="ondemand-h">
            <h2 id="ondemand-h">On-demand refresh</h2>
            <ActionForm action={saveOnDemandAction} submitLabel="Save refresh limits" resetOnSuccess={false}>
              <div className="setting">
                <label className="check">
                  <input type="checkbox" name="on_demand_enabled" defaultChecked={Boolean(settings.on_demand_enabled)} />
                  <span>Users can refresh on demand</span>
                </label>
                <p className="setting-note">Off: the Refresh button is hidden and stories update on the schedule only.</p>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>
                    Cooldown <small>minutes</small>
                  </span>
                  <input
                    type="number"
                    name="on_demand_cooldown_minutes"
                    min={SETTINGS.on_demand_cooldown_minutes.min}
                    max={SETTINGS.on_demand_cooldown_minutes.max}
                    step={1}
                    defaultValue={settings.on_demand_cooldown_minutes}
                    required
                  />
                </label>
                <label className="field">
                  <span>
                    Refreshes per day <small>per workspace</small>
                  </span>
                  <input
                    type="number"
                    name="on_demand_max_per_day"
                    min={SETTINGS.on_demand_max_per_day.min}
                    max={SETTINGS.on_demand_max_per_day.max}
                    step={1}
                    defaultValue={settings.on_demand_max_per_day}
                    required
                  />
                </label>
              </div>
            </ActionForm>
          </section>
        </div>
      </div>
    </div>
  );
}
