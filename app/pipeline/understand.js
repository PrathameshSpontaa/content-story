// Understanding: the cheap model writes a story card for every new post and groups the comments
// under every post that has them. Code builds the inputs, checks what comes back (ids, verbatim
// quotes, comment membership) and writes story_cards, claims, entities and comment_groups.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from '../lib/db.js';
import { isFake, readFixtureOutput } from './fixtures.js';

export const PROMPT_VERSION = 'prod-2026-09-16';
const BATCH = { cards: 12, groups: 4 };
const PARALLEL = 3;
const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), 'prompts');

const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const normalizeText = (s) => String(s ?? '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

const userMessage = (input) =>
  `The input is a JSON array of ${input.length} items. Apply the instructions to each item and return one JSON object, {"items": [...]}, whose items array has exactly ${input.length} output objects in the same order.\n\nInput:\n${JSON.stringify(input)}`;

// The AI client is another module; until it exists the prompts are read from disk and fake
// mode reads the dry run's checked outputs directly.
async function loadAi() {
  try {
    return await import('./ai.js');
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}
const readPrompt = (ai, name) => (ai?.loadPrompt ? ai.loadPrompt(name) : readFileSync(join(PROMPTS, `${name}.md`), 'utf8'));
const modelName = (ai) => ai?.MODELS?.cheap?.() ?? 'fixture:dryrun';

// One batch in, one array out in the same order. In fake mode every item is answered from the
// dry-run fixture for that post (through ai.js when it is there, else straight from disk).
async function askModel({ ai, step, system, batch, runId, label }) {
  const postIdOf = (item) => (step === 'cards' ? item.post_id : item.post.post_id);
  if (!ai?.generateJson) {
    if (!isFake()) throw new Error('pipeline/ai.js is missing; set PIPELINE_PROVIDER=fake or add the AI client');
    return batch.map((item) => ({ output: readFixtureOutput(step, postIdOf(item)), model: 'fixture:dryrun' }));
  }
  const result = await ai.generateJson({ model: modelName(ai), system, user: userMessage(batch), step, label, runId, workspaceId: null, maxOutputTokens: 32768 });
  // The answer is {"items": [...]} (OpenAI's JSON mode can't return a bare array); fake mode answers
  // with the array itself.
  const list = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [result];
  // Outputs follow input order, so a mistyped post_id is recovered from its position.
  return batch.map((item, i) => {
    const output = list[i] ?? null;
    if (output && output.post_id !== postIdOf(item) && !batch.some((b) => postIdOf(b) === output.post_id)) output.post_id = postIdOf(item);
    return { output, model: modelName(ai) };
  });
}

async function inBatches(items, size, fn) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const queue = batches.map((batch, i) => ({ batch, i }));
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) {
      const { batch, i } = queue.shift();
      await fn(batch, i + 1);
    }
  }));
  return batches.length;
}

// ---------- checks (the dry run's ingest rules) ----------

function checkCard(card, post) {
  if (!card || card.post_id !== post.post_id) return 'no output for this post';
  const missing = ['about', 'type', 'category'].filter((k) => typeof card[k] !== 'string' || !card[k].trim());
  if (typeof card.newsworthy !== 'boolean') missing.push('newsworthy');
  if (missing.length) return `missing ${missing.join(', ')}`;
  card.entities = Array.isArray(card.entities) ? card.entities.filter((e) => e?.name) : [];
  card.events = Array.isArray(card.events) ? card.events.filter((e) => e?.what) : [];
  card.claims = Array.isArray(card.claims) ? card.claims.filter((c) => c?.text) : [];
  const source = normalizeText(`${post.text} ${post.transcript}`);
  card.claims.forEach((claim, i) => {
    claim.claim_id = `${card.post_id}#c${i + 1}`;
    // A quote the model can't show verbatim is worse than no quote.
    if (claim.quote && !source.includes(normalizeText(claim.quote))) claim.quote = null;
  });
  return null;
}

function checkGroups(result, postId, sentIds) {
  if (!result || result.post_id !== postId) return 'no output for this post';
  const allowed = new Set(sentIds);
  const seen = new Set();
  result.dropped = (result.dropped ?? []).filter((id) => allowed.has(id) && !seen.has(id) && seen.add(id));
  result.groups = (Array.isArray(result.groups) ? result.groups : [])
    .map((g, i) => {
      const ids = [];
      for (const cid of g.comment_ids ?? []) {
        if (allowed.has(cid) && !seen.has(cid)) {
          seen.add(cid);
          ids.push(cid);
        }
      }
      const samples = (g.sample_ids ?? []).filter((s) => ids.includes(s));
      return { ...g, group_id: `${postId}#g${i + 1}`, comment_ids: ids, sample_ids: samples.length ? samples : ids.slice(0, 3) };
    })
    .filter((g) => g.comment_ids.length && typeof g.label === 'string' && typeof g.point === 'string');
  const unassigned = [...allowed].filter((id) => !seen.has(id));
  if (unassigned.length > allowed.size * 0.2) return `${unassigned.length} of ${allowed.size} comments not placed in any group`;
  return null;
}

// ---------- writing ----------

// 'astra' and 'gpt-6 astra' already point at one entity; a new name gets a new entity and alias.
async function ensureEntity(client, cache, name, type) {
  const alias = String(name ?? '').trim().toLowerCase();
  if (!alias) return null;
  if (cache.has(alias)) return cache.get(alias);
  const id = randomUUID();
  await client.query('insert into entities (id, name, type) values ($1, $2, $3)', [id, String(name).trim(), type ?? 'other']);
  const { rows } = await client.query('insert into entity_aliases (alias, entity_id) values ($1, $2) on conflict (alias) do nothing returning entity_id', [alias, id]);
  let entityId = rows[0]?.entity_id;
  if (!entityId) {
    // Another run added the alias first; use theirs and drop the entity we just made.
    entityId = (await client.query('select entity_id from entity_aliases where alias = $1', [alias])).rows[0].entity_id;
    await client.query('delete from entities where id = $1', [id]);
  }
  cache.set(alias, entityId);
  return entityId;
}

async function writeCard(client, card, model, aliasCache) {
  await client.query(
    `insert into story_cards (post_id, about, type, newsworthy, category, events, model, prompt_version)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (post_id) do update set about = excluded.about, type = excluded.type, newsworthy = excluded.newsworthy, category = excluded.category,
       events = excluded.events, model = excluded.model, prompt_version = excluded.prompt_version, created_at = now()`,
    [card.post_id, card.about, card.type, card.newsworthy, card.category, JSON.stringify(card.events ?? []), model, PROMPT_VERSION],
  );
  await client.query('delete from claims where post_id = $1', [card.post_id]);
  for (const k of card.claims) {
    await client.query('insert into claims (id, post_id, text, kind, about, stance, quote) values ($1, $2, $3, $4, $5, $6, $7)', [
      k.claim_id, card.post_id, k.text, k.kind ?? 'other', k.about ?? null, k.stance ?? null, k.quote ?? null,
    ]);
  }
  await client.query('delete from post_entities where post_id = $1', [card.post_id]);
  const seen = new Set();
  for (const e of card.entities) {
    const entityId = await ensureEntity(client, aliasCache, e.name, e.type);
    if (!entityId || seen.has(entityId)) continue;
    seen.add(entityId);
    await client.query('insert into post_entities (post_id, entity_id, salience) values ($1, $2, $3)', [card.post_id, entityId, Number(e.salience) || 0]);
  }
}

async function writeGroups(client, result, model) {
  await client.query('delete from comment_groups where post_id = $1', [result.post_id]);
  for (const g of result.groups) {
    await client.query(
      `insert into comment_groups (id, post_id, label, point, reaction_to_creator, tone, comment_ids, sample_ids, model, prompt_version)
       values ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10)`,
      [g.group_id, result.post_id, g.label, g.point, g.reaction_to_creator ?? 'other', g.tone ?? null, g.comment_ids, g.sample_ids, model, PROMPT_VERSION],
    );
  }
}

// ---------- entry point ----------

// Cards for posts without one and groups for commented posts without any (all posts, or the given
// ids). `force` redoes the given posts even when they already have output. Returns written counts.
export async function understandNewPosts({ runId = null, postIds = null, force = false, log = console.log } = {}) {
  const ai = await loadAi();
  const counts = { cards: 0, groups: 0, cardsRejected: 0, groupsRejected: 0 };
  const aliasCache = new Map((await pool.query('select alias, entity_id from entity_aliases')).rows.map((r) => [r.alias, r.entity_id]));

  // Cards
  const { rows: cardPosts } = await pool.query(
    `select p.id as post_id, p.platform::text as platform, p.kind, p.text, p.transcript, p.shared_urls, p.published_at,
            coalesce(c.name, p.community) as creator, coalesce(h.handle, p.community) as handle, m.lift
       from posts p
       left join creator_handles h on h.id = p.handle_id
       left join creators c on c.id = h.creator_id
       left join lateral (select lift from post_metrics m where m.post_id = p.id order by m.captured_at desc limit 1) m on true
      where ($1::text[] is null or p.id = any($1::text[]))
        and ($2::boolean or not exists (select 1 from story_cards sc where sc.post_id = p.id))
      order by p.published_at`,
    [postIds, force && postIds != null],
  );
  if (cardPosts.length) {
    log(`cards: reading ${cardPosts.length} posts in batches of ${BATCH.cards}`);
    const system = readPrompt(ai, '01_story_card');
    const batches = await inBatches(cardPosts, BATCH.cards, async (batch, n) => {
      const input = batch.map((p) => ({
        post_id: p.post_id, platform: p.platform, creator: p.creator, handle: p.handle, published_at: p.published_at, kind: p.kind,
        text: truncate(p.text, 4000), transcript: truncate(p.transcript, 8000), shared_urls: p.shared_urls || [], lift: p.lift == null ? null : Number(p.lift),
      }));
      let answers;
      try {
        answers = await askModel({ ai, step: 'cards', system, batch: input, runId, label: `cards-${n}`, log });
      } catch (err) {
        log(`[cards] batch ${n} failed: ${err.message.slice(0, 200)}`);
        counts.cardsRejected += batch.length;
        return;
      }
      for (const [i, post] of batch.entries()) {
        const { output: card, model } = answers[i];
        const issue = checkCard(card, post);
        if (issue) {
          counts.cardsRejected += 1;
          log(`[cards] ${post.post_id} rejected: ${issue}`);
          continue;
        }
        await tx((client) => writeCard(client, card, model, aliasCache));
        counts.cards += 1;
      }
    });
    log(`cards: ${counts.cards} written, ${counts.cardsRejected} rejected, ${batches} batches`);
  } else log('cards: nothing to do');

  // Comment groups
  const { rows: groupPosts } = await pool.query(
    `select p.id as post_id, p.platform::text as platform, p.text,
            coalesce(c.name, p.community) as creator, coalesce(h.handle, p.community) as handle, sc.about
       from posts p
       left join creator_handles h on h.id = p.handle_id
       left join creators c on c.id = h.creator_id
       left join story_cards sc on sc.post_id = p.id
      where ($1::text[] is null or p.id = any($1::text[]))
        and exists (select 1 from comments k where k.post_id = p.id)
        and ($2::boolean or not exists (select 1 from comment_groups g where g.post_id = p.id))
      order by p.published_at`,
    [postIds, force && postIds != null],
  );
  if (groupPosts.length) {
    log(`groups: sorting comments on ${groupPosts.length} posts in batches of ${BATCH.groups}`);
    const system = readPrompt(ai, '02_comment_groups');
    const { rows: allComments } = await pool.query(
      'select id, post_id, parent_id, author, is_creator, likes, text from comments where post_id = any($1::text[]) order by likes desc',
      [groupPosts.map((p) => p.post_id)],
    );
    const byPost = new Map();
    for (const k of allComments) byPost.set(k.post_id, [...(byPost.get(k.post_id) ?? []), k]);
    const batches = await inBatches(groupPosts, BATCH.groups, async (batch, n) => {
      const input = batch.map((p) => ({
        post: { post_id: p.post_id, platform: p.platform, creator: p.creator, handle: p.handle, text: truncate([p.text, p.about && `(summary) ${p.about}`].filter(Boolean).join('\n'), 1500) },
        comments: (byPost.get(p.post_id) ?? []).slice(0, 80).map((k) => ({
          comment_id: k.id, parent_id: k.parent_id ?? null, author: k.author, is_creator: Boolean(k.is_creator), likes: Number(k.likes) || 0, text: truncate(k.text, 600),
        })),
      }));
      let answers;
      try {
        answers = await askModel({ ai, step: 'groups', system, batch: input, runId, label: `groups-${n}`, log });
      } catch (err) {
        log(`[groups] batch ${n} failed: ${err.message.slice(0, 200)}`);
        counts.groupsRejected += batch.length;
        return;
      }
      for (const [i, p] of batch.entries()) {
        const { output, model } = answers[i];
        const issue = checkGroups(output, p.post_id, input[i].comments.map((k) => k.comment_id));
        if (issue) {
          counts.groupsRejected += 1;
          log(`[groups] ${p.post_id} rejected: ${issue}`);
          continue;
        }
        if (!output.groups.length) {
          // Every comment was spam or off-topic: nothing to store, and the post is asked about again next run.
          log(`[groups] ${p.post_id}: all ${input[i].comments.length} comments dropped, no groups`);
          continue;
        }
        await tx((client) => writeGroups(client, output, model));
        counts.groups += 1;
      }
    });
    log(`groups: ${counts.groups} written, ${counts.groupsRejected} rejected, ${batches} batches`);
  } else log('groups: nothing to do');

  return counts;
}
