// A workspace's watchlist: creators (with a handle on each platform), brands or keywords, and
// Reddit communities. Creators and handles are shared rows, so every workspace tracking the same
// person points at one creator, and that creator is collected once.
import { getPlanState } from './accounts.js';
import { pool, tx } from './db.js';
import { PLATFORM_NAMES } from './format.js';
import { PLATFORMS } from './pricing.js';

export class WatchlistError extends Error {}

export const CREATOR_PLATFORMS = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok'];
export const DAILY_ACTION = { creator: 'track_creator_day', keyword: 'track_keyword_day', community: 'track_community_day' };

// Accepts a pasted profile link or a handle and returns the stored form: '@name' (LinkedIn uses
// the profile slug), matching what the collectors already store.
export function parseHandle(platform, raw) {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  const path = input.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.|mobile\.)/i, '');
  const end = '(?:[/?#]|$)';
  const fail = (hint) => {
    throw new WatchlistError(`${PLATFORM_NAMES[platform]}: “${input}” doesn’t look like a profile. ${hint}`);
  };

  switch (platform) {
    case 'x': {
      const m = path.match(new RegExp(`^(?:x|twitter)\\.com/@?([A-Za-z0-9_]{1,15})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9_]{1,15})$/);
      if (!m) fail('Use @handle or x.com/handle.');
      return { handle: `@${m[1]}`, url: `https://x.com/${m[1]}` };
    }
    case 'youtube': {
      const channel = path.match(/^youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i);
      if (channel) return { handle: channel[1], url: `https://www.youtube.com/channel/${channel[1]}` };
      const m = path.match(new RegExp(`^youtube\\.com/@([A-Za-z0-9._-]{3,30})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._-]{3,30})$/);
      if (!m) fail('Use @handle or youtube.com/@handle.');
      return { handle: `@${m[1]}`, url: `https://www.youtube.com/@${m[1]}` };
    }
    case 'instagram': {
      const m = path.match(new RegExp(`^instagram\\.com/([A-Za-z0-9._]{1,30})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._]{1,30})$/);
      if (!m || ['p', 'reel', 'reels', 'explore', 'stories'].includes(m[1].toLowerCase())) fail('Use @handle or instagram.com/handle.');
      return { handle: `@${m[1]}`, url: `https://www.instagram.com/${m[1]}/` };
    }
    case 'tiktok': {
      const m = path.match(new RegExp(`^tiktok\\.com/@([A-Za-z0-9._]{2,24})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._]{2,24})$/);
      if (!m) fail('Use @handle or tiktok.com/@handle.');
      return { handle: `@${m[1]}`, url: `https://www.tiktok.com/@${m[1]}` };
    }
    case 'linkedin': {
      const company = path.match(/^linkedin\.com\/company\/([A-Za-z0-9%_-]{2,100})/i);
      if (company) return { handle: `company/${company[1].toLowerCase()}`, url: `https://www.linkedin.com/company/${company[1]}/` };
      const m = path.match(/^linkedin\.com\/in\/([A-Za-z0-9%_-]{2,100})/i);
      if (!m) fail('Paste the profile link, like linkedin.com/in/name.');
      return { handle: m[1].toLowerCase(), url: `https://www.linkedin.com/in/${m[1]}/` };
    }
    default:
      return null;
  }
}

export function parseCommunity(raw) {
  const input = String(raw ?? '').trim();
  const m = input.replace(/^https?:\/\//i, '').match(/^(?:(?:www\.|old\.)?reddit\.com\/)?\/?r\/([A-Za-z0-9_]{2,21})\/?$/i) ?? input.match(/^([A-Za-z0-9_]{2,21})$/);
  if (!m) throw new WatchlistError(`“${input}” isn’t a subreddit. Use r/name or a reddit.com/r/name link.`);
  return `r/${m[1]}`;
}

// ILIKE pattern that matches the text literally (no user-supplied wildcards).
export const likeEscaped = (sql) => `'%' || replace(replace(replace(${sql}, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;

const LATEST_PASSED = `join lateral (select * from story_versions v where v.story_id = s.id and v.passed order by v.version desc limit 1) v on true`;

export async function listTargets(workspaceId) {
  const { rows } = await pool.query(
    `select t.id, t.kind, t.query, t.platforms::text[] as platforms, t.active, t.paused_reason, t.created_at,
            c.name as creator_name,
            coalesce((select json_agg(json_build_object('platform', h.platform, 'handle', h.handle, 'url', h.url) order by h.platform)
                        from creator_handles h where h.creator_id = t.creator_id), '[]'::json) as handles,
            case t.kind
              when 'creator' then (select count(*) from posts p join creator_handles h on h.id = p.handle_id where h.creator_id = t.creator_id)
              when 'community' then (select count(*) from posts p where lower(p.community) = lower(t.query))
              else 0
            end::int as posts_collected,
            case t.kind
              when 'keyword' then (select count(*) from stories s ${LATEST_PASSED}
                                    where s.published_at is not null
                                      and (v.written::text || v.narrative::text) ilike ${likeEscaped('t.query')})
              else (select count(distinct sp.story_id)
                      from story_posts sp
                      join stories s on s.id = sp.story_id and s.published_at is not null
                      join posts p on p.id = sp.post_id
                      left join creator_handles h on h.id = p.handle_id
                     where (t.kind = 'creator' and h.creator_id = t.creator_id)
                        or (t.kind = 'community' and lower(p.community) = lower(t.query)))
            end::int as stories
       from tracking_targets t
       left join creators c on c.id = t.creator_id
      where t.workspace_id = $1
      order by t.kind, t.created_at`,
    [workspaceId],
  );
  return rows;
}

export function dailyCredits(targets, prices) {
  return targets.filter((t) => t.active).reduce((sum, t) => sum + (prices[DAILY_ACTION[t.kind]]?.credits ?? 0), 0);
}

// Creators and communities share one limit; brands and keywords have their own.
async function assertRoom(client, workspaceId, kind, plan) {
  const isKeyword = kind === 'keyword';
  const { rows } = await client.query(
    `select count(*)::int as n from tracking_targets where workspace_id = $1 and active and (kind = 'keyword') = $2`,
    [workspaceId, isKeyword],
  );
  const limit = isKeyword ? plan.maxKeywords : plan.maxSources;
  if (rows[0].n >= limit) {
    const what = isKeyword ? `${limit === 1 ? 'brand or keyword' : 'brands or keywords'}` : `${limit === 1 ? 'creator or community' : 'creators and communities'}`;
    throw new WatchlistError(`${plan.name} includes ${limit} active ${what}. Pause or remove one, or move to a bigger plan.`);
  }
}

export async function addCreator(workspaceId, { name, handles }) {
  const parsed = CREATOR_PLATFORMS.map((p) => [p, parseHandle(p, handles?.[p])]).filter(([, h]) => h);
  if (!parsed.length) throw new WatchlistError('Add at least one profile: an X, YouTube, LinkedIn, Instagram or TikTok handle or link.');
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const plan = await getPlanState(workspaceId);

  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await assertRoom(client, workspaceId, 'creator', plan);

    const existing = await client.query(
      `select creator_id from creator_handles
        where (platform::text, lower(handle)) in (select * from unnest($1::text[], $2::text[]))
        limit 1`,
      [parsed.map(([p]) => p), parsed.map(([, h]) => h.handle.toLowerCase())],
    );
    let creatorId = existing.rows[0]?.creator_id;
    if (!creatorId) {
      if (!cleanName) throw new WatchlistError('Add the creator’s name.');
      creatorId = (await client.query('insert into creators (name) values ($1) returning id', [cleanName])).rows[0].id;
    }
    for (const [platform, h] of parsed) {
      await client.query(
        `insert into creator_handles (creator_id, platform, handle, url) values ($1, $2, $3, $4)
         on conflict (platform, (lower(handle))) do nothing`,
        [creatorId, platform, h.handle, h.url],
      );
    }
    const inserted = await client.query(
      `insert into tracking_targets (workspace_id, kind, creator_id, platforms)
       select $1, 'creator', $2, array_agg(distinct platform) from creator_handles where creator_id = $2
       on conflict (workspace_id, creator_id) where kind = 'creator' do nothing`,
      [workspaceId, creatorId],
    );
    const { name: creatorName } = (await client.query('select name from creators where id = $1', [creatorId])).rows[0];
    if (!inserted.rowCount) throw new WatchlistError(`${creatorName} is already on your watchlist.`);
    return { creatorName, matchedExisting: Boolean(existing.rows[0]) };
  });
}

export async function addTopic(workspaceId, { kind, query, platforms }) {
  let cleanQuery;
  let cleanPlatforms;
  if (kind === 'community') {
    cleanQuery = parseCommunity(query);
    cleanPlatforms = ['reddit'];
  } else if (kind === 'keyword') {
    cleanQuery = String(query ?? '').trim().replace(/\s+/g, ' ');
    if (cleanQuery.length < 2 || cleanQuery.length > 60) throw new WatchlistError('A brand or keyword needs 2 to 60 characters.');
    cleanPlatforms = PLATFORMS.filter((p) => (platforms ?? []).includes(p));
    if (!cleanPlatforms.length) throw new WatchlistError('Pick at least one platform to search.');
  } else {
    throw new WatchlistError('Choose what to track.');
  }
  const plan = await getPlanState(workspaceId);

  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await assertRoom(client, workspaceId, kind, plan);
    const inserted = await client.query(
      `insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, $2, $3, $4::platform[])
       on conflict (workspace_id, kind, lower(query)) where kind <> 'creator' do nothing`,
      [workspaceId, kind, cleanQuery, cleanPlatforms],
    );
    if (!inserted.rowCount) throw new WatchlistError(`${cleanQuery} is already on your watchlist.`);
    return { query: cleanQuery };
  });
}

export async function setTargetActive(workspaceId, targetId, active) {
  const plan = active ? await getPlanState(workspaceId) : null;
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    const { rows } = await client.query('select kind, active from tracking_targets where id = $1 and workspace_id = $2', [targetId, workspaceId]);
    if (!rows[0] || rows[0].active === active) return;
    if (active) await assertRoom(client, workspaceId, rows[0].kind, plan);
    await client.query(
      `update tracking_targets set active = $3, paused_reason = case when $3 then null else 'paused_by_user' end where id = $1 and workspace_id = $2`,
      [targetId, workspaceId, active],
    );
  });
}

export async function removeTarget(workspaceId, targetId) {
  await pool.query('delete from tracking_targets where id = $1 and workspace_id = $2', [targetId, workspaceId]);
}
