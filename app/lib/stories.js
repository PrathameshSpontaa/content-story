// Story data for the web app, read from Postgres. Pages never write SQL themselves.
import { pool } from './db.js';
import { PLATFORM_NAMES, plural, truncate } from './format.js';

// A story leads the feed only if independent sources covered it and people reacted.
export const TOP = { minSources: 2, minComments: 10 };
export const MIN_COMMENTS_FOR_PCT = 5;

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

export function whyNotTop({ sources, creators, audience }) {
  if ((sources ?? creators ?? 0) < TOP.minSources) return 'one source';
  if (!audience) return 'no comments collected';
  if (audience < TOP.minComments) return 'few comments';
  return '';
}

export async function getSharedFeed() {
  const { rows } = await pool.query(`
    select s.id, s.category, s.heat, s.first_post_at, s.last_post_at,
           v.narrative #>> '{main_character,name}' as main_character,
           coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') as headline,
           v.feed_edit ->> 'dek' as dek,
           coalesce(v.feed_edit -> 'platform_strip', '[]'::jsonb) as platform_strip,
           (v.stats ->> 'creators')::int as creators,
           (v.stats ->> 'sources')::int as sources,
           (v.stats ->> 'platforms')::int as platforms,
           ${AUDIENCE} as audience
      from stories s
      join feeds f on f.id = s.feed_id and f.workspace_id is null
      ${LATEST_PASSED_VERSION}
     where s.published_at is not null and s.status not in ('merged', 'rejected')
     order by s.heat desc nulls last`);
  return rows.map((r) => ({ ...r, whyNotTop: whyNotTop(r) }));
}

export async function getTotals() {
  const { rows } = await pool.query(`
    select (select count(*)::int from posts) as posts,
           (select count(*)::int from comments) as comments,
           (select min(published_at) from posts) as first_post_at,
           (select max(published_at) from posts) as last_post_at`);
  return rows[0];
}

export async function getStory(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await pool.query(
    `select s.id, s.category, s.heat, s.first_post_at, s.last_post_at,
            v.version, v.narrative, v.stats, v.written, v.platform_takes, v.feed_edit, v.checks,
            ${AUDIENCE} as audience
       from stories s
       ${LATEST_PASSED_VERSION}
      where s.id = $1 and s.published_at is not null`,
    [id],
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
