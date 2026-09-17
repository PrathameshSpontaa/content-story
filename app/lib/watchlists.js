// Watchlists: a workspace's follows grouped by client, campaign or interest, each with its own tags (the
// kinds of story it wants). Stories are built per watchlist. Every follow is in at least one watchlist: a
// follow taken out of its last one is unfollowed, so nothing is collected that no watchlist uses.
import { pool, tx } from './db.js';
import { WatchlistError } from './profiles.js';
import { TAG_LIMITS, defaultTemplates, templateByKey } from './tags.js';

export const MAX_WATCHLISTS = 20;
export const FIRST_WATCHLIST_NAME = 'My watchlist';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (value) => UUID.test(String(value ?? ''));
const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const GONE = 'That watchlist is gone. Reload the page.';

function cleanWatchlistName(raw) {
  const name = clean(raw);
  if (name.length < 2 || name.length > 60) throw new WatchlistError('A watchlist name needs 2 to 60 characters.');
  return name;
}

function cleanTag({ name, rule, minSources }) {
  const cleanName = clean(name);
  if (cleanName.length < 2 || cleanName.length > TAG_LIMITS.name) throw new WatchlistError(`A tag name needs 2 to ${TAG_LIMITS.name} characters.`);
  const cleanRule = clean(rule);
  if (cleanRule.length < 10 || cleanRule.length > TAG_LIMITS.rule) throw new WatchlistError(`Say what counts for ${cleanName} in 10 to ${TAG_LIMITS.rule} characters.`);
  return { name: cleanName, rule: cleanRule, minSources: Number(minSources) === 2 ? 2 : 1 };
}

async function insertTags(client, watchlistId, templates) {
  for (const [i, t] of templates.entries()) {
    await client.query(
      `insert into watchlist_tags (watchlist_id, name, rule, min_sources, template, position) values ($1, $2, $3, $4, $5, $6)
       on conflict (watchlist_id, lower(name)) do nothing`,
      [watchlistId, t.name, t.rule, t.minSources, t.key, i],
    );
  }
}

const ownWatchlist = async (client, workspaceId, watchlistId) =>
  isUuid(watchlistId) ? ((await client.query('select id, name from watchlists where id = $1 and workspace_id = $2', [watchlistId, workspaceId])).rows[0] ?? null) : null;

// The workspace's first watchlist, made on first use with the tags for its use case and the feed its
// stories were built in before watchlists.
async function firstWatchlistId(client, workspaceId) {
  const first = async () => (await client.query('select id from watchlists where workspace_id = $1 order by created_at, id limit 1', [workspaceId])).rows[0]?.id ?? null;
  const existing = await first();
  if (existing) return existing;
  const { rows: ws } = await client.query('select use_case from workspaces where id = $1', [workspaceId]);
  if (!ws[0]) return null;
  // A racing call inserts the same name; its row is used once it commits.
  const { rows } = await client.query(
    `insert into watchlists (workspace_id, name) values ($1, $2) on conflict (workspace_id, lower(name)) do nothing returning id`,
    [workspaceId, FIRST_WATCHLIST_NAME],
  );
  if (rows[0]) {
    await insertTags(client, rows[0].id, defaultTemplates(ws[0].use_case));
    await client.query(`update feeds set watchlist_id = $1 where workspace_id = $2 and kind = 'following' and watchlist_id is null`, [rows[0].id, workspaceId]);
  }
  return first();
}

// Makes sure the workspace has a watchlist and that every follow is in one: follows added before
// watchlists (or by an older page) go into the first. Returns the first watchlist's id.
export async function ensureWatchlists(workspaceId, client = null) {
  if (!isUuid(workspaceId)) return null;
  if (!client) return tx((c) => ensureWatchlists(workspaceId, c));
  const id = await firstWatchlistId(client, workspaceId);
  if (!id) return null;
  await client.query(
    `insert into watchlist_targets (watchlist_id, target_id)
     select $1, t.id from tracking_targets t
      where t.workspace_id = $2 and not exists (select 1 from watchlist_targets wt where wt.target_id = t.id)
     on conflict do nothing`,
    [id, workspaceId],
  );
  return id;
}

// Puts a follow into the given watchlists (only this workspace's count), or into the first watchlist when
// none of them is. Called inside the follow's transaction. Returns how many watchlists it newly joined.
export async function attachTarget(client, workspaceId, targetId, watchlistIds = []) {
  const ids = [...new Set((Array.isArray(watchlistIds) ? watchlistIds : [watchlistIds]).map(String).filter(isUuid))];
  let own = ids.length ? (await client.query('select id from watchlists where workspace_id = $1 and id = any($2::uuid[])', [workspaceId, ids])).rows.map((r) => r.id) : [];
  if (!own.length) own = [await firstWatchlistId(client, workspaceId)];
  const { rowCount } = await client.query(`insert into watchlist_targets (watchlist_id, target_id) select unnest($1::uuid[]), $2 on conflict do nothing`, [own, targetId]);
  return rowCount;
}

const TAGS_JSON = `coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'rule', g.rule, 'minSources', g.min_sources, 'template', g.template)
                                          order by g.position, g.created_at)
                               from watchlist_tags g where g.watchlist_id = w.id), '[]'::json)`;
const ACTIVE_FOLLOWS = `(select count(*)::int from watchlist_targets wt join tracking_targets t on t.id = wt.target_id and t.active where wt.watchlist_id = w.id)`;

// Every watchlist, oldest first, with its tags and how many active follows it has.
export async function listWatchlists(workspaceId) {
  if (!isUuid(workspaceId)) return [];
  await ensureWatchlists(workspaceId);
  const { rows } = await pool.query(
    `select w.id, w.name, w.created_at, ${ACTIVE_FOLLOWS} as follows, ${TAGS_JSON} as tags
       from watchlists w where w.workspace_id = $1 order by w.created_at, w.id`,
    [workspaceId],
  );
  return rows;
}

// Names and follow counts for the sidebar. Reads only: the first watchlist is made by the pages that need it.
export async function listWatchlistNames(workspaceId) {
  if (!isUuid(workspaceId)) return [];
  const { rows } = await pool.query(`select w.id, w.name, ${ACTIVE_FOLLOWS} as follows from watchlists w where w.workspace_id = $1 order by w.created_at, w.id`, [workspaceId]);
  return rows;
}

// One watchlist with its tags, the ids of the follows in it, and how many watchlists the workspace has.
export async function getWatchlist(workspaceId, watchlistId) {
  if (!isUuid(watchlistId)) return null;
  const all = await listWatchlists(workspaceId);
  const watchlist = all.find((w) => w.id === watchlistId);
  if (!watchlist) return null;
  const { rows } = await pool.query('select target_id from watchlist_targets where watchlist_id = $1', [watchlistId]);
  return { ...watchlist, targetIds: rows.map((r) => r.target_id), watchlistCount: all.length };
}

// What story building needs of a watchlist: its tags, and the brands and topics it follows.
export async function watchlistForStories(watchlistId) {
  if (!isUuid(watchlistId)) return null;
  const { rows } = await pool.query(
    `select w.id, w.workspace_id, w.name, ${TAGS_JSON} as tags,
            array(select t.query from watchlist_targets wt join tracking_targets t on t.id = wt.target_id and t.active and t.kind = 'keyword'
                   where wt.watchlist_id = w.id order by lower(t.query)) as brands
       from watchlists w where w.id = $1`,
    [watchlistId],
  );
  return rows[0] ?? null;
}

// A new watchlist starts with the tags for the workspace's use case and no follows.
export async function createWatchlist(workspaceId, { name, userId = null }) {
  const cleanName = cleanWatchlistName(name);
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await ensureWatchlists(workspaceId, client);
    const { rows: count } = await client.query('select count(*)::int as n from watchlists where workspace_id = $1', [workspaceId]);
    if (count[0].n >= MAX_WATCHLISTS) throw new WatchlistError(`A workspace can have up to ${MAX_WATCHLISTS} watchlists.`);
    const { rows } = await client.query(
      `insert into watchlists (workspace_id, name, created_by) values ($1, $2, $3) on conflict (workspace_id, lower(name)) do nothing returning id`,
      [workspaceId, cleanName, userId],
    );
    if (!rows[0]) throw new WatchlistError(`You already have a watchlist called ${cleanName}.`);
    const { rows: ws } = await client.query('select use_case from workspaces where id = $1', [workspaceId]);
    await insertTags(client, rows[0].id, defaultTemplates(ws[0]?.use_case));
    return { id: rows[0].id, name: cleanName };
  });
}

export async function renameWatchlist(workspaceId, watchlistId, name) {
  const cleanName = cleanWatchlistName(name);
  if (!isUuid(watchlistId)) throw new WatchlistError(GONE);
  try {
    const { rowCount } = await pool.query('update watchlists set name = $3 where id = $1 and workspace_id = $2', [watchlistId, workspaceId, cleanName]);
    if (!rowCount) throw new WatchlistError(GONE);
  } catch (err) {
    if (err.code === '23505') throw new WatchlistError(`You already have a watchlist called ${cleanName}.`);
    throw err;
  }
  return { name: cleanName };
}

// Deletes a watchlist, never the last one. Follows that were only in it are unfollowed, and its feed is
// archived so stories saved from it stay readable. Returns how many follows were unfollowed.
export async function deleteWatchlist(workspaceId, watchlistId) {
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    if (!(await ownWatchlist(client, workspaceId, watchlistId))) throw new WatchlistError(GONE);
    const { rows } = await client.query('select count(*)::int as n from watchlists where workspace_id = $1', [workspaceId]);
    if (rows[0].n <= 1) throw new WatchlistError('Keep at least one watchlist. Rename this one or change what’s in it instead.');
    const { rowCount } = await client.query(
      `delete from tracking_targets t using watchlist_targets wt
        where wt.watchlist_id = $1 and wt.target_id = t.id and t.workspace_id = $2
          and not exists (select 1 from watchlist_targets o where o.target_id = t.id and o.watchlist_id <> $1)`,
      [watchlistId, workspaceId],
    );
    await client.query(`update feeds set kind = 'archived', watchlist_id = null where watchlist_id = $1`, [watchlistId]);
    await client.query('delete from watchlists where id = $1', [watchlistId]);
    return { unfollowed: rowCount };
  });
}

// Adds a tag, written from scratch or ready-made (`template` is its key), or saves changes to one (`id`).
export async function saveTag(workspaceId, watchlistId, input = {}) {
  const template = input.template ? templateByKey(input.template) : null;
  if (input.template && !template) throw new WatchlistError('Choose a tag from the list.');
  const tag = cleanTag(template ?? input);
  return tx(async (client) => {
    if (!(await ownWatchlist(client, workspaceId, watchlistId))) throw new WatchlistError(GONE);
    try {
      if (input.id) {
        const { rowCount } = isUuid(input.id)
          ? await client.query('update watchlist_tags set name = $3, rule = $4, min_sources = $5 where id = $1 and watchlist_id = $2', [input.id, watchlistId, tag.name, tag.rule, tag.minSources])
          : { rowCount: 0 };
        if (!rowCount) throw new WatchlistError('That tag is gone. Reload the page.');
        return { id: input.id, ...tag };
      }
      const { rows } = await client.query('select count(*)::int as n, coalesce(max(position), -1) + 1 as next from watchlist_tags where watchlist_id = $1', [watchlistId]);
      if (rows[0].n >= TAG_LIMITS.perWatchlist) throw new WatchlistError(`A watchlist can have up to ${TAG_LIMITS.perWatchlist} tags.`);
      const { rows: inserted } = await client.query(
        `insert into watchlist_tags (watchlist_id, name, rule, min_sources, template, position) values ($1, $2, $3, $4, $5, $6) returning id`,
        [watchlistId, tag.name, tag.rule, tag.minSources, template?.key ?? null, rows[0].next],
      );
      return { id: inserted[0].id, ...tag };
    } catch (err) {
      if (err.code === '23505') throw new WatchlistError(`This watchlist already has a tag called ${tag.name}.`);
      throw err;
    }
  });
}

// Stories already made for a removed tag keep its name.
export async function removeTag(workspaceId, watchlistId, tagId) {
  if (!isUuid(tagId) || !isUuid(watchlistId)) return false;
  const { rowCount } = await pool.query(
    `delete from watchlist_tags g using watchlists w where g.id = $1 and g.watchlist_id = w.id and w.id = $2 and w.workspace_id = $3`,
    [tagId, watchlistId, workspaceId],
  );
  return rowCount === 1;
}

// Sets which of the workspace's active follows are in a watchlist (paused ones stay where they are). A
// follow taken out of its last watchlist is unfollowed. Returns how many were added, taken out, and unfollowed.
export async function setWatchlistTargets(workspaceId, watchlistId, targetIds) {
  const wanted = [...new Set((Array.isArray(targetIds) ? targetIds : []).map(String).filter(isUuid))];
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    if (!(await ownWatchlist(client, workspaceId, watchlistId))) throw new WatchlistError(GONE);
    const added = await client.query(
      `insert into watchlist_targets (watchlist_id, target_id)
       select $1, t.id from tracking_targets t where t.workspace_id = $2 and t.active and t.id = any($3::uuid[])
       on conflict do nothing`,
      [watchlistId, workspaceId, wanted],
    );
    const { rows: removed } = await client.query(
      `delete from watchlist_targets wt using tracking_targets t
        where wt.watchlist_id = $1 and t.id = wt.target_id and t.active and not (wt.target_id = any($2::uuid[]))
        returning wt.target_id`,
      [watchlistId, wanted],
    );
    const gone = removed.map((r) => r.target_id);
    const unfollowed = gone.length
      ? await client.query(
          `delete from tracking_targets t where t.id = any($1::uuid[]) and t.workspace_id = $2 and not exists (select 1 from watchlist_targets wt where wt.target_id = t.id)`,
          [gone, workspaceId],
        )
      : { rowCount: 0 };
    return { added: added.rowCount, removed: gone.length, unfollowed: unfollowed.rowCount };
  });
}
