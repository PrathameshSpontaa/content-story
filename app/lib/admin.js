// Operator views: every workspace, credit grants, the story review queue (approve, reject, merge)
// and the operations dashboard (runs, spend, margin, failed emails). Pages call these only after requireAdmin().
import { pool, tx } from './db.js';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v) => UUID.test(String(v ?? ''));

export const REVIEW_FILTERS = { all: 'All', unreviewed: 'Waiting', published: 'Published', rejected: 'Rejected', merged: 'Merged' };

// Daily spend caps and the credit rule of thumb come from the environment; defaults match LAUNCH_PLAN.md.
export const caps = () => ({
  apify: Number(process.env.APIFY_DAILY_CAP_USD) || 10,
  gemini: Number(process.env.GEMINI_DAILY_CAP_USD) || 5,
});
export const creditInr = () => Number(process.env.CREDIT_INR) || 1;
export const usdInr = () => Number(process.env.USD_INR) || 84;

export async function adminOverview() {
  const [totals, workspaces] = await Promise.all([
    pool.query(`
      select (select count(*)::int from users) as users,
             (select count(*)::int from workspaces where name not like 'billing test %') as workspaces,
             (select coalesce(sum(balance), 0)::int from credit_balances) as credits_outstanding,
             (select count(*)::int from reports where status in ('queued', 'in_progress')) as open_reports,
             (select count(*)::int from tracking_targets where active) as active_targets,
             (select count(*)::int from stories s join feeds f on f.id = s.feed_id and f.workspace_id is null
               where s.published_at is null and s.status not in ('merged', 'rejected')) as waiting_review,
             (select count(*)::int from runs where status = 'failed' and started_at > now() - interval '7 days') as failed_runs`),
    pool.query(`
      select w.id, w.name, w.created_at, b.balance::int as balance, b.held::int as held,
             (select string_agg(u.email, ', ') from memberships m join users u on u.id = m.user_id
               where m.workspace_id = w.id and m.role = 'owner') as owners,
             (select count(*)::int from tracking_targets t where t.workspace_id = w.id and t.active) as tracking,
             (select p.name from subscriptions s join plans p on p.id = s.plan_id
               where s.workspace_id = w.id and s.status in ('active', 'past_due') order by s.created_at desc limit 1) as plan
        from workspaces w
        join credit_balances b on b.workspace_id = w.id
       where w.name not like 'billing test %'
       order by w.created_at desc
       limit 200`),
  ]);
  return { totals: totals.rows[0], workspaces: workspaces.rows };
}

// ─── Review queue ───────────────────────────────────────────────────────────

const LATEST_VERSION = `join lateral (select * from story_versions v where v.story_id = s.id order by v.version desc limit 1) v on true`;
const STORY_COLUMNS = `
  s.id, s.status, s.heat, s.category, s.published_at, s.merged_into, s.created_at,
  s.review_note, s.reviewed_at, s.reviewed_by,
  coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') as headline,
  v.version, v.passed, v.created_at as version_at,
  (v.stats ->> 'sources')::int as sources,
  (v.stats ->> 'creators')::int as creators,
  (v.stats ->> 'platforms')::int as platforms,
  coalesce(jsonb_array_length(v.checks -> 'errors'), 0)::int as error_count,
  coalesce(jsonb_array_length(v.checks -> 'warnings'), 0)::int as warning_count,
  exists (select 1 from story_versions pv where pv.story_id = s.id and pv.passed) as has_passed_version,
  (select count(*)::int from merge_candidates mc where mc.resolved_at is null and (mc.story_a = s.id or mc.story_b = s.id)) as merge_candidates,
  (select count(*)::int from story_posts sp where sp.story_id = s.id) as post_count`;

// Every story in the shared feed with its newest version: unpublished first (newest run first),
// then published by heat. `filter` narrows to one state.
export async function listStoriesForReview(filter = 'all') {
  const where = {
    unreviewed: `s.published_at is null and s.status not in ('merged', 'rejected')`,
    published: 's.published_at is not null',
    rejected: `s.status = 'rejected'`,
    merged: `s.status = 'merged'`,
  }[filter];
  const { rows } = await pool.query(`
    select ${STORY_COLUMNS},
           (select u.email from users u where u.id = s.reviewed_by) as reviewed_by_email
      from stories s
      join feeds f on f.id = s.feed_id and f.workspace_id is null
      ${LATEST_VERSION}
     ${where ? `where ${where}` : ''}
     order by s.published_at is null desc, (s.published_at is null and s.status not in ('merged', 'rejected')) desc,
              case when s.published_at is null then v.created_at end desc nulls last, s.heat desc nulls last`);
  return rows;
}

// One story with everything a reviewer needs: latest version in full, version history, posts and
// merge candidates. Any feed, any state; null when the id is unknown.
export async function getStoryForReview(id) {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query(
    `select ${STORY_COLUMNS}, f.workspace_id as feed_workspace_id, f.name as feed_name,
            v.narrative, v.stats, v.written, v.platform_takes, v.feed_edit, v.checks, v.models,
            (select u.email from users u where u.id = s.reviewed_by) as reviewed_by_email,
            (select coalesce(mv.feed_edit ->> 'headline', mv.written ->> 'headline') from story_versions mv
              where mv.story_id = s.merged_into order by mv.version desc limit 1) as merged_into_headline
       from stories s
       join feeds f on f.id = s.feed_id
       ${LATEST_VERSION}
      where s.id = $1`,
    [id],
  );
  const story = rows[0];
  if (!story) return null;
  const [versions, posts, candidates] = await Promise.all([
    pool.query(
      `select id, version, created_at, passed, models,
              coalesce(jsonb_array_length(checks -> 'errors'), 0)::int as error_count,
              coalesce(jsonb_array_length(checks -> 'warnings'), 0)::int as warning_count
         from story_versions where story_id = $1 order by version desc`,
      [id],
    ),
    pool.query(
      `select p.id, p.platform, p.kind, p.url, p.published_at, p.community, left(coalesce(nullif(p.text, ''), p.transcript), 160) as snippet,
              h.handle, c.name as creator, sp.reason, sp.confidence
         from story_posts sp join posts p on p.id = sp.post_id
         left join creator_handles h on h.id = p.handle_id left join creators c on c.id = h.creator_id
        where sp.story_id = $1 order by p.published_at`,
      [id],
    ),
    pool.query(
      `select mc.reason, mc.created_at, mc.resolved_at,
              case when mc.story_a = $1 then mc.story_b else mc.story_a end as other_id,
              o.status as other_status, o.heat as other_heat, o.published_at as other_published_at,
              (select coalesce(ov.feed_edit ->> 'headline', ov.written ->> 'headline') from story_versions ov
                where ov.story_id = o.id order by ov.version desc limit 1) as other_headline,
              exists (select 1 from story_versions pv where pv.story_id = o.id and pv.passed) as other_has_passed_version
         from merge_candidates mc
         join stories o on o.id = case when mc.story_a = $1 then mc.story_b else mc.story_a end
        where mc.story_a = $1 or mc.story_b = $1
        order by mc.resolved_at is not null, mc.created_at desc`,
      [id],
    ),
  ]);
  return { ...story, versions: versions.rows, posts: posts.rows, candidates: candidates.rows };
}

const review = (client, storyId, reviewerId, note) =>
  client.query(`update stories set reviewed_at = now(), reviewed_by = $2, review_note = coalesce(nullif($3, ''), review_note) where id = $1`, [
    storyId,
    isUuid(reviewerId) ? reviewerId : null,
    String(note ?? '').trim().slice(0, 500),
  ]);

// Approve = publish. Only a story with a version that passed every check can be published, and a
// merged story never can. A rejected story that is approved again becomes active.
export async function setStoryPublished(storyId, published, { reviewerId = null, note = '' } = {}) {
  if (!isUuid(storyId)) return false;
  return tx(async (client) => {
    const { rowCount } = await client.query(
      `update stories s
          set published_at = case when $2 then coalesce(s.published_at, now()) else null end,
              status = case when $2 and s.status = 'rejected' then 'active'::story_status else s.status end
        where s.id = $1 and s.status <> 'merged'
          and (not $2 or exists (select 1 from story_versions v where v.story_id = s.id and v.passed))`,
      [storyId, published],
    );
    if (rowCount) await review(client, storyId, reviewerId, note);
    return rowCount > 0;
  });
}

export async function rejectStory(storyId, { reviewerId = null, note = '' } = {}) {
  if (!isUuid(storyId)) return false;
  return tx(async (client) => {
    const { rowCount } = await client.query(`update stories set status = 'rejected', published_at = null where id = $1 and status <> 'merged'`, [storyId]);
    if (rowCount) await review(client, storyId, reviewerId, note);
    return rowCount > 0;
  });
}

// Folds `storyId` into `targetId`: its posts move over (duplicates skipped), it leaves the feed, and
// the pair's merge candidate is resolved. Throws with a plain message when the pair can't merge.
export async function mergeStory(storyId, targetId, { reviewerId = null, note = '' } = {}) {
  if (!isUuid(storyId) || !isUuid(targetId)) throw new Error('Pick a story to merge into.');
  if (storyId === targetId) throw new Error('A story can’t be merged into itself.');
  await tx(async (client) => {
    const { rows } = await client.query(`select id, status, feed_id from stories where id = any($1::uuid[]) for update`, [[storyId, targetId]]);
    const source = rows.find((r) => r.id === storyId);
    const target = rows.find((r) => r.id === targetId);
    if (!source || !target) throw new Error('One of the stories no longer exists.');
    if (source.status === 'merged') throw new Error('This story was already merged.');
    if (['merged', 'rejected'].includes(target.status)) throw new Error('The target story is merged or rejected; pick a live one.');
    if (source.feed_id !== target.feed_id) throw new Error('Stories in different feeds can’t be merged.');
    await client.query(
      `insert into story_posts (story_id, post_id, reason, confidence, added_at)
       select $2, post_id, reason, confidence, added_at from story_posts where story_id = $1
       on conflict (story_id, post_id) do nothing`,
      [storyId, targetId],
    );
    await client.query('delete from story_posts where story_id = $1', [storyId]);
    await client.query(`update stories set status = 'merged', merged_into = $2, published_at = null where id = $1`, [storyId, targetId]);
    // Anything that pointed at the merged story now points at the target.
    await client.query(`update stories set merged_into = $2 where merged_into = $1`, [storyId, targetId]);
    await client.query(
      `update merge_candidates set resolved_at = now()
        where resolved_at is null and ((story_a = $1 and story_b = $2) or (story_a = $2 and story_b = $1))`,
      [storyId, targetId],
    );
    await review(client, storyId, reviewerId, note);
    await client.query(`update stories set reviewed_at = now(), reviewed_by = $2 where id = $1`, [targetId, isUuid(reviewerId) ? reviewerId : null]);
  });
}

// "Keep separate": the pair stays two stories and the candidate stops showing.
export async function keepSeparate(storyA, storyB) {
  if (!isUuid(storyA) || !isUuid(storyB)) return false;
  const { rowCount } = await pool.query(
    `update merge_candidates set resolved_at = now()
      where resolved_at is null and ((story_a = $1 and story_b = $2) or (story_a = $2 and story_b = $1))`,
    [storyA, storyB],
  );
  return rowCount > 0;
}

// ─── Operations ─────────────────────────────────────────────────────────────

const IST_DAY = `(created_at at time zone 'Asia/Kolkata')::date`;

// Last N runs with their cost (cost_events by run_id, else the usd the run recorded).
export async function listRuns(limit = 50) {
  const { rows } = await pool.query(
    `select r.id, r.kind, r.status, r.started_at, r.finished_at, r.error, r.summary, r.workspace_id,
            w.name as workspace_name,
            extract(epoch from coalesce(r.finished_at, now()) - r.started_at)::int as seconds,
            coalesce((select sum(c.usd) from cost_events c where c.run_id = r.id), r.usd, 0)::float as usd,
            (select count(*)::int from cost_events c where c.run_id = r.id) as cost_events
       from runs r left join workspaces w on w.id = r.workspace_id
      order by r.started_at desc
      limit $1`,
    [limit],
  );
  return rows;
}

// Spend per India-time day for the last N days, one row per day with a column per provider.
export async function costByDay(days = 14) {
  const { rows } = await pool.query(
    `select ${IST_DAY}::text as day, provider, sum(usd)::float as usd, count(*)::int as events
       from cost_events
      where created_at >= (current_date at time zone 'Asia/Kolkata') - make_interval(days => $1 - 1)
      group by 1, 2 order by 1 desc, 2`,
    [days],
  );
  const byDay = new Map();
  for (const r of rows) {
    const row = byDay.get(r.day) ?? { day: r.day, apify: 0, gemini: 0, other: 0, total: 0, events: 0 };
    row[['apify', 'gemini'].includes(r.provider) ? r.provider : 'other'] += r.usd;
    row.total += r.usd;
    row.events += r.events;
    byDay.set(r.day, row);
  }
  return [...byDay.values()];
}

// Today's spend (India time) against each provider's daily cap.
export async function spendToday() {
  const { rows } = await pool.query(
    `select provider, sum(usd)::float as usd from cost_events
      where ${IST_DAY} = (now() at time zone 'Asia/Kolkata')::date group by 1`,
  );
  const limit = caps();
  const spent = Object.fromEntries(rows.map((r) => [r.provider, r.usd]));
  return ['apify', 'gemini'].map((provider) => ({ provider, usd: spent[provider] ?? 0, cap: limit[provider], pct: Math.round(((spent[provider] ?? 0) / limit[provider]) * 100) }));
}

// Credit actions and run kinds land in the same buckets so revenue and cost line up.
const BUCKET_OF_ACTION = { report: 'reports', track_creator_day: 'tracking', track_keyword_day: 'tracking', track_community_day: 'tracking', alert: 'alerts', digest: 'alerts' };
const BUCKET_OF_RUN = { report: 'reports', daily: 'tracking', comments: 'tracking', alerts: 'alerts', digest: 'alerts', digests: 'alerts' };
const BUCKET_LABEL = { reports: 'Reports', tracking: 'Tracking (shared collection)', alerts: 'Alerts and digests', other: 'Other' };

// Margin for the last N days: credits charged (as INR by the rule of thumb) against provider cost, per bucket.
export async function marginByAction(days = 30) {
  const [charged, cost] = await Promise.all([
    pool.query(
      `select coalesce(action, 'other') as action, count(*)::int as entries, -sum(amount)::int as credits
         from credit_entries where kind = 'debit' and created_at > now() - make_interval(days => $1) group by 1`,
      [days],
    ),
    pool.query(
      `select coalesce(r.kind, 'other') as kind, sum(c.usd)::float as usd, count(*)::int as events
         from cost_events c left join runs r on r.id = c.run_id
        where c.created_at > now() - make_interval(days => $1) group by 1`,
      [days],
    ),
  ]);
  const inrPerCredit = creditInr();
  const inrPerUsd = usdInr();
  const buckets = new Map(Object.keys(BUCKET_LABEL).map((k) => [k, { bucket: k, label: BUCKET_LABEL[k], actions: [], entries: 0, credits: 0, revenueInr: 0, usd: 0, costInr: 0 }]));
  for (const r of charged.rows) {
    const b = buckets.get(BUCKET_OF_ACTION[r.action] ?? 'other');
    b.actions.push(r.action);
    b.entries += r.entries;
    b.credits += r.credits;
  }
  for (const r of cost.rows) {
    const b = buckets.get(BUCKET_OF_RUN[r.kind] ?? 'other');
    b.usd += r.usd;
  }
  const rows = [...buckets.values()]
    .map((b) => ({ ...b, revenueInr: b.credits * inrPerCredit, costInr: b.usd * inrPerUsd }))
    .map((b) => ({ ...b, marginInr: b.revenueInr - b.costInr, marginPct: b.revenueInr ? Math.round(((b.revenueInr - b.costInr) / b.revenueInr) * 100) : null }))
    .filter((b) => b.entries || b.usd);
  const total = rows.reduce(
    (t, b) => ({ credits: t.credits + b.credits, revenueInr: t.revenueInr + b.revenueInr, usd: t.usd + b.usd, costInr: t.costInr + b.costInr }),
    { credits: 0, revenueInr: 0, usd: 0, costInr: 0 },
  );
  return { days, inrPerCredit, inrPerUsd, rows, total: { ...total, marginInr: total.revenueInr - total.costInr } };
}

// Emails that never went out or failed: alerts, digests, low-credit warnings and 'ops' failure notices.
export async function listNotificationProblems(limit = 20) {
  const { rows } = await pool.query(
    `select n.id, n.kind, n.destination, n.subject, n.note, n.error, n.sent_at, n.created_at, n.story_id, w.name as workspace_name
       from notifications n left join workspaces w on w.id = n.workspace_id
      where n.sent_at is null or n.error is not null
      order by n.created_at desc limit $1`,
    [limit],
  );
  return rows;
}

// The run behind each report, matched by workspace and time: the newest 'report' run started after
// the request. Returns a map of report id to run.
export async function listReportRuns() {
  const { rows } = await pool.query(`
    select r.id as report_id, run.id as run_id, run.status, run.started_at, run.finished_at, run.error
      from reports r
      join lateral (select * from runs x where x.kind = 'report' and x.workspace_id = r.workspace_id and x.started_at >= r.created_at
                    order by x.started_at desc limit 1) run on true`);
  return Object.fromEntries(rows.map((r) => [r.report_id, r]));
}
