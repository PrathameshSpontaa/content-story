// Loads the dry-run week (dryrun/data) into Postgres: creators, handles, posts, metrics, comments,
// story cards, claims, entities, comment groups, and the 8 finished stories as the shared feed.
// Safe to re-run: content rows are upserted, and the shared feed's stories are replaced.
// Usage: node scripts/import-dryrun.js
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { handleFor, readAvatars } from './dryrun-profiles.js';

const DRYRUN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dryrun');
const DATA = join(DRYRUN, 'data');
const read = (...parts) => JSON.parse(readFileSync(join(DATA, ...parts), 'utf8'));
const readIf = (...parts) => (existsSync(join(DATA, ...parts)) ? read(...parts) : null);
const readDir = (dir) => (existsSync(join(DATA, dir)) ? readdirSync(join(DATA, dir)).filter((f) => f.endsWith('.json')).map((f) => read(dir, f)) : []);

const MODELS = { cards: 'claude-haiku', groups: 'claude-haiku', builder: 'claude-sonnet', writer: 'claude-sonnet', lens: 'claude-sonnet', edit: 'claude-sonnet' };
const PROMPT_VERSION = 'dryrun-2026-09-13';
const SHARED_FEED_NAME = 'AI & tech (shared)';

const creatorsConfig = JSON.parse(readFileSync(join(DRYRUN, 'config', 'creators.json'), 'utf8')).creators;
const posts = read('posts.json');
const comments = read('comments.json');
const cards = readDir('cards');
const groupFiles = readDir('groups');
const { stories } = read('stories.json');
const collectedAt = read('raw', 'meta.json').collected_at;
const now = new Date().toISOString();
const avatars = readAvatars(DATA, posts);

// Inserts many rows in one statement; the JSON keys must match the table's columns.
async function insertRows(client, table, rows, conflict = 'do nothing') {
  if (!rows.length) return 0;
  const { rowCount } = await client.query(
    `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb) on conflict ${conflict}`,
    [JSON.stringify(rows)],
  );
  return rowCount;
}

const client = await pool.connect();
const counts = {};
try {
  await client.query('begin');

  // Creators and their handles
  const creatorIds = new Map();
  const handleIds = new Map(); // `${creatorId}|${platform}` → handle uuid
  for (const c of creatorsConfig) {
    const existing = await client.query('select id from creators where name = $1', [c.name]);
    const creatorId = existing.rows[0]?.id ?? (await client.query('insert into creators (name) values ($1) returning id', [c.name])).rows[0].id;
    creatorIds.set(c.id, creatorId);
    for (const [platform, account] of Object.entries(c.handles)) {
      const { rows } = await client.query(
        `insert into creator_handles (creator_id, platform, handle, url, verified, avatar_url)
         values ($1, $2, $3, $4, true, $5)
         on conflict (platform, (lower(handle))) do update set url = excluded.url, avatar_url = coalesce(excluded.avatar_url, creator_handles.avatar_url)
         returning id`,
        [creatorId, platform, handleFor(platform, account), account.url, avatars.get(`${c.id}|${platform}`) ?? null],
      );
      handleIds.set(`${c.id}|${platform}`, rows[0].id);
    }
  }
  counts.creators = creatorIds.size;
  counts.creator_handles = handleIds.size;

  // Posts and one metrics snapshot each
  counts.posts = await insertRows(
    client,
    'posts',
    posts.map((p) => ({
      id: p.post_id,
      platform: p.platform,
      platform_post_id: p.raw_id,
      handle_id: p.creator_id ? handleIds.get(`${p.creator_id}|${p.platform}`) ?? null : null,
      community: p.creator_id ? null : p.handle,
      url: p.url ?? '',
      kind: p.kind,
      text: p.text ?? '',
      transcript: p.transcript ?? '',
      shared_urls: p.shared_urls ?? [],
      published_at: p.published_at,
      raw_capture_id: null,
    })),
  );
  counts.post_metrics = await insertRows(
    client,
    'post_metrics',
    posts.map((p) => ({
      post_id: p.post_id,
      captured_at: collectedAt,
      likes: p.metrics.likes,
      comments: p.metrics.comments,
      shares: p.metrics.shares,
      views: p.metrics.views,
      engagement: p.engagement ?? null,
      lift: p.lift ?? null,
    })),
  );
  counts.comments = await insertRows(
    client,
    'comments',
    comments.map((c) => ({
      id: c.comment_id,
      post_id: c.post_id,
      parent_id: c.parent_id ?? null,
      author: c.author ?? 'unknown',
      is_creator: Boolean(c.is_creator),
      likes: c.likes ?? 0,
      text: c.text,
      published_at: c.published_at ?? null,
      time_approx: Boolean(c.time_approx),
      url: c.url ?? null,
    })),
  );

  // Story cards, claims, entities
  counts.story_cards = await insertRows(
    client,
    'story_cards',
    cards.map((c) => ({
      post_id: c.post_id,
      about: c.about,
      type: c.type,
      newsworthy: c.newsworthy,
      category: c.category,
      events: c.events ?? [],
      model: MODELS.cards,
      prompt_version: PROMPT_VERSION,
      created_at: now,
    })),
    '(post_id) do update set about = excluded.about, type = excluded.type, newsworthy = excluded.newsworthy, category = excluded.category, events = excluded.events',
  );
  counts.claims = await insertRows(
    client,
    'claims',
    cards.flatMap((c) => (c.claims ?? []).map((k) => ({ id: k.claim_id, post_id: c.post_id, text: k.text, kind: k.kind, about: k.about ?? null, stance: k.stance ?? null, quote: k.quote ?? null }))),
  );

  const entityByAlias = new Map((await client.query('select alias, entity_id from entity_aliases')).rows.map((r) => [r.alias, r.entity_id]));
  const newEntities = [];
  const ensureEntity = (name, type) => {
    const alias = String(name).trim().toLowerCase();
    if (!alias) return null;
    if (!entityByAlias.has(alias)) {
      const id = randomUUID();
      entityByAlias.set(alias, id);
      newEntities.push({ id, name: String(name).trim(), type: type ?? 'other', alias });
    }
    return entityByAlias.get(alias);
  };
  const postEntities = new Map();
  for (const c of cards) {
    for (const e of c.entities ?? []) {
      const entityId = ensureEntity(e.name, e.type);
      if (entityId) postEntities.set(`${c.post_id}|${entityId}`, { post_id: c.post_id, entity_id: entityId, salience: Number(e.salience) || 0 });
    }
  }
  const narratives = new Map(stories.map((s) => [s.story_id, readIf('narrative', `${s.story_id}.json`)]));
  for (const n of narratives.values()) if (n?.main_character?.name) ensureEntity(n.main_character.name, 'subject');
  counts.entities = await insertRows(client, 'entities', newEntities.map(({ id, name, type }) => ({ id, name, type })));
  await insertRows(client, 'entity_aliases', newEntities.map(({ id, alias }) => ({ alias, entity_id: id })));
  counts.post_entities = await insertRows(client, 'post_entities', [...postEntities.values()]);

  counts.comment_groups = await insertRows(
    client,
    'comment_groups',
    groupFiles.flatMap((g) =>
      (g.groups ?? []).map((grp) => ({
        id: grp.group_id,
        post_id: g.post_id,
        label: grp.label,
        point: grp.point,
        reaction_to_creator: grp.reaction_to_creator,
        tone: grp.tone ?? null,
        comment_ids: grp.comment_ids,
        sample_ids: grp.sample_ids,
        model: MODELS.groups,
        prompt_version: PROMPT_VERSION,
      })),
    ),
  );

  // The shared feed and its stories (replaced on every import)
  const feed = await client.query('select id from feeds where workspace_id is null limit 1');
  const feedId = feed.rows[0]?.id ?? (await client.query('insert into feeds (name) values ($1) returning id', [SHARED_FEED_NAME])).rows[0].id;
  await client.query('delete from stories where feed_id = $1', [feedId]);

  const storyRows = [];
  const storyPostRows = [];
  const versionRows = [];
  const mapping = [];
  for (const s of stories) {
    const narrative = narratives.get(s.story_id);
    const stats = readIf('stats', `${s.story_id}.json`);
    const written = readIf('written', `${s.story_id}.json`);
    if (!narrative || !stats || !written) continue;
    const check = readIf('verify', `${s.story_id}.json`);
    const id = randomUUID();
    mapping.push(`${s.story_id} → ${id}`);
    storyRows.push({
      id,
      feed_id: feedId,
      status: 'active',
      category: stats.category ?? null,
      main_entity_id: entityByAlias.get(String(narrative.main_character?.name ?? '').trim().toLowerCase()) ?? null,
      merged_into: null,
      first_post_at: stats.first_post_at,
      last_post_at: stats.last_post_at,
      heat: stats.heat,
      published_at: check?.pass ? now : null,
      created_at: now,
    });
    for (const postId of s.post_ids) {
      storyPostRows.push({ story_id: id, post_id: postId, reason: s.why ?? null, confidence: s.confidence ?? null, added_at: now });
    }
    versionRows.push({
      id: randomUUID(),
      story_id: id,
      version: 1,
      narrative,
      stats,
      written,
      platform_takes: readIf('lens', `${s.story_id}.json`) ?? {},
      feed_edit: readIf('edit', `${s.story_id}.json`),
      checks: check ?? { pass: false, errors: ['not checked'], warnings: [] },
      passed: Boolean(check?.pass),
      models: MODELS,
      created_at: now,
    });
  }
  counts.stories = await insertRows(client, 'stories', storyRows);
  counts.story_posts = await insertRows(client, 'story_posts', storyPostRows);
  counts.story_versions = await insertRows(client, 'story_versions', versionRows);

  await client.query('commit');
  console.log('imported (new rows this run):');
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(16)} ${n}`);
  console.log(`stories in the shared feed:\n  ${mapping.join('\n  ')}`);
} catch (err) {
  await client.query('rollback');
  console.error(`import failed, nothing was written: ${err.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
