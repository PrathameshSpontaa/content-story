// What we already cover: creators, subreddits and brands in collected data. Onboarding and the
// Following page offer these as one-tap follows, each with the stories it would bring in.
import { pool } from './db.js';
import { PLATFORM_NAMES } from './format.js';
import { STORY_TEXT, matchesWord } from './watchlist.js';

export const USE_CASES = [
  { id: 'brand', label: 'Brand or marketing team', text: 'See how creators and their audiences talk about your brand, launches and competitors.' },
  { id: 'agency', label: 'Agency', text: 'Keep up with the creators you work with and report back to clients.' },
  { id: 'media', label: 'Media or newsletter', text: 'Find the stories worth writing about, with every source linked.' },
  { id: 'exploring', label: 'Just exploring', text: 'See what AI and tech creators are talking about this week.' },
];

const PLATFORM_ORDER = `array['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit']::platform[]`;
const PUBLISHED_STORY = `join stories s on s.id = sp.story_id and s.published_at is not null and s.status not in ('merged', 'rejected')`;

// Creators we collect (verified handles), plus anyone this workspace added itself.
export async function listCatalogCreators(workspaceId) {
  const { rows } = await pool.query(
    `select * from (
       select c.id, c.name,
              json_agg(json_build_object('platform', h.platform, 'handle', h.handle, 'url', h.url) order by array_position(${PLATFORM_ORDER}, h.platform)) as handles,
              (select count(*) from posts p join creator_handles ph on ph.id = p.handle_id where ph.creator_id = c.id)::int as posts,
              array(select distinct sp.story_id from story_posts sp ${PUBLISHED_STORY}
                      join posts p on p.id = sp.post_id join creator_handles sh on sh.id = p.handle_id
                     where sh.creator_id = c.id) as story_ids,
              t.id as target_id
         from creators c
         join creator_handles h on h.creator_id = c.id
         left join tracking_targets t on t.workspace_id = $1 and t.kind = 'creator' and t.creator_id = c.id and t.active
        where exists (select 1 from creator_handles v where v.creator_id = c.id and v.verified) or t.id is not null
        group by c.id, t.id
     ) x
     order by (target_id is not null) desc, cardinality(story_ids) desc, posts desc, name`,
    [workspaceId],
  );
  return rows;
}

export async function listCatalogCommunities(workspaceId) {
  const { rows } = await pool.query(
    `with known as (
       select p.community as name from posts p where p.community is not null
       union
       select t.query from tracking_targets t where t.workspace_id = $1 and t.kind = 'community' and t.active
     )
     select k.name,
            (select count(*) from posts p where lower(p.community) = lower(k.name))::int as posts,
            array(select distinct sp.story_id from story_posts sp ${PUBLISHED_STORY}
                    join posts p on p.id = sp.post_id where lower(p.community) = lower(k.name)) as story_ids,
            (select t.id from tracking_targets t where t.workspace_id = $1 and t.kind = 'community' and t.active and lower(t.query) = lower(k.name)) as target_id
       from (select distinct on (lower(name)) name from known) k
      order by k.name`,
    [workspaceId],
  );
  return rows;
}

// Brands and products the week's stories are about, plus the workspace's own keywords.
export async function listCatalogTopics(workspaceId, limit = 12) {
  const platformNames = Object.values(PLATFORM_NAMES).map((n) => n.toLowerCase());
  const { rows } = await pool.query(
    `with suggested as (
       select e.name, count(distinct s.id) as weight
         from post_entities pe
         join entities e on e.id = pe.entity_id and e.type in ('org', 'product')
         join story_posts sp on sp.post_id = pe.post_id
         ${PUBLISHED_STORY}
        where lower(e.name) <> all($2::text[])
        group by e.name
        order by count(distinct s.id) desc, count(*) desc
        limit $3
     ), followed as (
       select t.query as name, 1000 as weight from tracking_targets t where t.workspace_id = $1 and t.kind = 'keyword' and t.active
     ), topics as (
       select distinct on (lower(name)) name, weight from (select * from followed union all select * from suggested) x order by lower(name), weight desc
     )
     select tp.name,
            array(select s.id from stories s
                    join lateral (select * from story_versions v where v.story_id = s.id and v.passed order by v.version desc limit 1) v on true
                   where s.published_at is not null and s.status not in ('merged', 'rejected')
                     and ${matchesWord(STORY_TEXT, 'tp.name')}) as story_ids,
            (select t.id from tracking_targets t where t.workspace_id = $1 and t.kind = 'keyword' and t.active and lower(t.query) = lower(tp.name)) as target_id
       from topics tp
      order by tp.weight desc, tp.name`,
    [workspaceId, platformNames, limit],
  );
  return rows;
}

export async function getCatalog(workspaceId) {
  const [creators, communities, topics] = await Promise.all([listCatalogCreators(workspaceId), listCatalogCommunities(workspaceId), listCatalogTopics(workspaceId)]);
  return { creators, communities, topics };
}
