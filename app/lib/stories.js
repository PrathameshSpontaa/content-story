// Story data for the web app, read from Postgres. Pages never write SQL themselves.
import { pool } from './db.js';
import { PLATFORM_NAMES, plural, truncate } from './format.js';
import { STORY_TEXT, creatorPhoto, likeEscaped, matchesWord } from './watchlist.js';

// A story leads the feed only if independent sources covered it and people reacted.
export const TOP = { minSources: 2, minComments: 10 };
export const MIN_COMMENTS_FOR_PCT = 5;
const UUID = /^[0-9a-f-]{36}$/i;

const LATEST_PASSED_VERSION = `
  join lateral (
    select * from story_versions v where v.story_id = s.id and v.passed order by v.version desc limit 1
  ) v on true`;

// Unique comments grouped under the story's posts.
const AUDIENCE = `
  (select count(distinct c.cid)::int
     from story_posts sp
     join comment_groups g on g.post_id = sp.post_id
     cross join lateral unnest(g.comment_ids) as c(cid)
    where sp.story_id = s.id)`;

// Does watchlist entry `t` match story `s` (with its latest version `v`)?
const TARGET_MATCHES_STORY = `(
  (t.kind = 'creator' and exists (
     select 1 from story_posts sp join posts po on po.id = sp.post_id join creator_handles h on h.id = po.handle_id
      where sp.story_id = s.id and h.creator_id = t.creator_id))
  or (t.kind = 'community' and exists (
     select 1 from story_posts sp join posts po on po.id = sp.post_id
      where sp.story_id = s.id and lower(po.community) = lower(t.query)))
  or (t.kind = 'keyword' and ${matchesWord(STORY_TEXT, 't.query')})
)`;

export function whyNotTop({ sources, creators, audience }) {
  if ((sources ?? creators ?? 0) < TOP.minSources) return 'one source';
  if (!audience) return 'no comments collected';
  if (audience < TOP.minComments) return 'few comments';
  return '';
}

// Following nobody means no stories, even ones built before everything was unfollowed ($1 is the workspace).
const FOLLOWS_SOMEONE = `exists (select 1 from tracking_targets ft where ft.workspace_id = $1 and ft.active)`;

// A workspace's own stories: the ones built from what it follows (any scope but 'saved'), or the ones it
// saved from any of its feeds (scope 'saved'), optionally narrowed to one follow, a category, a platform
// or a search. `tracked` names the follows each story involves. Stories are never shared between
// workspaces, so without a workspace there are none.
export async function getFeed({ workspaceId = null, scope = 'following', category = '', platform = '', q = '', followTargetId = '' } = {}) {
  if (!UUID.test(String(workspaceId ?? ''))) return [];
  const params = [workspaceId];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['s.published_at is not null', `s.status not in ('merged', 'rejected')`];
  if (category) where.push(`s.category = ${param(category)}`);
  if (platform) {
    where.push(`exists (select 1 from story_posts sp join posts po on po.id = sp.post_id where sp.story_id = s.id and po.platform::text = ${param(platform)})`);
  }
  if (q) {
    where.push(`concat_ws(' ', v.feed_edit ->> 'headline', v.feed_edit ->> 'dek', v.written ->> 'headline', v.narrative #>> '{main_character,name}', s.category,
                          jsonb_path_query_array(v.written, '$.narrative[*].sentence')::text) ilike ${likeEscaped(param(q))}`);
  }
  if (scope === 'saved') where.push('exists (select 1 from saved_stories ss where ss.story_id = s.id and ss.workspace_id = $1)');
  else where.push(`f.kind = 'following' and ${FOLLOWS_SOMEONE}`);
  if (followTargetId && /^[0-9a-f-]{36}$/i.test(followTargetId)) {
    where.push(`exists (select 1 from tracking_targets t where t.workspace_id = $1 and t.id = ${param(followTargetId)}::uuid and ${TARGET_MATCHES_STORY})`);
  }

  const { rows } = await pool.query(
    `select s.id, s.category, s.heat, s.first_post_at, s.last_post_at,
            v.narrative #>> '{main_character,name}' as main_character,
            coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') as headline,
            v.feed_edit ->> 'dek' as dek,
            coalesce(v.feed_edit -> 'platform_strip', '[]'::jsonb) as platform_strip,
            (v.stats ->> 'creators')::int as creators,
            (v.stats ->> 'sources')::int as sources,
            (v.stats ->> 'platforms')::int as platforms,
            ${AUDIENCE} as audience,
            array(select distinct cr.name
                    from story_posts sp join posts po on po.id = sp.post_id
                    join creator_handles h on h.id = po.handle_id join creators cr on cr.id = h.creator_id
                   where sp.story_id = s.id) as creator_names,
            array(select distinct coalesce(c.name, t.query)
                    from tracking_targets t left join creators c on c.id = t.creator_id
                   where t.workspace_id = $1::uuid and t.active and ${TARGET_MATCHES_STORY}) as tracked,
            exists (select 1 from saved_stories ss where ss.story_id = s.id and ss.workspace_id = $1::uuid) as saved
       from stories s
       join feeds f on f.id = s.feed_id and f.workspace_id = $1::uuid
       ${LATEST_PASSED_VERSION}
      where ${where.join(' and ')}
      order by s.heat desc nulls last`,
    params,
  );
  return rows.map((r) => ({ ...r, whyNotTop: whyNotTop(r) }));
}

// Story counts for the tabs: the workspace's own stories and the ones it saved. `total` equals
// `for_you`, for callers that still read it.
export async function getFeedCounts(workspaceId) {
  const { rows } = await pool.query(
    `select count(*) filter (where f.kind = 'following' and ${FOLLOWS_SOMEONE})::int as for_you,
            count(*) filter (where exists (select 1 from saved_stories ss where ss.story_id = s.id and ss.workspace_id = $1))::int as saved
       from stories s
       join feeds f on f.id = s.feed_id and f.workspace_id = $1
       ${LATEST_PASSED_VERSION}
      where s.published_at is not null and s.status not in ('merged', 'rejected')`,
    [workspaceId],
  );
  return { ...rows[0], total: rows[0].for_you };
}

// Recent posts from the creators a workspace follows that aren't in one of its stories: an opinion, a
// personal update, or a post nobody else covered. Each comes with its summary and the biggest groups of
// what commenters said. `creatorId` narrows to one creator.
export async function getFollowedPosts(workspaceId, { platform = '', q = '', creatorId = '', days = 7, limit = 40 } = {}) {
  if (!UUID.test(String(workspaceId ?? ''))) return [];
  const params = [workspaceId, days, limit];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [];
  if (platform) where.push(`p.platform::text = ${param(platform)}`);
  if (UUID.test(String(creatorId ?? ''))) where.push(`c.id = ${param(creatorId)}::uuid`);
  if (q) where.push(`concat_ws(' ', c.name, h.handle, sc.about, p.text) ilike ${likeEscaped(param(q))}`);
  const { rows } = await pool.query(
    `select p.id, p.platform::text as platform, p.kind, p.url, p.published_at, left(coalesce(nullif(p.text, ''), p.transcript, ''), 400) as text,
            c.id as creator_id, c.name as creator, h.handle, ${creatorPhoto('c.id')} as photo,
            sc.about, sc.type,
            m.likes::float as likes, m.comments::float as comments, m.views::float as views,
            coalesce((select json_agg(json_build_object('label', g.label, 'point', g.point, 'size', cardinality(g.comment_ids)) order by cardinality(g.comment_ids) desc)
                        from comment_groups g where g.post_id = p.id), '[]'::json) as reactions
       from posts p
       join creator_handles h on h.id = p.handle_id
       join creators c on c.id = h.creator_id
       left join story_cards sc on sc.post_id = p.id
       left join lateral (select likes, comments, views from post_metrics pm where pm.post_id = p.id order by pm.captured_at desc limit 1) m on true
      where p.published_at > now() - make_interval(days => $2)
        and exists (select 1 from tracking_targets t where t.workspace_id = $1 and t.active and t.kind = 'creator' and t.creator_id = c.id and p.platform = any(t.platforms))
        and not exists (select 1 from story_posts sp join stories s on s.id = sp.story_id join feeds f on f.id = s.feed_id and f.workspace_id = $1
                         where sp.post_id = p.id and s.published_at is not null and s.status not in ('merged', 'rejected'))
        ${where.map((w) => `and ${w}`).join(' ')}
      order by p.published_at desc
      limit $3`,
    params,
  );
  return rows.map((r) => ({ ...r, reactions: (r.reactions ?? []).slice(0, 2) }));
}

export async function getTotals() {
  const { rows } = await pool.query(`
    select (select count(*)::int from posts) as posts,
           (select count(*)::int from comments) as comments,
           (select min(published_at) from posts) as first_post_at,
           (select max(published_at) from posts) as last_post_at`);
  return rows[0];
}

// The workspace whose page is being rendered, so a workspace can open a finished report's story.
// Only the story page (a request) reaches this; scripts and tests have no session and get null.
async function callerWorkspaceId() {
  try {
    const { getSession } = await import('./session.js');
    return (await getSession())?.workspace?.id ?? null;
  } catch {
    return null;
  }
}

// A published story from one of the caller's own feeds: its stories or a finished report. Another
// workspace's story is not found. `workspaceId` names the caller; when omitted it is read from the session.
export async function getStory(id, workspaceId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const callerId = workspaceId === undefined ? await callerWorkspaceId() : workspaceId;
  const { rows } = await pool.query(
    `select s.id, s.category, s.heat, s.first_post_at, s.last_post_at,
            v.version, v.narrative, v.stats, v.written, v.platform_takes, v.feed_edit, v.checks,
            ${AUDIENCE} as audience
       from stories s
       join feeds f on f.id = s.feed_id
       ${LATEST_PASSED_VERSION}
      where s.id = $1 and s.published_at is not null
        and f.workspace_id = $2::uuid`,
    [id, /^[0-9a-f-]{36}$/i.test(String(callerId ?? '')) ? callerId : null],
  );
  const story = rows[0];
  if (!story) return null;

  const [posts, groups, claims, comments] = await Promise.all([
    pool.query(
      `select p.id, p.platform, p.kind, p.url, p.text, p.transcript, p.published_at, p.community,
              h.handle, c.id as creator_id, c.name as creator
         from story_posts sp
         join posts p on p.id = sp.post_id
         left join creator_handles h on h.id = p.handle_id
         left join creators c on c.id = h.creator_id
        where sp.story_id = $1`,
      [id],
    ),
    pool.query(`select g.id, g.post_id, g.label, g.comment_ids from story_posts sp join comment_groups g on g.post_id = sp.post_id where sp.story_id = $1`, [id]),
    pool.query(`select k.id, k.post_id, k.text, k.quote from story_posts sp join claims k on k.post_id = sp.post_id where sp.story_id = $1`, [id]),
    pool.query(`select cm.id, cm.post_id, cm.author, cm.likes, cm.text, cm.url from story_posts sp join comments cm on cm.post_id = sp.post_id where sp.story_id = $1`, [id]),
  ]);

  return {
    ...story,
    sources: describeSources(posts.rows, groups.rows, claims.rows, comments.rows),
    platforms: platformNumbers(story, posts.rows, groups.rows),
  };
}

// What this workspace has to do with a story: saved or not, and which watchlist entries it involves.
export async function getStoryContext(storyId, workspaceId) {
  const { rows } = await pool.query(
    `select exists (select 1 from saved_stories ss where ss.story_id = s.id and ss.workspace_id = $2) as saved,
            array(select distinct coalesce(c.name, t.query)
                    from tracking_targets t left join creators c on c.id = t.creator_id
                   where t.workspace_id = $2 and t.active and ${TARGET_MATCHES_STORY}) as tracked
       from stories s
       ${LATEST_PASSED_VERSION}
      where s.id = $1`,
    [storyId, workspaceId],
  );
  return rows[0] ?? { saved: false, tracked: [] };
}

export async function toggleSaved(workspaceId, userId, storyId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(storyId))) return false;
  const removed = await pool.query('delete from saved_stories where workspace_id = $1 and story_id = $2', [workspaceId, storyId]);
  if (removed.rowCount) return false;
  await pool.query(
    `insert into saved_stories (workspace_id, story_id, saved_by)
     select $1, s.id, $3 from stories s join feeds f on f.id = s.feed_id and f.workspace_id = $1
      where s.id = $2 and s.published_at is not null
     on conflict do nothing`,
    [workspaceId, storyId, userId],
  );
  return true;
}

const handleOf = (post) => post?.handle ?? post?.community ?? '';

// Everything a citation can point to, keyed by ID: who said it, where, and a snippet.
function describeSources(posts, groups, claims, comments) {
  const postById = new Map(posts.map((p) => [p.id, p]));
  const out = {};
  for (const p of posts) {
    out[p.id] = { who: `${PLATFORM_NAMES[p.platform]} · ${handleOf(p)} · ${p.kind}`, url: p.url, text: truncate(p.text || p.transcript, 240), platform: p.platform, creatorId: p.creator_id };
  }
  for (const c of comments) {
    const p = postById.get(c.post_id);
    out[c.id] = { who: `${PLATFORM_NAMES[p?.platform] ?? ''} · comment by ${c.author} · ${plural(Number(c.likes), 'like')}`, url: c.url || p?.url, text: truncate(c.text, 240), platform: p?.platform };
  }
  for (const g of groups) {
    const p = postById.get(g.post_id);
    out[g.id] = { who: `${PLATFORM_NAMES[p?.platform] ?? ''} · ${plural(g.comment_ids.length, 'comment')} under ${handleOf(p)}`, url: p?.url, text: g.label, platform: p?.platform };
  }
  for (const k of claims) {
    const p = postById.get(k.post_id);
    out[k.id] = { who: `${PLATFORM_NAMES[p?.platform] ?? ''} · ${handleOf(p)} · ${p?.kind}`, url: p?.url, text: k.quote ? `“${k.quote}”` : k.text, platform: p?.platform, creatorId: p?.creator_id };
  }
  return out;
}

// Per-platform counts for the "What each platform is saying" cards.
function platformNumbers(story, posts, groups) {
  const out = {};
  for (const p of posts) {
    const row = (out[p.platform] ??= { posts: 0, commentsGrouped: 0, creators: new Set() });
    row.posts += 1;
    row.creators.add(p.creator ? `${p.creator} (${p.handle})` : p.community);
  }
  const platformOfPost = new Map(posts.map((p) => [p.id, p.platform]));
  for (const g of groups) {
    const row = out[platformOfPost.get(g.post_id)];
    if (row) row.commentsGrouped += g.comment_ids.length;
  }
  for (const [platform, row] of Object.entries(out)) {
    row.creators = [...row.creators].filter(Boolean);
    row.angleAgreement = (story.stats.angle_reactions ?? [])
      .map((a) => {
        const b = a.by_platform.find((x) => x.platform === platform);
        return b ? { angleIndex: a.angle_index, agreePct: b.agree_pct, comments: b.comments, asks: b.asks } : null;
      })
      .filter(Boolean);
  }
  return out;
}
