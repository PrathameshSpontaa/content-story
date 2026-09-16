// Operator settings stored in app_settings, with defaults for anything never saved.
// The worker, the pipeline and the admin panel all read them through getSettings().
import { pool } from './db.js';

// Every setting, its default and its allowed range. Values outside the range are rejected on save.
export const SETTINGS = {
  refresh_every_hours: { def: 24, type: 'int', choices: [1, 2, 3, 4, 6, 8, 12, 24], label: 'Collect every' },
  refresh_start_hour_ist: { def: 6, type: 'int', min: 0, max: 23, label: 'First run of the day (IST hour)' },
  digest_hour_ist: { def: 8, type: 'int', min: 0, max: 23, label: 'Digest emails go out at (IST hour)' },
  auto_publish: { def: true, type: 'bool', label: 'AI publishes stories that pass checks' },
  auto_merge: { def: true, type: 'bool', label: 'AI merges stories it judges to be the same' },
  merge_min_confidence: { def: 0.7, type: 'num', min: 0.5, max: 1, label: 'Merge only when the AI is at least this sure' },
  on_demand_enabled: { def: true, type: 'bool', label: 'Users can refresh on demand' },
  on_demand_cooldown_minutes: { def: 30, type: 'int', min: 5, max: 1440, label: 'Minutes between refreshes per workspace' },
  on_demand_max_per_day: { def: 6, type: 'int', min: 1, max: 48, label: 'Refreshes per workspace per day' },
};

export const DEFAULTS = Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.def]));

// Turns a submitted value into the setting's type, or throws with a plain message.
export function coerce(key, raw) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`Unknown setting ${key}.`);
  if (spec.type === 'bool') return raw === true || raw === 'true' || raw === 'on' || raw === '1';
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${spec.label}: enter a number.`);
  const value = spec.type === 'int' ? Math.round(n) : n;
  if (spec.choices && !spec.choices.includes(value)) throw new Error(`${spec.label}: choose one of ${spec.choices.join(', ')}.`);
  if (spec.min != null && value < spec.min) throw new Error(`${spec.label}: at least ${spec.min}.`);
  if (spec.max != null && value > spec.max) throw new Error(`${spec.label}: at most ${spec.max}.`);
  return value;
}

export async function getSettings(client = pool) {
  const { rows } = await client.query('select key, value from app_settings');
  const saved = Object.fromEntries(rows.filter((r) => SETTINGS[r.key]).map((r) => [r.key, r.value]));
  return { ...DEFAULTS, ...saved };
}

// Saves the given keys only. Returns the full settings after the save.
export async function saveSettings(patch, { userId = null } = {}) {
  const entries = Object.entries(patch).map(([key, raw]) => [key, coerce(key, raw)]);
  for (const [key, value] of entries) {
    await pool.query(
      `insert into app_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
       on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [key, JSON.stringify(value), userId],
    );
  }
  return getSettings();
}

// The IST hours collection runs at, from the start hour and the interval: every 6 hours from 06:00
// gives 0, 6, 12, 18. Used for the worker's cron line and shown in the panel.
export function refreshHours({ refresh_every_hours: every, refresh_start_hour_ist: start }) {
  const hours = new Set();
  for (let h = start; hours.size < Math.ceil(24 / every); h += every) hours.add(((h % 24) + 24) % 24);
  return [...hours].sort((a, b) => a - b);
}

export const refreshCron = (settings) => `0 ${refreshHours(settings).join(',')} * * *`;

// A scheduled run collects a source again only if it wasn't collected within most of the interval.
export const collectMinHours = (settings) => Math.max(0.5, settings.refresh_every_hours - 0.5);
