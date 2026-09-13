// Operator views: every workspace, credit grants and the story review queue.
// Pages call these only after requireAdmin().
import { pool } from './db.js';

export async function adminOverview() {
  const [totals, workspaces] = await Promise.all([
    pool.query(`
      select (select count(*)::int from users) as users,
             (select count(*)::int from workspaces where name not like 'billing test %') as workspaces,
             (select coalesce(sum(balance), 0)::int from credit_balances) as credits_outstanding,
             (select count(*)::int from reports where status in ('queued', 'in_progress')) as open_reports,
             (select count(*)::int from tracking_targets where active) as active_targets`),
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

// Every story in the shared feed with its newest version, published or not.
export async function listStoriesForReview() {
  const { rows } = await pool.query(`
    select s.id, s.status, s.heat, s.published_at, s.category,
           coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') as headline,
           v.passed, v.version,
           exists (select 1 from story_versions pv where pv.story_id = s.id and pv.passed) as has_passed_version
      from stories s
      join feeds f on f.id = s.feed_id and f.workspace_id is null
      join lateral (select * from story_versions v where v.story_id = s.id order by v.version desc limit 1) v on true
     order by s.published_at is null desc, s.heat desc nulls last`);
  return rows;
}

// Only a story with a version that passed every check can be published.
export async function setStoryPublished(storyId, published) {
  await pool.query(
    `update stories s set published_at = case when $2 then coalesce(s.published_at, now()) else null end
      where s.id = $1 and (not $2 or exists (select 1 from story_versions v where v.story_id = s.id and v.passed))`,
    [storyId, published],
  );
}
