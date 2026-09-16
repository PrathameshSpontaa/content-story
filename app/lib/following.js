// The Following page's numbers. For each creator and subreddit: posts in the latest collected week,
// the likes, comments and shares they got (interactions), views where the platform reports them,
// and the change from the week before. For brands and topics: the stories and posts that mention
// them as a whole word.
import { pool } from './db.js';
import { PLATFORM_NAMES } from './format.js';
import { STORY_TEXT, creatorPhoto, likeEscaped, matchesWord } from './watchlist.js';

const PLATFORM_ORDER_SQL = `array['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit']::platform[]`;
const PLATFORM_ORDER = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];

// The week is the last 7 days up to now, whatever was collected when.
const BOUNDS = `bounds as (select now() as week_end)`;
const LATEST_METRICS = `latest as (
  select distinct on (m.post_id) m.post_id, coalesce(m.likes, 0) + coalesce(m.comments, 0) + coalesce(m.shares, 0) as interactions, m.views
    from post_metrics m
   order by m.post_id, m.captured_at desc)`;
const LIVE_STORY = `s.published_at is not null and s.status not in ('merged', 'rejected')`;
const SHARED_FEED = `join feeds f on f.id = s.feed_id and f.workspace_id is null`;
const LATEST_PASSED = `join lateral (select * from story_versions v where v.story_id = s.id and v.passed order by v.version desc limit 1) v on true`;
const HEADLINE = `coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline')`;
const DAYS_AGO = `floor(extract(epoch from b.week_end - p.published_at) / 86400)::int`;

// Percent change from the week before; null when there was nothing that week to compare with.
const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const dayIndex = (daysAgo) => 6 - Math.min(6, Math.max(0, daysAgo));
const byPlatform = (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform);
const lower = (names) => names.map((n) => String(n).toLowerCase());

export const EMPTY_STATS = Object.freeze({ posts: 0, interactions: 0, views: null, change: null, daily: [0, 0, 0, 0, 0, 0, 0], channels: [], storyCount: 0, stories: [] });
const EMPTY_KEYWORD = Object.freeze({ mentions: 0, change: null, daily: [0, 0, 0, 0, 0, 0, 0], channels: [], storyCount: 0, stories: [] });

async function storyTotal() {
  const { rows } = await pool.query(`select count(*)::int as n from stories s ${SHARED_FEED} ${LATEST_PASSED} where ${LIVE_STORY}`);
  return rows[0].n;
}

// Numbers for creators (by id) and subreddits (by name), keyed by creator id or lower-case subreddit.
export async function getSourceStats({ creatorIds = [], communities = [] }) {
  if (!creatorIds.length && !communities.length) return new Map();
  const params = [creatorIds, lower(communities)];
  const [activity, stories] = await Promise.all([
    pool.query(
      `with ${BOUNDS}, ${LATEST_METRICS}
       select h.creator_id::text as creator_id, lower(p.community) as community, p.platform,
              p.published_at > b.week_end - interval '7 days' as this_week, ${DAYS_AGO} as days_ago,
              count(*)::int as posts, coalesce(sum(l.interactions), 0)::float8 as interactions, sum(l.views)::float8 as views
         from posts p
         cross join bounds b
         left join creator_handles h on h.id = p.handle_id
         left join latest l on l.post_id = p.id
        where p.published_at > b.week_end - interval '14 days'
          and (h.creator_id = any($1::uuid[]) or lower(p.community) = any($2::text[]))
        group by 1, 2, 3, 4, 5`,
      params,
    ),
    // Every live story each source is in, newest first, with the channels they were part of it on.
    pool.query(
      `select x.key, s.id, ${HEADLINE} as headline, v.feed_edit ->> 'dek' as dek, s.category, s.heat, s.first_post_at, s.last_post_at, x.platforms
         from (select h.creator_id::text as key, sp.story_id, array_agg(distinct p.platform::text) as platforms
                 from story_posts sp join posts p on p.id = sp.post_id join creator_handles h on h.id = p.handle_id
                where h.creator_id = any($1::uuid[])
                group by 1, 2
               union all
               select lower(p.community), sp.story_id, array_agg(distinct p.platform::text)
                 from story_posts sp join posts p on p.id = sp.post_id
                where lower(p.community) = any($2::text[])
                group by 1, 2) x
         join stories s on s.id = x.story_id and ${LIVE_STORY}
         ${SHARED_FEED}
         ${LATEST_PASSED}
        order by s.last_post_at desc nulls last, s.heat desc nulls last`,
      params,
    ),
  ]);

  const acc = new Map();
  const entry = (key) => {
    if (!acc.has(key)) acc.set(key, { daily: [0, 0, 0, 0, 0, 0, 0], channels: new Map(), stories: [] });
    return acc.get(key);
  };
  for (const r of activity.rows) {
    const e = entry(r.creator_id ?? r.community);
    if (!e.channels.has(r.platform)) e.channels.set(r.platform, { platform: r.platform, posts: 0, interactions: 0, views: null, before: 0 });
    const ch = e.channels.get(r.platform);
    if (r.this_week) {
      ch.posts += r.posts;
      ch.interactions += r.interactions;
      if (r.views != null) ch.views = (ch.views ?? 0) + r.views;
      e.daily[dayIndex(r.days_ago)] += r.interactions;
    } else {
      ch.before += r.interactions;
    }
  }
  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  for (const r of stories.rows) {
    entry(r.key).stories.push({
      id: r.id,
      headline: r.headline,
      dek: r.dek,
      category: r.category,
      heat: r.heat,
      first_post_at: iso(r.first_post_at),
      last_post_at: iso(r.last_post_at),
      platforms: (r.platforms ?? []).sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b)),
    });
  }

  const out = new Map();
  for (const [key, e] of acc) {
    const raw = [...e.channels.values()].sort(byPlatform);
    const sum = (field) => raw.reduce((total, c) => total + (c[field] ?? 0), 0);
    out.set(key, {
      posts: sum('posts'),
      interactions: sum('interactions'),
      views: raw.some((c) => c.views != null) ? sum('views') : null,
      change: change(sum('interactions'), sum('before')),
      daily: e.daily,
      channels: raw.map((c) => ({ platform: c.platform, posts: c.posts, interactions: c.interactions, views: c.views, change: change(c.interactions, c.before) })),
      storyCount: e.stories.length,
      stories: e.stories.slice(0, 8),
    });
  }
  return out;
}

// Every channel a source posts on appears in its breakdown, including quiet ones.
function withChannels(stats, platforms) {
  const s = stats ?? EMPTY_STATS;
  return { ...s, channels: platforms.map((p) => s.channels.find((c) => c.platform === p) ?? { platform: p, posts: 0, interactions: 0, views: null, change: null }) };
}

// Stories and posts in the latest week that mention each brand or topic as a whole word.
export async function getKeywordStats(names) {
  const words = [...new Map(names.map((n) => String(n).trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
  if (!words.length) return new Map();
  const POST_TEXT = `(p.text || ' ' || p.transcript)`;
  const [stories, mentions] = await Promise.all([
    // Newest first, with the platforms whose posts in the story mention the word.
    pool.query(
      `select w.name, s.id, ${HEADLINE} as headline, v.feed_edit ->> 'dek' as dek, s.category, s.heat, s.first_post_at, s.last_post_at,
              array(select distinct p.platform::text from story_posts sp join posts p on p.id = sp.post_id
                     where sp.story_id = s.id and ${matchesWord(POST_TEXT, 'w.name')}) as platforms
         from unnest($1::text[]) as w(name)
         join stories s on ${LIVE_STORY}
         ${SHARED_FEED}
         ${LATEST_PASSED}
        where ${matchesWord(STORY_TEXT, 'w.name')}
        order by s.last_post_at desc nulls last, s.heat desc nulls last`,
      [words],
    ),
    pool.query(
      `with ${BOUNDS}
       select w.name, p.platform, p.published_at > b.week_end - interval '7 days' as this_week, ${DAYS_AGO} as days_ago, count(*)::int as posts
         from unnest($1::text[]) as w(name)
         cross join bounds b
         join posts p on p.published_at > b.week_end - interval '14 days'
        where ${matchesWord(POST_TEXT, 'w.name')}
        group by 1, 2, 3, 4`,
      [words],
    ),
  ]);
  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  const acc = new Map(words.map((w) => [w.toLowerCase(), { mentions: 0, before: 0, daily: [0, 0, 0, 0, 0, 0, 0], channels: new Map(), stories: [] }]));
  for (const r of stories.rows) {
    acc.get(r.name.toLowerCase())?.stories.push({
      id: r.id,
      headline: r.headline,
      dek: r.dek,
      category: r.category,
      heat: r.heat,
      first_post_at: iso(r.first_post_at),
      last_post_at: iso(r.last_post_at),
      platforms: (r.platforms ?? []).sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b)),
    });
  }
  for (const r of mentions.rows) {
    const e = acc.get(r.name.toLowerCase());
    if (!e) continue;
    if (!e.channels.has(r.platform)) e.channels.set(r.platform, { platform: r.platform, posts: 0, before: 0 });
    const ch = e.channels.get(r.platform);
    if (r.this_week) {
      e.mentions += r.posts;
      ch.posts += r.posts;
      e.daily[dayIndex(r.days_ago)] += r.posts;
    } else {
      e.before += r.posts;
      ch.before += r.posts;
    }
  }
  return new Map(
    [...acc].map(([key, e]) => [
      key,
      {
        mentions: e.mentions,
        change: change(e.mentions, e.before),
        daily: e.daily,
        // Platforms whose posts mention it: this week's count, and the change from the week before.
        channels: [...e.channels.values()]
          .filter((c) => c.posts || c.before)
          .sort(byPlatform)
          .map((c) => ({ platform: c.platform, posts: c.posts, change: change(c.posts, c.before) })),
        storyCount: e.stories.length,
        stories: e.stories.slice(0, 8),
      },
    ]),
  );
}

// ─── The page ──────────────────────────────────────────────────────────────

const followState = (row) => (row.target_id ? { id: row.target_id, active: row.active, paused: !row.active } : null);

// Creators we collect, plus any this workspace follows or paused. Collected: a verified handle, a
// handle the collector has been over at least once (even if it found nothing), or posts on record.
async function listCreators(workspaceId) {
  const { rows } = await pool.query(
    `select c.id, c.name,
            json_agg(json_build_object('platform', h.platform, 'handle', h.handle, 'url', h.url) order by array_position(${PLATFORM_ORDER_SQL}, h.platform)) as handles,
            ${creatorPhoto('c.id')} as photo,
            bool_or(h.verified) or bool_or(h.last_collected_at is not null)
              or exists (select 1 from posts p join creator_handles ch on ch.id = p.handle_id where ch.creator_id = c.id) as collected,
            t.id as target_id, t.active
       from creators c
       join creator_handles h on h.creator_id = c.id
       left join tracking_targets t on t.workspace_id = $1 and t.kind = 'creator' and t.creator_id = c.id
      where exists (select 1 from creator_handles vh where vh.creator_id = c.id and vh.verified) or t.id is not null
      group by c.id, t.id`,
    [workspaceId],
  );
  return rows;
}

async function listCommunities(workspaceId) {
  const { rows } = await pool.query(
    `with known as (
       select distinct on (lower(name)) name
         from (select p.community as name from posts p where p.community is not null
               union
               select t.query from tracking_targets t where t.workspace_id = $1 and t.kind = 'community') x
        order by lower(name), name)
     select k.name,
            exists (select 1 from posts p where lower(p.community) = lower(k.name))
              or exists (select 1 from query_collections q where q.platform = 'reddit' and q.query_key = lower(k.name)) as collected,
            t.id as target_id, t.active
       from known k
       left join tracking_targets t on t.workspace_id = $1 and t.kind = 'community' and lower(t.query) = lower(k.name)`,
    [workspaceId],
  );
  return rows;
}

// Brands and products this week's stories are about, plus the workspace's own (paused ones too).
async function listTopics(workspaceId, limit = 12) {
  const platformNames = Object.values(PLATFORM_NAMES).map((n) => n.toLowerCase());
  const { rows } = await pool.query(
    `with suggested as (
       select e.name, count(distinct s.id) as weight
         from post_entities pe
         join entities e on e.id = pe.entity_id and e.type in ('org', 'product')
         join story_posts sp on sp.post_id = pe.post_id
         join stories s on s.id = sp.story_id and ${LIVE_STORY}
        where lower(e.name) <> all($2::text[])
        group by e.name
        order by count(distinct s.id) desc, count(*) desc
        limit $3
     ), followed as (
       select t.query as name, 1000 as weight from tracking_targets t where t.workspace_id = $1 and t.kind = 'keyword'
     ), topics as (
       select distinct on (lower(name)) name, weight from (select * from followed union all select * from suggested) x order by lower(name), weight desc
     )
     select tp.name, t.id as target_id, t.active
       from topics tp
       left join tracking_targets t on t.workspace_id = $1 and t.kind = 'keyword' and lower(t.query) = lower(tp.name)
      order by tp.weight desc, tp.name`,
    [workspaceId, platformNames, limit],
  );
  return rows;
}

export async function getFollowing(workspaceId) {
  const [creators, communities, topics, totalStories] = await Promise.all([listCreators(workspaceId), listCommunities(workspaceId), listTopics(workspaceId), storyTotal()]);
  const [sourceStats, keywordStats] = await Promise.all([
    getSourceStats({ creatorIds: creators.map((c) => c.id), communities: communities.map((c) => c.name) }),
    getKeywordStats(topics.map((t) => t.name)),
  ]);
  const sources = [
    ...creators.map((c) => ({
      key: c.id,
      kind: 'creator',
      creatorId: c.id,
      name: c.name,
      handles: c.handles,
      photo: c.photo,
      collected: c.collected,
      follow: followState(c),
      stats: withChannels(sourceStats.get(c.id), c.handles.map((h) => h.platform)),
    })),
    ...communities.map((c) => ({
      key: `community:${c.name.toLowerCase()}`,
      kind: 'community',
      name: c.name,
      handles: [],
      photo: null,
      collected: c.collected,
      follow: followState(c),
      stats: withChannels(sourceStats.get(c.name.toLowerCase()), ['reddit']),
    })),
  ];
  const keywords = topics.map((t) => ({
    key: `keyword:${t.name.toLowerCase()}`,
    kind: 'keyword',
    name: t.name,
    handles: [],
    photo: null,
    collected: true,
    follow: followState(t),
    stats: keywordStats.get(t.name.toLowerCase()) ?? EMPTY_KEYWORD,
  }));
  return { totalStories, sources, keywords };
}

// ─── Search ────────────────────────────────────────────────────────────────

export async function withCreatorStats(creators) {
  if (!creators.length) return creators;
  const stats = await getSourceStats({ creatorIds: creators.map((c) => c.id) });
  return creators.map((c) => ({ ...c, stats: withChannels(stats.get(c.id), c.handles.map((h) => h.platform)) }));
}

// Subreddits we collect whose name contains the query.
export async function searchCommunities(workspaceId, query, limit = 4) {
  const q = String(query ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.|old\.)?reddit\.com\//i, '')
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
    .slice(0, 40);
  if (q.length < 2) return [];
  const { rows } = await pool.query(
    `with known as (select distinct on (lower(p.community)) p.community as name from posts p where p.community is not null order by lower(p.community), p.community)
     select k.name,
            (select t.id from tracking_targets t where t.workspace_id = $1 and t.kind = 'community' and t.active and lower(t.query) = lower(k.name)) as target_id
       from known k
      where k.name ilike ${likeEscaped('$2')}
      order by lower(k.name) = lower('r/' || $2) desc, k.name
      limit $3`,
    [workspaceId, q, limit],
  );
  const stats = await getSourceStats({ communities: rows.map((r) => r.name) });
  return rows.map((r) => ({ kind: 'community', name: r.name, target_id: r.target_id, stats: withChannels(stats.get(r.name.toLowerCase()), ['reddit']) }));
}

// What following a brand or topic would bring in, before it takes a slot.
export async function previewKeyword(workspaceId, query) {
  const name = String(query ?? '').trim().replace(/^#/, '').replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) return null;
  const [stats, target, totalStories] = await Promise.all([
    getKeywordStats([name]),
    pool.query(`select id from tracking_targets where workspace_id = $1 and kind = 'keyword' and active and lower(query) = lower($2)`, [workspaceId, name]),
    storyTotal(),
  ]);
  return { kind: 'keyword', name, target_id: target.rows[0]?.id ?? null, totalStories, stats: stats.get(name.toLowerCase()) ?? EMPTY_KEYWORD };
}
