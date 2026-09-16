// One row in runs per job execution: what kind, for which workspace (reports), how it ended,
// a summary of what it did, and what it cost us (summed from cost_events tagged with the run).
import { pool } from './db.js';

export async function startRun(kind, { workspaceId = null } = {}) {
  const { rows } = await pool.query(`insert into runs (kind, workspace_id) values ($1, $2) returning id`, [kind, workspaceId]);
  return rows[0].id;
}

export async function finishRun(id, { status = 'done', error = null, summary = null } = {}) {
  const { rows } = await pool.query(
    `update runs
        set status = $2,
            error = $3,
            summary = $4::jsonb,
            finished_at = now(),
            usd = (select coalesce(sum(c.usd), 0) from cost_events c where c.run_id = runs.id)
      where id = $1
      returning id, kind, status, usd::float, started_at, finished_at`,
    [id, status, error ? String(error.message ?? error).slice(0, 2000) : null, summary == null ? null : JSON.stringify(summary)],
  );
  return rows[0] ?? null;
}

export async function listRuns({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `select r.id, r.kind, r.workspace_id, w.name as workspace_name, r.status, r.error, r.summary, r.usd::float,
            r.started_at, r.finished_at,
            extract(epoch from (coalesce(r.finished_at, now()) - r.started_at))::int as seconds
       from runs r left join workspaces w on w.id = r.workspace_id
      order by r.started_at desc
      limit $1`,
    [limit],
  );
  return rows;
}
