// A workspace's watchlist: creators (with a handle on each platform), brands or keywords, and
// Reddit communities. Creators and handles are shared rows, so every workspace tracking the same
// person points at one creator, and that creator is collected once.
import { getPlanState } from './accounts.js';
import { pool, tx } from './db.js';
import { PLATFORM_NAMES } from './format.js';
import { PLATFORMS } from './pricing.js';
import { CREATOR_PLATFORMS, WatchlistError, detectPlatform, parseCommunity, parseHandle } from './profiles.js';

export { CREATOR_PLATFORMS, WatchlistError, detectPlatform, parseCommunity, parseHandle } from './profiles.js';

// A profile that already belongs to a creator; `creator` is who it belongs to.
export class ExistingCreatorError extends WatchlistError {
  constructor(message, creator) {
    super(message);
    this.creator = creator;
  }
}

// A follow that doesn't fit the plan. `group` is 'source' (creators and subreddits share one
// limit) or 'keyword' (brands and topics).
export class LimitError extends WatchlistError {
  constructor(message, group, limit) {
    super(message);
    this.group = group;
    this.limit = limit;
  }
}

export const DAILY_ACTION = { creator: 'track_creator_day', keyword: 'track_keyword_day', community: 'track_community_day' };

// ILIKE pattern that matches the text literally (no user-supplied wildcards).
export const likeEscaped = (sql) => `'%' || replace(replace(replace(${sql}, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;

// The words of a story version `v`: its string values only, so JSON keys never match a keyword.
export const STORY_TEXT = `(jsonb_path_query_array(v.written, 'strict $.** ? (@.type() == "string")')::text || ' ' || jsonb_path_query_array(v.narrative, 'strict $.** ? (@.type() == "string")')::text)`;

// Case-insensitive whole-word match: "AI" matches "AI video" but not "said" or "email".
export const matchesWord = (textSql, wordSql) =>
  `${textSql} ~* ('(^|[^[:alnum:]_])' || regexp_replace(${wordSql}, '([^[:alnum:][:space:]])', '\\\\\\1', 'g') || '($|[^[:alnum:]_])')`;

// A creator's photo as { url, platform }: the first channel, in this order, that gave us one.
export const creatorPhoto = (creatorIdSql) => `(
  select json_build_object('url', ph.avatar_url, 'platform', ph.platform)
    from creator_handles ph
   where ph.creator_id = ${creatorIdSql} and ph.avatar_url is not null
   order by array_position(array['x', 'youtube', 'linkedin', 'tiktok', 'instagram']::platform[], ph.platform)
   limit 1)`;

const LATEST_PASSED = `join lateral (select * from story_versions v where v.story_id = s.id and v.passed order by v.version desc limit 1) v on true`;
const PLATFORM_ORDER = `array['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit']::platform[]`;
const UUID = /^[0-9a-f-]{36}$/i;
const cleanKeyword = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

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
                                      and ${matchesWord(STORY_TEXT, 't.query')})
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
    const what = isKeyword ? (limit === 1 ? 'brand or topic' : 'brands and topics') : limit === 1 ? 'creator or subreddit' : 'creators and subreddits';
    throw new LimitError(`${plan.name} includes ${limit} ${what}. Unfollow one to add another.`, isKeyword ? 'keyword' : 'source', limit);
  }
}

// How many of a plan's creator-and-subreddit (or brand-and-topic) slots are in use.
export async function slotUsage(workspaceId, kind) {
  const isKeyword = kind === 'keyword';
  const [plan, { rows }] = await Promise.all([
    getPlanState(workspaceId),
    pool.query(`select count(*)::int as n from tracking_targets where workspace_id = $1 and active and (kind = 'keyword') = $2`, [workspaceId, isKeyword]),
  ]);
  return { used: rows[0].n, limit: isKeyword ? plan.maxKeywords : plan.maxSources, planName: plan.name };
}

export async function getTarget(workspaceId, targetId) {
  if (!UUID.test(String(targetId))) return null;
  const { rows } = await pool.query(
    `select t.id, t.kind, t.creator_id, t.query, t.active, coalesce(c.name, t.query) as name
       from tracking_targets t left join creators c on c.id = t.creator_id
      where t.id = $1 and t.workspace_id = $2`,
    [targetId, workspaceId],
  );
  return rows[0] ?? null;
}

// Following again after unfollowing (or an automatic pause) reactivates the same row.
const FOLLOW_CREATOR = `
  insert into tracking_targets (workspace_id, kind, creator_id, platforms)
  select $1, 'creator', c.id, array_agg(distinct h.platform)
    from creators c join creator_handles h on h.creator_id = c.id
   where c.id = $2
   group by c.id
  on conflict (workspace_id, creator_id) where kind = 'creator'
  do update set active = true, paused_reason = null where not tracking_targets.active`;

const FOLLOW_QUERY = `
  insert into tracking_targets (workspace_id, kind, query, platforms) values ($1, $2, $3, $4::platform[])
  on conflict (workspace_id, kind, lower(query)) where kind <> 'creator'
  do update set active = true, paused_reason = null where not tracking_targets.active`;

export async function followCreator(workspaceId, creatorId) {
  if (!UUID.test(String(creatorId))) throw new WatchlistError('Choose a creator from the list.');
  const plan = await getPlanState(workspaceId);
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await assertRoom(client, workspaceId, 'creator', plan);
    const { rowCount } = await client.query(FOLLOW_CREATOR, [workspaceId, creatorId]);
    return rowCount === 1;
  });
}

export async function unfollowCreator(workspaceId, creatorId) {
  if (!UUID.test(String(creatorId))) return false;
  const { rowCount } = await pool.query(`delete from tracking_targets where workspace_id = $1 and kind = 'creator' and creator_id = $2`, [workspaceId, creatorId]);
  return rowCount === 1;
}

// ─── Finding and adding creators ───────────────────────────────────────────

// A creator as the finder shows it. $1 is the workspace; `where` narrows the creators.
const creatorSummary = (where) => `
  select * from (
    select c.id, c.name,
           json_agg(json_build_object('platform', h.platform, 'handle', h.handle, 'url', h.url) order by array_position(${PLATFORM_ORDER}, h.platform)) as handles,
           bool_or(h.verified) as verified,
           bool_or(h.last_collected_at is not null) as collected_once,
           ${creatorPhoto('c.id')} as photo,
           (select count(*) from posts p join creator_handles ch on ch.id = p.handle_id where ch.creator_id = c.id)::int as posts,
           array(select distinct sp.story_id
                   from story_posts sp
                   join stories s on s.id = sp.story_id and s.published_at is not null and s.status not in ('merged', 'rejected')
                   join posts p on p.id = sp.post_id
                   join creator_handles sh on sh.id = p.handle_id
                  where sh.creator_id = c.id) as story_ids,
           (select t.id from tracking_targets t where t.workspace_id = $1 and t.kind = 'creator' and t.creator_id = c.id and t.active) as target_id
      from creators c
      join creator_handles h on h.creator_id = c.id
     where ${where}
     group by c.id
  ) x`;

// Covered: we collect this creator already (a verified handle, a handle collected at least once, or posts on record).
const withCovered = (row) => ({ ...row, covered: Boolean(row.verified) || Boolean(row.collected_once) || row.posts > 0 });

export async function getCreatorSummary(workspaceId, creatorId) {
  const { rows } = await pool.query(creatorSummary('c.id = $2'), [workspaceId, creatorId]);
  return rows[0] ? withCovered(rows[0]) : null;
}

// Everyone we know whose name or handle contains the query, best matches first.
export async function searchCreators(workspaceId, query, limit = 8) {
  const q = cleanKeyword(query).replace(/^@/, '').slice(0, 60);
  if (q.length < 2) return [];
  const { rows } = await pool.query(
    `${creatorSummary(`c.name ilike ${likeEscaped('$2')} or exists (select 1 from creator_handles m where m.creator_id = c.id and m.handle ilike ${likeEscaped('$2')})`)}
     order by left(lower(name), length($2)) = lower($2) desc, verified desc, cardinality(story_ids) desc, posts desc, name
     limit $3`,
    [workspaceId, q, limit],
  );
  return rows.map(withCovered);
}

// What a pasted link or handle is: a creator we already know, a new profile, or a handle that
// needs its platform. `platform` answers that question for bare handles.
export async function lookupProfile(workspaceId, raw, platform = null) {
  const input = String(raw ?? '').trim();
  if (!input) return { status: 'invalid', message: 'Paste a profile link or a handle.' };
  const detected = detectPlatform(input) ?? (CREATOR_PLATFORMS.includes(platform) ? platform : null);
  if (detected === 'reddit') return { status: 'community', message: 'That’s a subreddit. Follow it in the Subreddits section.' };

  if (!detected) {
    const bare = input.replace(/^@/, '');
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(bare)) return { status: 'invalid', message: 'Paste a profile link, like instagram.com/name, or a handle like @name.' };
    const { rows } = await pool.query(
      `${creatorSummary(`c.id in (select creator_id from creator_handles where lower(handle) in (lower($2), lower('@' || $2)))`)} order by verified desc limit 1`,
      [workspaceId, bare],
    );
    return rows[0] ? { status: 'existing', creator: withCovered(rows[0]) } : { status: 'needs-platform', handle: `@${bare}` };
  }

  let profile;
  try {
    profile = { platform: detected, ...parseHandle(detected, input) };
  } catch (err) {
    if (err instanceof WatchlistError) return { status: 'invalid', message: err.message };
    throw err;
  }
  const { rows } = await pool.query(
    creatorSummary(`c.id in (select creator_id from creator_handles where platform = $2::platform and lower(handle) = lower($3))`),
    [workspaceId, detected, profile.handle],
  );
  return rows[0] ? { status: 'existing', creator: withCovered(rows[0]), profile } : { status: 'new', profile };
}

// A creator we don't cover yet, with a profile on each platform they post on. Refuses profiles
// that already belong to someone, so the same person is never collected twice.
export async function createCreator(workspaceId, { name, profiles, follow = true }) {
  const cleanName = cleanKeyword(name).slice(0, 80);
  if (cleanName.length < 2) throw new WatchlistError('Add the creator’s name.');

  const parsed = [];
  for (const p of Array.isArray(profiles) ? profiles.slice(0, 10) : []) {
    if (!CREATOR_PLATFORMS.includes(p?.platform)) continue;
    const h = parseHandle(p.platform, p.input);
    if (!h) continue;
    const same = parsed.find((x) => x.platform === p.platform);
    if (same && same.handle.toLowerCase() !== h.handle.toLowerCase()) {
      throw new WatchlistError(`Two ${PLATFORM_NAMES[p.platform]} profiles. Keep the one that belongs to ${cleanName}.`);
    }
    if (!same) parsed.push({ platform: p.platform, ...h });
  }
  if (!parsed.length) throw new WatchlistError('Add at least one profile link.');

  const plan = follow ? await getPlanState(workspaceId) : null;
  const result = await tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    const taken = await client.query(
      `select creator_id from creator_handles where (platform::text, lower(handle)) in (select * from unnest($1::text[], $2::text[])) limit 1`,
      [parsed.map((p) => p.platform), parsed.map((p) => p.handle.toLowerCase())],
    );
    if (taken.rows[0]) return { existingId: taken.rows[0].creator_id };
    if (follow) await assertRoom(client, workspaceId, 'creator', plan);
    const id = (await client.query('insert into creators (name) values ($1) returning id', [cleanName])).rows[0].id;
    for (const p of parsed) {
      await client.query('insert into creator_handles (creator_id, platform, handle, url) values ($1, $2, $3, $4)', [id, p.platform, p.handle, p.url]);
    }
    if (follow) await client.query(FOLLOW_CREATOR, [workspaceId, id]);
    return { id };
  });

  if (result.existingId) {
    const existing = await getCreatorSummary(workspaceId, result.existingId);
    throw new ExistingCreatorError(`One of those profiles belongs to ${existing.name}, who’s already on Content-Story.`, existing);
  }
  return getCreatorSummary(workspaceId, result.id);
}

// ─── Onboarding and lists ──────────────────────────────────────────────────

// First-run picks, saved in one go. Picks past the plan's limits are left out.
export async function completeOnboarding(workspaceId, { useCase, creatorIds, communities, keywords }) {
  const plan = await getPlanState(workspaceId);
  const ids = [...new Set((creatorIds ?? []).map(String).filter((id) => UUID.test(id)))];
  const subs = [
    ...new Set(
      (communities ?? [])
        .map((c) => {
          try {
            return parseCommunity(c);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    ),
  ];
  const words = [...new Map((keywords ?? []).map(cleanKeyword).filter((k) => k.length >= 2 && k.length <= 60).map((k) => [k.toLowerCase(), k])).values()];
  const use = ['brand', 'agency', 'media', 'exploring'].includes(useCase) ? useCase : null;

  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    const { rows } = await client.query(
      `select count(*) filter (where kind <> 'keyword')::int as sources, count(*) filter (where kind = 'keyword')::int as keywords
         from tracking_targets where workspace_id = $1 and active`,
      [workspaceId],
    );
    let sourceRoom = plan.maxSources - rows[0].sources;
    let keywordRoom = plan.maxKeywords - rows[0].keywords;
    const added = { creators: 0, communities: 0, keywords: 0 };

    for (const id of ids) {
      if (sourceRoom <= 0) break;
      if ((await client.query(FOLLOW_CREATOR, [workspaceId, id])).rowCount) {
        sourceRoom -= 1;
        added.creators += 1;
      }
    }
    for (const sub of subs) {
      if (sourceRoom <= 0) break;
      if ((await client.query(FOLLOW_QUERY, [workspaceId, 'community', sub, ['reddit']])).rowCount) {
        sourceRoom -= 1;
        added.communities += 1;
      }
    }
    for (const word of words) {
      if (keywordRoom <= 0) break;
      if ((await client.query(FOLLOW_QUERY, [workspaceId, 'keyword', word, PLATFORMS])).rowCount) {
        keywordRoom -= 1;
        added.keywords += 1;
      }
    }
    await client.query('update workspaces set onboarded_at = coalesce(onboarded_at, now()), use_case = coalesce($2, use_case) where id = $1', [workspaceId, use]);
    return added;
  });
}

// The short list for the sidebar and the stories filter.
export async function listFollowing(workspaceId) {
  const { rows } = await pool.query(
    `select t.id, t.kind, coalesce(c.name, t.query) as name, ${creatorPhoto('t.creator_id')} as photo
       from tracking_targets t left join creators c on c.id = t.creator_id
      where t.workspace_id = $1 and t.active
      order by case t.kind when 'creator' then 0 when 'community' then 1 else 2 end, lower(coalesce(c.name, t.query))`,
    [workspaceId],
  );
  return rows;
}

export async function addTopic(workspaceId, { kind, query, platforms }) {
  let cleanQuery;
  let cleanPlatforms;
  if (kind === 'community') {
    cleanQuery = parseCommunity(query);
    cleanPlatforms = ['reddit'];
  } else if (kind === 'keyword') {
    cleanQuery = cleanKeyword(query);
    if (cleanQuery.length < 2 || cleanQuery.length > 60) throw new WatchlistError('A brand or keyword needs 2 to 60 characters.');
    cleanPlatforms = PLATFORMS.filter((p) => (platforms ?? PLATFORMS).includes(p));
    if (!cleanPlatforms.length) throw new WatchlistError('Pick at least one platform to search.');
  } else {
    throw new WatchlistError('Choose what to track.');
  }
  const plan = await getPlanState(workspaceId);

  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await assertRoom(client, workspaceId, kind, plan);
    const inserted = await client.query(FOLLOW_QUERY, [workspaceId, kind, cleanQuery, cleanPlatforms]);
    if (!inserted.rowCount) throw new WatchlistError(`You already follow ${cleanQuery}.`);
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
