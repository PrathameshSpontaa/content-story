// Story building: groups newly understood posts into new stories or attaches them to existing ones,
// then for every story that changed runs the narrative builder, writer, platform lens and feed editor,
// with code doing every number and check, and writes a new version. Stories are never deleted.
// In the shared feed the AI editor publishes, holds or rejects stories and merges split pairs.
import { createHash, randomUUID } from 'node:crypto';
import { pool, tx } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { judgeSameStory, reviewStory } from './editor.js';
import { MODELS, RETRY_MARKER, generateJson, loadPrompt } from './gemini.js';
import { commentWeight, computeStats, entityRanking, heatScore, round1, storyCounts } from './stats.js';
import { lengthProblems, mainCharacterProblem, sameName, verifyStory } from './verify.js';

export const PROMPT_VERSION = 'prod-2026-09-16';
export const STATUSES = ['draft', 'emerging', 'active', 'peaked', 'dormant', 'merged', 'rejected'];
const LIVE = ['draft', 'emerging', 'active', 'peaked'];
const PLATFORM_ORDER = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];
const DAY = 86_400_000;

const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
export const dormantDays = () => envNumber('STORY_DORMANT_DAYS', 4);
const windowDays = () => envNumber('STORY_WINDOW_DAYS', 7);
const parallel = () => envNumber('STORY_PARALLEL', 2);

const ms = (value) => (value == null ? NaN : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));
const iso = (value) => (value == null ? null : new Date(ms(value)).toISOString());
const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const lower = (s) => String(s ?? '').trim().toLowerCase();
const stripCites = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');
const sourceKey = (p) => p.creator_id ?? p.handle ?? `post:${p.post_id}`;

// ─── Loading ────────────────────────────────────────────────────────────────

// Posts, cards, claims, entities, comment groups and comments for the given posts, in the shapes the
// dry run's files had, so the prompts and checks see the same inputs.
export async function loadWorld(postIds) {
  const ids = [...new Set(postIds)];
  const q = (sql) => pool.query(sql, [ids]).then((r) => r.rows);
  const [posts, cards, claims, entities, groups, comments] = await Promise.all([
    q(`select p.id, p.platform::text as platform, p.kind, p.url, p.text, p.transcript, p.shared_urls, p.published_at, p.community,
              coalesce(h.handle, p.community) as handle, c.id::text as creator_id, coalesce(c.name, p.community, h.handle) as creator, m.lift::float as lift
         from posts p
         left join creator_handles h on h.id = p.handle_id
         left join creators c on c.id = h.creator_id
         left join lateral (select lift from post_metrics m where m.post_id = p.id order by m.captured_at desc limit 1) m on true
        where p.id = any($1::text[])`),
    q(`select post_id, about, type, newsworthy, category, events, model from story_cards where post_id = any($1::text[])`),
    q(`select id, post_id, text, kind, about, stance, quote from claims where post_id = any($1::text[]) order by id`),
    q(`select pe.post_id, pe.entity_id::text, pe.salience::float as salience, e.name, e.type
         from post_entities pe join entities e on e.id = pe.entity_id where pe.post_id = any($1::text[]) order by pe.salience desc`),
    q(`select id, post_id, label, point, reaction_to_creator, tone, comment_ids, sample_ids, model from comment_groups where post_id = any($1::text[]) order by id`),
    q(`select id, post_id, parent_id, author, is_creator, likes::float as likes, text, published_at, time_approx, url from comments where post_id = any($1::text[])`),
  ]);

  const postById = new Map(posts.map((p) => [p.id, { ...p, post_id: p.id, published_at: iso(p.published_at) }]));
  const cardByPost = new Map(cards.map((c) => [c.post_id, { ...c, entities: [], claims: [] }]));
  const claimById = new Map();
  for (const k of claims) {
    const claim = { claim_id: k.id, post_id: k.post_id, text: k.text, kind: k.kind, about: k.about, stance: k.stance, quote: k.quote };
    claimById.set(k.id, claim);
    cardByPost.get(k.post_id)?.claims.push(claim);
  }
  for (const e of entities) cardByPost.get(e.post_id)?.entities.push({ name: e.name, type: e.type, salience: e.salience, entity_id: e.entity_id });
  const groupById = new Map();
  const groupsByPost = new Map();
  for (const g of groups) {
    const group = { ...g, group_id: g.id };
    groupById.set(g.id, group);
    groupsByPost.set(g.post_id, [...(groupsByPost.get(g.post_id) ?? []), group]);
  }
  const commentById = new Map(
    comments.map((c) => [c.id, { ...c, comment_id: c.id, platform: postById.get(c.post_id)?.platform, published_at: iso(c.published_at) }]),
  );
  return { postById, cardByPost, claimById, groupById, groupsByPost, commentById };
}

// What a story's inputs look like: its posts and each comment group with its size. A story is
// rebuilt when this changes (new posts attached, or new comments grouped under its posts).
export function fingerprint(postIds, groupSizes) {
  const text = `${[...postIds].sort().join(',')}|${[...groupSizes].sort().join(',')}`;
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
const worldFingerprint = (world, postIds) =>
  fingerprint(postIds, [...world.groupById.values()].filter((g) => postIds.includes(g.post_id)).map((g) => `${g.id}:${g.comment_ids.length}`));

async function storedFingerprints(storyIds) {
  if (!storyIds.length) return new Map();
  const { rows } = await pool.query(
    `select s.id,
            array(select sp.post_id from story_posts sp where sp.story_id = s.id) as post_ids,
            array(select g.id || ':' || cardinality(g.comment_ids) from story_posts sp join comment_groups g on g.post_id = sp.post_id where sp.story_id = s.id) as groups,
            (select v.stats ->> 'input_fingerprint' from story_versions v where v.story_id = s.id order by v.version desc limit 1) as stored
       from stories s where s.id = any($1::uuid[])`,
    [storyIds],
  );
  return new Map(rows.map((r) => [r.id, { current: fingerprint(r.post_ids, r.groups), stored: r.stored }]));
}

// ─── Entity aliases ─────────────────────────────────────────────────────────

const GENERIC = new Set(['ai', 'app', 'apps', 'model', 'models', 'agent', 'agents', 'pro', 'max', 'mini', 'plus', 'ultra', 'flash', 'lite', 'the', 'labs', 'inc']);
const nameWords = (name) => lower(name).split(/\s+/).filter(Boolean);

// Names in one story that are the same thing: a shorter name of the same type that is a whole-word
// suffix of exactly one longer name ("Astra" → "GPT-6 Astra"), or of two or more words and contained
// in it. A prefix alone ("iPhone" in "iPhone Duo") is not enough; neither is a generic word.
export function findAliasMerges(entities) {
  const unique = [...new Map(entities.map((e) => [`${lower(e.name)}|${e.type}`, e])).values()];
  const merges = [];
  for (const a of unique) {
    const wa = nameWords(a.name);
    if (!wa.length || (wa.length === 1 && GENERIC.has(wa[0]))) continue;
    const longer = unique.filter((b) => {
      const wb = nameWords(b.name);
      if (b === a || b.type !== a.type || wb.length <= wa.length) return false;
      const suffix = wb.slice(-wa.length).join(' ') === wa.join(' ');
      const contained = wa.length >= 2 && ` ${wb.join(' ')} `.includes(` ${wa.join(' ')} `);
      return suffix || contained;
    });
    if (longer.length === 1) merges.push({ alias: lower(a.name), name: a.name, into: longer[0].name, type: a.type });
  }
  return merges;
}

async function loadAliases() {
  const { rows } = await pool.query('select alias, entity_id::text from entity_aliases');
  return new Map(rows.map((r) => [r.alias, r.entity_id]));
}

// Points the shorter name's alias at the longer name's entity, so both count as one from now on.
async function applyAliasMerges(merges, aliases, log) {
  for (const m of merges) {
    const into = aliases.get(lower(m.into));
    if (!into || aliases.get(m.alias) === into) continue;
    await pool.query(
      `insert into entity_aliases (alias, entity_id) values ($1, $2) on conflict (alias) do update set entity_id = excluded.entity_id`,
      [m.alias, into],
    );
    aliases.set(m.alias, into);
    log(`[stories] alias: "${m.name}" now counts as "${m.into}"`);
  }
}

// ─── AI steps ───────────────────────────────────────────────────────────────

async function ask(ctx, { step, prompt, input, label, problems = null, model = MODELS.strong() }) {
  let user = `Input:\n${JSON.stringify(input)}\n\nReturn only the JSON described under Output.`;
  if (problems?.length) user += `\n\n${RETRY_MARKER}:\n- ${problems.join('\n- ')}\nFix these and return the whole JSON again.`;
  const out = await generateJson({ model, system: loadPrompt(prompt), user, step, label, runId: ctx.runId, workspaceId: ctx.workspaceId });
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(`${step}/${label}: expected one JSON object`);
  return out;
}

function groupingInput(world, windowIds, existing) {
  const cards = windowIds
    .map((id) => [world.postById.get(id), world.cardByPost.get(id)])
    .filter(([p, c]) => p && c)
    .sort(([a], [b]) => ms(a.published_at) - ms(b.published_at))
    .map(([p, c]) => ({
      post_id: p.post_id, platform: p.platform, creator: p.creator, published_at: p.published_at, lift: p.lift ?? null, about: c.about,
      entities: c.entities.map((e) => e.name), claims: c.claims.map((k) => k.text), shared_urls: p.shared_urls ?? [], quotes_post_id: null,
    }));
  const times = cards.map((c) => c.published_at).filter(Boolean).sort();
  return {
    window: { from: times[0]?.slice(0, 10) ?? null, to: times.at(-1)?.slice(0, 10) ?? null },
    cards,
    existing_stories: existing.map((s) => ({ story_id: s.id, main_entity: s.main_entity, headline: s.headline, last_post_at: iso(s.last_post_at), post_ids: s.post_ids })),
  };
}

function builderInput(world, postIds, { label, title, ranking }) {
  const cards = [];
  const commentGroups = [];
  const creatorReplies = [];
  for (const postId of postIds) {
    const post = world.postById.get(postId);
    const card = world.cardByPost.get(postId);
    if (!post || !card) continue;
    cards.push({
      post_id: postId, platform: post.platform, creator: post.creator, handle: post.handle, published_at: post.published_at, lift: post.lift ?? null, url: post.url,
      about: card.about, type: card.type, claims: card.claims.map(({ post_id, ...k }) => k), events: card.events ?? [],
    });
    for (const g of world.groupsByPost.get(postId) ?? []) {
      const ids = g.comment_ids.filter((id) => world.commentById.has(id));
      commentGroups.push({
        group_id: g.id, post_id: postId, platform: post.platform, label: g.label, point: g.point, reaction_to_creator: g.reaction_to_creator, size: ids.length,
        like_weight: round1(ids.reduce((sum, id) => sum + commentWeight(world.commentById.get(id).likes), 0)),
        samples: g.sample_ids.filter((id) => world.commentById.has(id)).slice(0, 5).map((id) => ({ comment_id: id, likes: world.commentById.get(id).likes || 0, text: truncate(world.commentById.get(id).text, 300) })),
      });
    }
    for (const c of world.commentById.values()) {
      if (c.post_id === postId && c.is_creator) creatorReplies.push({ comment_id: c.id, post_id: postId, author: c.author, summary: truncate(c.text, 200) });
    }
  }
  return {
    story: { story_id: label, working_title: title },
    entity_ranking: ranking.map(({ name, type, posts_mentioning, score }) => ({ name, type, posts_mentioning, score })),
    cards,
    comment_groups: commentGroups,
    creator_replies: creatorReplies,
  };
}

function writerInput(world, postIds, narrative, stats, builderIn) {
  const commentIds = new Set();
  for (const b of narrative.beats ?? []) (b.source_comment_ids ?? []).forEach((id) => commentIds.add(id));
  for (const a of narrative.angles ?? []) (a.evidence ?? []).forEach((e) => world.commentById.has(e.source_id) && commentIds.add(e.source_id));
  for (const g of builderIn.comment_groups) g.samples.forEach((s) => commentIds.add(s.comment_id));
  for (const r of builderIn.creator_replies) commentIds.add(r.comment_id);
  return {
    narrative,
    numbers: {
      creators: stats.creators,
      platforms: stats.platforms,
      heat: stats.heat,
      beat_times: stats.beat_times.map((b) => b.at),
      turning_points: stats.turning_points,
      angle_reactions: stats.angle_reactions.map((a) => ({
        angle_index: a.angle_index,
        by_platform: a.by_platform.map(({ platform, agree_pct, disagree_pct, asks, comments }) => ({ platform, agree_pct, disagree_pct, asks, comments })),
      })),
      reaction_shifts: stats.reaction_shifts,
    },
    sources: {
      posts: postIds.map((id) => world.postById.get(id)).filter(Boolean).map((p) => ({
        post_id: p.post_id, platform: p.platform, handle: p.handle, text: truncate(p.text, 1200), transcript_excerpt: truncate(p.transcript, 1200),
      })),
      comments: [...commentIds].slice(0, 200).map((id) => world.commentById.get(id)).filter(Boolean).map((c) => ({
        comment_id: c.id, post_id: c.post_id, author: c.author, likes: c.likes || 0, text: truncate(c.text, 400),
      })),
    },
  };
}

function lensInput(world, postIds, narrative, stats, { label, title }) {
  const posts = postIds.map((id) => world.postById.get(id)).filter(Boolean);
  const platforms = PLATFORM_ORDER.filter((pl) => posts.some((p) => p.platform === pl)).map((platform) => {
    const mine = posts.filter((p) => p.platform === platform);
    const commentGroups = mine.flatMap((p) =>
      (world.groupsByPost.get(p.post_id) ?? []).map((g) => ({
        group_id: g.id, post_id: p.post_id, label: g.label, point: g.point, reaction_to_creator: g.reaction_to_creator,
        size: g.comment_ids.filter((id) => world.commentById.has(id)).length,
        samples: g.sample_ids.filter((id) => world.commentById.has(id)).slice(0, 3).map((id) => ({ comment_id: id, likes: world.commentById.get(id).likes || 0, text: truncate(world.commentById.get(id).text, 280) })),
      })),
    );
    return {
      platform,
      creators: [...new Set(mine.map((p) => (p.creator && p.handle && p.creator !== p.handle ? `${p.creator} (${p.handle})` : p.creator ?? p.handle)).filter(Boolean))],
      posts: mine.map((p) => {
        const card = world.cardByPost.get(p.post_id);
        return {
          post_id: p.post_id, creator: p.creator, handle: p.handle, kind: p.kind, published_at: p.published_at, lift: p.lift ?? null, about: card?.about ?? '',
          claims: (card?.claims ?? []).map((c) => ({ claim_id: c.claim_id, text: c.text, stance: c.stance, quote: c.quote })),
          text_excerpt: truncate(p.text, 500),
        };
      }),
      comment_groups: commentGroups,
      numbers: {
        posts: mine.length,
        comments_grouped: commentGroups.reduce((sum, g) => sum + g.size, 0),
        angle_agreement: stats.angle_reactions
          .map((a) => {
            const row = a.by_platform.find((b) => b.platform === platform);
            return row ? { angle_index: a.angle_index, agree_pct: row.agree_pct, comments: row.comments, asks: row.asks } : null;
          })
          .filter(Boolean),
      },
    };
  });
  return {
    story: {
      story_id: label, working_title: title, main_character: narrative.main_character?.name,
      angles: (narrative.angles ?? []).map((a, i) => ({ angle_index: i, title: a.title, thesis: a.thesis })),
    },
    platforms,
  };
}

function editInput(label, narrative, written, lens, stats) {
  return {
    story_id: label,
    main_character: narrative.main_character?.name,
    current_headline: written.headline,
    narrative: (written.narrative ?? []).map((s) => stripCites(s.sentence)),
    contrast: (lens.contrast ?? []).map((s) => stripCites(s.sentence)),
    platform_takes: (lens.platforms ?? []).map((p) => ({ platform: p.platform, take: p.take, creators_say: stripCites(p.creators_say?.text), audience_says: stripCites(p.audience_says?.text) })),
    numbers: { creators: stats.creators, sources: stats.sources, platforms: stats.platforms, posts: stats.posts, comments: stats.comments_counted },
  };
}

// ─── Lifecycle and checks computed by code ─────────────────────────────────

// new → emerging; 2+ sources and comments → active; heat falling with no new posts → peaked;
// no new posts for STORY_DORMANT_DAYS → dormant. Merged and rejected are the reviewer's, never changed here.
export function nextStatus({ previous = null, gotNewPosts = false, sources, comments, heat, previousHeat = null, lastPostAt, now = Date.now() }) {
  if (previous === 'merged' || previous === 'rejected') return previous;
  if (Number.isFinite(ms(lastPostAt)) && ms(now) - ms(lastPostAt) > dormantDays() * DAY) return 'dormant';
  const qualifies = sources >= 2 && comments > 0;
  if (previous === 'active' || previous === 'peaked') {
    if (!gotNewPosts && previousHeat != null && (heat < previousHeat || (previous === 'peaked' && heat <= previousHeat))) return 'peaked';
    return 'active';
  }
  return qualifies ? 'active' : 'emerging';
}

// Two stories in a feed that share a main entity and whose post dates overlap may be one story
// split in two. Pairs come back once each, the smaller uuid first.
export function splitCandidates(stories) {
  const out = [];
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const [x, y] = [stories[i], stories[j]];
      if (!x.entity || x.entity !== y.entity) continue;
      if (!(ms(x.first_post_at) <= ms(y.last_post_at) && ms(y.first_post_at) <= ms(x.last_post_at))) continue;
      const [a, b] = String(x.id) < String(y.id) ? [x, y] : [y, x];
      out.push({ story_a: a.id, story_b: b.id, reason: `same main entity${x.entity_name ? ` (${x.entity_name})` : ''} and overlapping post dates` });
    }
  }
  return out;
}

// What the same-story judge sees of one story: its latest headline and dek, main entity and up to 8
// posts with their card's one-line summary. Null when the story is gone.
async function storyForJudge(storyId) {
  const { rows } = await pool.query(
    `select s.id::text, s.status::text, s.review_source, s.category, s.first_post_at, s.last_post_at, e.name as main_entity,
            coalesce(a.entity_id, s.main_entity_id)::text as entity,
            coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') as headline, v.feed_edit ->> 'dek' as dek,
            (select count(*)::int from story_posts sp where sp.story_id = s.id) as post_count
       from stories s
       left join entities e on e.id = s.main_entity_id
       left join entity_aliases a on a.alias = lower(e.name)
       left join lateral (select feed_edit, written from story_versions v where v.story_id = s.id order by v.version desc limit 1) v on true
      where s.id = $1`,
    [storyId],
  );
  if (!rows[0]) return null;
  const { rows: posts } = await pool.query(
    `select p.platform::text as platform, p.published_at, sc.about
       from story_posts sp join posts p on p.id = sp.post_id left join story_cards sc on sc.post_id = p.id
      where sp.story_id = $1 order by p.published_at limit 8`,
    [storyId],
  );
  return { ...rows[0], posts };
}

// Folds `absorb` into `keep` as the admin merge does: posts move over (duplicates skipped), the absorbed
// story leaves the feed marked by the AI, and the pair is resolved with the verdict. False when either
// story changed meanwhile (merged, rejected or taken over by a person).
async function mergeInto({ keep, absorb, pair, verdict }) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `select id::text, status::text, feed_id::text, review_source from stories where id = any($1::uuid[]) for update`,
      [[keep.id, absorb.id]],
    );
    if (rows.length !== 2 || rows[0].feed_id !== rows[1].feed_id) return false;
    if (rows.some((r) => ['merged', 'rejected'].includes(r.status) || r.review_source === 'human')) return false;
    await client.query(
      `insert into story_posts (story_id, post_id, reason, confidence, added_at)
       select $2, post_id, reason, confidence, added_at from story_posts where story_id = $1
       on conflict (story_id, post_id) do nothing`,
      [absorb.id, keep.id],
    );
    await client.query('delete from story_posts where story_id = $1', [absorb.id]);
    await client.query(
      `update stories set status = 'merged', merged_into = $2, published_at = null,
              review_source = 'ai', review_note = $3, reviewed_at = now(), reviewed_by = null
        where id = $1`,
      [absorb.id, keep.id, `AI merged into ${keep.id}: ${verdict.reason}`.slice(0, 500)],
    );
    await client.query('update stories set merged_into = $2 where merged_into = $1', [absorb.id, keep.id]);
    await client.query(
      `insert into merge_candidates (story_a, story_b, reason, resolved_at, decision) values ($1, $2, $3, now(), $4::jsonb)
       on conflict (story_a, story_b) do update set resolved_at = now(), decision = excluded.decision`,
      [pair.story_a, pair.story_b, pair.reason, JSON.stringify(verdict)],
    );
    return true;
  });
}

// Records every split pair in merge_candidates. In the shared feed with auto_merge on, the AI judges
// each new pair (unresolved, never judged, neither story reviewed by a person): same story and sure
// enough → merged; different and sure enough → resolved; not sure → left for a person with the verdict.
// Returns the ids of stories that absorbed another and need rebuilding.
async function reviewSplitCandidates(ctx) {
  const { feed, log, settings } = ctx;
  const { rows } = await pool.query(
    `select s.id::text, s.first_post_at, s.last_post_at, e.name as entity_name, coalesce(a.entity_id, s.main_entity_id)::text as entity
       from stories s
       join entities e on e.id = s.main_entity_id
       left join entity_aliases a on a.alias = lower(e.name)
      where s.feed_id = $1 and s.status not in ('merged', 'rejected') and s.first_post_at is not null`,
    [feed.id],
  );
  const auto = ctx.shared && settings.auto_merge;
  const threshold = Number(settings.merge_min_confidence);
  const kept = new Set();
  const counts = { added: 0, merged: 0, separate: 0, unsure: 0, failed: 0, person: 0 };
  for (const pair of splitCandidates(rows)) {
    const { rowCount } = await pool.query(
      `insert into merge_candidates (story_a, story_b, reason) values ($1, $2, $3) on conflict (story_a, story_b) do nothing`,
      [pair.story_a, pair.story_b, pair.reason],
    );
    counts.added += rowCount;
    if (!auto) continue;
    const { rows: known } = await pool.query('select resolved_at, decision from merge_candidates where story_a = $1 and story_b = $2', [pair.story_a, pair.story_b]);
    if (!known[0] || known[0].resolved_at || known[0].decision) continue;
    const [a, b] = await Promise.all([storyForJudge(pair.story_a), storyForJudge(pair.story_b)]);
    if (!a || !b || [a, b].some((s) => ['merged', 'rejected'].includes(s.status))) continue;
    if ([a, b].some((s) => s.review_source === 'human')) {
      counts.person += 1;
      continue;
    }

    let verdict;
    try {
      verdict = await judgeSameStory({ a, b, runId: ctx.runId, log, workspaceId: ctx.workspaceId });
    } catch (err) {
      if (err?.name === 'SpendCapReached' || err?.dailyQuota) log(`[stories] same-story check stopped: ${String(err.message).slice(0, 200)}`);
      else log(`[stories] same-story check failed for ${pair.story_a} and ${pair.story_b}: ${String(err.message).slice(0, 200)}`);
      counts.failed += 1;
      continue;
    }
    const sure = verdict.confidence != null && verdict.confidence >= threshold;
    const [keep, absorb] = verdict.keep === 'b' ? [b, a] : [a, b];
    if (verdict.same_story && sure) {
      if (await mergeInto({ keep, absorb, pair, verdict: { ...verdict, kept_id: keep.id } })) {
        counts.merged += 1;
        kept.delete(absorb.id);
        kept.add(keep.id);
        log(`[stories] AI merged ${absorb.id} into ${keep.id}`);
      }
      continue;
    }
    await pool.query(
      `update merge_candidates set decision = $3::jsonb, resolved_at = case when $4 then now() end where story_a = $1 and story_b = $2`,
      [pair.story_a, pair.story_b, JSON.stringify(verdict), sure],
    );
    counts[sure ? 'separate' : 'unsure'] += 1;
  }
  const waiting = auto ? counts.unsure + counts.failed + counts.person : counts.added;
  if (counts.added) log(`[stories] ${counts.added} possible split ${counts.added === 1 ? 'story' : 'stories'} found`);
  if (auto && counts.merged + counts.separate + counts.unsure + counts.failed) {
    log(`[stories] AI same-story check: ${counts.merged} merged, ${counts.separate} kept apart, ${counts.unsure} unsure, ${counts.failed} failed`);
  }
  if (waiting) log(`[stories] ${waiting} possible split ${waiting === 1 ? 'story' : 'stories'} left in the review queue`);
  return [...kept];
}

// The minimum for a new story in a feed (the grouping prompt's rule 4, checked by code).
function enoughForStory(world, postIds) {
  const posts = postIds.map((id) => world.postById.get(id)).filter(Boolean);
  const sources = new Set(posts.map(sourceKey)).size;
  return (posts.length >= 2 && sources >= 2) || posts.some((p) => (Number(p.lift) || 0) >= 3);
}

// ─── One story ──────────────────────────────────────────────────────────────

async function buildOne(ctx, plan) {
  const { log, now, feed } = ctx;
  const storyId = plan.existing?.id ?? randomUUID();
  const isNew = !plan.existing;
  const postIds = [...new Set([...(plan.existing?.post_ids ?? []), ...plan.newPostIds])];
  const label = plan.ref;
  const world = await loadWorld(postIds);

  // Aliases first, so "Astra" and "GPT-6 Astra" rank as one entity.
  const entities = [...world.cardByPost.values()].flatMap((c) => c.entities);
  await applyAliasMerges(findAliasMerges(entities), ctx.aliases, log);
  const canonical = (name) => ctx.aliases.get(lower(name)) ?? `name:${lower(name)}`;
  const ranking = entityRanking(world, postIds, canonical);
  const title = plan.title || plan.existing?.headline || '';
  const retried = [];

  // Narrative builder, re-run once if the main character isn't one the posts are about.
  const builderIn = builderInput(world, postIds, { label, title, ranking });
  let narrative = await ask(ctx, { step: 'builder', prompt: '04_narrative_builder', input: builderIn, label });
  let mainProblem = mainCharacterProblem({ narrative, world, postIds, ranking, canonical });
  if (mainProblem) {
    retried.push('builder');
    narrative = await ask(ctx, { step: 'builder', prompt: '04_narrative_builder', input: builderIn, label, problems: [mainProblem] });
    mainProblem = mainCharacterProblem({ narrative, world, postIds, ranking, canonical });
  }
  narrative.story_id = storyId;

  const stats = computeStats({ storyId, narrative, world, postIds, now });

  const writerIn = writerInput(world, postIds, narrative, stats, builderIn);
  let written = await ask(ctx, { step: 'writer', prompt: '05_story_writer', input: writerIn, label });
  if (lengthProblems({ written }).writer.some((p) => p.hard)) {
    retried.push('writer');
    written = await ask(ctx, { step: 'writer', prompt: '05_story_writer', input: writerIn, label, problems: lengthProblems({ written }).writer.map((p) => p.text) });
  }
  written.story_id = storyId;

  const lensIn = lensInput(world, postIds, narrative, stats, { label, title });
  const lens = await ask(ctx, { step: 'lens', prompt: '06_platform_lens', input: lensIn, label });
  lens.story_id = storyId;

  const editIn = editInput(label, narrative, written, lens, stats);
  let edit = await ask(ctx, { step: 'edit', prompt: '07_feed_editor', input: editIn, label });
  if (lengthProblems({ edit }).edit.some((p) => p.hard)) {
    retried.push('edit');
    edit = await ask(ctx, { step: 'edit', prompt: '07_feed_editor', input: editIn, label, problems: lengthProblems({ edit }).edit.map((p) => p.text) });
  }
  edit.story_id = storyId;

  // Checks: citations, quotes and numbers, then the main character and the length limits.
  const checks = verifyStory({ storyId, world, postIds, narrative, stats, written, lens, lensInput: lensIn, edit });
  if (mainProblem) checks.errors.push(mainProblem);
  const limits = lengthProblems({ written, edit, lens });
  for (const p of [...limits.writer, ...limits.lens, ...limits.edit]) (p.hard ? checks.errors : checks.warnings).push(p.text);
  checks.retried = retried;
  checks.pass = checks.errors.length === 0;

  // Main entity: the narrative's main character when it resolves to an entity, else the top of the ranking.
  const named = ctx.aliases.get(lower(narrative.main_character?.name));
  const ranked = ranking.find((r) => sameName(r.name, narrative.main_character?.name ?? '')) ?? ranking[0];
  const mainEntityId = named ?? (ranked && !ranked.key.startsWith('name:') ? ranked.key : null);

  stats.input_fingerprint = worldFingerprint(world, postIds);
  const comments = [...world.commentById.values()].length;
  const status = nextStatus({ previous: plan.existing?.status ?? null, gotNewPosts: plan.newPostIds.length > 0 || plan.reason === 'merged', sources: stats.sources, comments, heat: stats.heat, previousHeat: plan.existing?.heat ?? null, lastPostAt: stats.last_post_at, now });
  const verdict = await editorVerdict(ctx, { storyId, isNew, label, written, edit, stats, lens, checks, narrative });
  const cardModels = [...new Set([...world.cardByPost.values()].map((c) => c.model))].join(', ');
  const groupModels = [...new Set([...world.groupById.values()].map((g) => g.model))].join(', ');
  const strong = MODELS.strong();
  const models = { cards: cardModels || null, groups: groupModels || null, builder: strong, writer: strong, lens: strong, edit: strong, ...(verdict ? { editor: verdict.model } : {}), prompt_version: PROMPT_VERSION };

  return tx(async (client) => {
    // Workspace feeds (reports) publish when checks pass. The shared feed publishes only on the AI
    // editor's verdict, which is dropped if a person reviewed the story or it was published meanwhile.
    let applied = verdict;
    if (!isNew) {
      const { rows } = await client.query('select status, review_source, published_at from stories where id = $1 for update', [storyId]);
      if (!rows[0] || ['merged', 'rejected'].includes(rows[0].status)) {
        log(`[stories] ${storyId} was ${rows[0]?.status ?? 'deleted'} while it was being rebuilt; left as it is`);
        return { storyId, isNew, version: null, passed: false, status: rows[0]?.status ?? null, skipped: true };
      }
      if (rows[0].review_source === 'human' || rows[0].published_at) applied = null;
    }
    const publish = ctx.shared ? applied?.decision === 'publish' : checks.pass;
    const reject = applied?.decision === 'reject';
    const finalStatus = reject ? 'rejected' : status;
    const note = applied ? `AI: ${applied.reason}`.slice(0, 500) : null;
    if (isNew) {
      await client.query(
        `insert into stories (id, feed_id, status, category, main_entity_id, first_post_at, last_post_at, heat, published_at, review_source, review_note, reviewed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end, case when $10::text is not null then 'ai' end, $10, case when $10::text is not null then now() end)`,
        [storyId, feed.id, finalStatus, stats.category, mainEntityId, stats.first_post_at, stats.last_post_at, stats.heat, publish, note],
      );
    } else {
      // A newer version that fails checks never unpublishes; the page keeps the latest passed version.
      await client.query(
        `update stories set status = $2, category = $3, main_entity_id = coalesce($4, main_entity_id), first_post_at = $5, last_post_at = $6, heat = $7,
                published_at = case when $8 then coalesce(published_at, now()) when $9 then null else published_at end,
                review_source = case when $10::text is not null then 'ai' else review_source end,
                review_note = coalesce($10, review_note),
                reviewed_at = case when $10::text is not null then now() else reviewed_at end,
                reviewed_by = case when $10::text is not null then null else reviewed_by end
          where id = $1`,
        [storyId, finalStatus, stats.category, mainEntityId, stats.first_post_at, stats.last_post_at, stats.heat, publish, reject, note],
      );
    }
    for (const postId of plan.newPostIds) {
      await client.query(`insert into story_posts (story_id, post_id, reason, confidence) values ($1, $2, $3, $4) on conflict do nothing`, [storyId, postId, plan.why, plan.confidence]);
    }
    const { rows } = await client.query(
      `insert into story_versions (story_id, version, narrative, stats, written, platform_takes, feed_edit, checks, passed, models, editor)
       select $1, coalesce(max(version), 0) + 1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb from story_versions where story_id = $1
       returning version`,
      [storyId, JSON.stringify(narrative), JSON.stringify(stats), JSON.stringify(written), JSON.stringify(lens), JSON.stringify(edit), JSON.stringify(checks), checks.pass, JSON.stringify(models), applied ? JSON.stringify(applied) : null],
    );
    log(`[stories] ${isNew ? 'new' : 'updated'} ${storyId} v${rows[0].version}: ${postIds.length} posts (+${plan.newPostIds.length}), heat ${stats.heat}, ${finalStatus}, checks ${checks.pass ? 'pass' : `fail (${checks.errors.length} errors)`}${retried.length ? `, re-ran ${retried.join(' and ')}` : ''}${applied ? `, AI editor: ${applied.decision}` : ''}`);
    return { storyId, isNew, version: rows[0].version, passed: checks.pass, status: finalStatus, ...(applied ? { editor: applied.decision } : {}) };
  });
}

// The AI editor's verdict for a story in the shared feed, or null when it isn't asked: a workspace feed,
// failed checks, auto_publish off, a person already reviewed it, or it is already published. A failed
// call (quota, spend cap, bad answer) is logged and leaves the story unpublished.
async function editorVerdict(ctx, { storyId, isNew, label, ...story }) {
  if (!ctx.shared || !story.checks.pass || !ctx.settings.auto_publish) return null;
  if (!isNew) {
    const { rows } = await pool.query('select review_source, published_at from stories where id = $1', [storyId]);
    if (!rows[0] || rows[0].review_source === 'human' || rows[0].published_at) return null;
  }
  try {
    return await reviewStory({ storyId, label, runId: ctx.runId, workspaceId: ctx.workspaceId, log: ctx.log, ...story });
  } catch (err) {
    ctx.log(`[stories] AI editor failed for ${isNew ? `new story ${label}` : storyId}, left unpublished: ${String(err.message).slice(0, 200)}`);
    return null;
  }
}

// Heat and status for live stories that weren't rebuilt this run: heat decays while nothing new arrives.
async function refreshOthers(feedId, skipIds, now, log) {
  const { rows } = await pool.query(
    `select s.id::text, s.status::text, s.heat,
            (select (v.stats ->> 'split')::float from story_versions v where v.story_id = s.id order by v.version desc limit 1) as split,
            min(p.published_at) as first_post_at, max(p.published_at) as last_post_at,
            count(distinct coalesce(h.creator_id::text, h.handle, p.community, 'post:' || p.id))::int as sources,
            count(distinct p.platform)::int as platforms,
            max(m.lift)::float as max_lift,
            (select count(*)::int from story_posts x join comments c on c.post_id = x.post_id where x.story_id = s.id) as comments
       from stories s
       join story_posts sp on sp.story_id = s.id
       join posts p on p.id = sp.post_id
       left join creator_handles h on h.id = p.handle_id
       left join lateral (select lift from post_metrics pm where pm.post_id = p.id order by pm.captured_at desc limit 1) m on true
      where s.feed_id = $1 and s.status = any($2::story_status[]) and not (s.id = any($3::uuid[]))
      group by s.id`,
    [feedId, LIVE, skipIds],
  );
  let changed = 0;
  for (const r of rows) {
    const heat = heatScore({ maxLift: r.max_lift ?? 1, sources: r.sources, platforms: r.platforms, split: r.split ?? 0, lastPostAt: r.last_post_at, now });
    const status = nextStatus({ previous: r.status, gotNewPosts: false, sources: r.sources, comments: r.comments, heat, previousHeat: r.heat, lastPostAt: r.last_post_at, now });
    const { rowCount } = await pool.query(
      `update stories set heat = $2, status = $3::story_status, first_post_at = $4, last_post_at = $5
        where id = $1 and (heat is distinct from $2 or status is distinct from $3::story_status or first_post_at is distinct from $4 or last_post_at is distinct from $5)`,
      [r.id, heat, status, r.first_post_at, r.last_post_at],
    );
    changed += rowCount;
  }
  if (rows.length) log(`[stories] heat and status refreshed on ${rows.length} other live stories (${changed} changed)`);
  return changed;
}

// ─── Entry point ────────────────────────────────────────────────────────────

// Reads the grouping model's answer into plans: attach new posts to an existing story, or start a
// new one. A post goes to one story; posts already in a story, or not in the window, are ignored.
function planFromGrouping(out, windowIds, existing) {
  const windowSet = new Set(windowIds);
  const byId = new Map(existing.map((s) => [s.id, s]));
  const storyOfPost = new Map();
  for (const s of existing) for (const id of s.post_ids) storyOfPost.set(id, s);
  const taken = new Set();
  const plans = [];
  for (const [i, s] of (out?.stories ?? []).entries()) {
    const ids = [...new Set((s.post_ids ?? []).map(String))];
    let target = byId.get(s.existing_story_id) ?? null;
    if (!target) {
      // A "new" story that names posts of an existing story is read as attaching to that story.
      const counts = new Map();
      for (const id of ids) if (storyOfPost.has(id)) counts.set(storyOfPost.get(id), (counts.get(storyOfPost.get(id)) ?? 0) + 1);
      target = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    const fresh = ids.filter((id) => windowSet.has(id) && !taken.has(id));
    if (!fresh.length) continue;
    fresh.forEach((id) => taken.add(id));
    const same = target && plans.find((p) => p.existing?.id === target.id);
    if (same) {
      same.newPostIds.push(...fresh);
      continue;
    }
    const ref = target ? target.id : String(s.story_id || `new${i + 1}`);
    plans.push({
      ref: plans.some((p) => p.ref === ref) ? `${ref}-${i + 1}` : ref,
      existing: target,
      newPostIds: fresh,
      title: s.working_title ?? '',
      why: s.why ?? null,
      confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : null,
    });
  }
  return plans;
}

// A story as the grouping step and a rebuild see it (select from stories s left join entities e).
const EXISTING_COLUMNS = `s.id::text, s.status::text, s.heat, s.first_post_at, s.last_post_at, e.name as main_entity,
  (select coalesce(v.feed_edit ->> 'headline', v.written ->> 'headline') from story_versions v where v.story_id = s.id order by v.version desc limit 1) as headline,
  array(select sp.post_id from story_posts sp where sp.story_id = s.id order by sp.post_id) as post_ids`;

async function runPool(items, size, fn) {
  const results = [];
  const queue = items.map((item, i) => [item, i]);
  let stop = null;
  const worker = async () => {
    while (queue.length && !stop) {
      const [item, i] = queue.shift();
      try {
        results[i] = await fn(item);
      } catch (err) {
        if (err?.name === 'SpendCapReached' || err?.dailyQuota) stop = err;
        results[i] = { error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (stop) throw stop;
  return results;
}

// Groups the feed's new posts (or the given postIds) into stories and rebuilds every story whose
// inputs changed. `single` makes one story from all the given posts (an on-demand report) without
// the grouping model. `now` is for tests and re-running a past day. Returns one row per story built.
// `treatAsShared` is for tests only: a throwaway workspace feed gets the shared feed's AI editor and
// merge rules, so no test story ever shows in the real shared feed.
export async function buildStories({ runId = null, feedId, postIds = null, single = false, log = console.log, now = Date.now(), title = null, treatAsShared = false }) {
  const { rows: feeds } = await pool.query('select id, workspace_id, name from feeds where id = $1', [feedId]);
  const feed = feeds[0];
  if (!feed) throw new Error(`feed ${feedId} does not exist`);
  const nowMs = ms(now);
  const ctx = {
    runId, workspaceId: feed.workspace_id, feed, log, now: nowMs, aliases: await loadAliases(),
    shared: feed.workspace_id == null || treatAsShared, settings: await getSettings(),
  };

  // The window: posts with a card that aren't in any (non-merged) story of this feed yet.
  const { rows: windowRows } = await pool.query(
    `select p.id from posts p join story_cards sc on sc.post_id = p.id
      where (case when $2::text[] is null then sc.newsworthy and p.published_at >= $3 and p.published_at <= $4
                  else p.id = any($2::text[]) and ($5 or sc.newsworthy) end)
        and not exists (select 1 from story_posts sp join stories s on s.id = sp.story_id
                         where sp.post_id = p.id and s.feed_id = $1 and s.status <> 'merged')
      order by p.published_at`,
    [feed.id, postIds, new Date(nowMs - windowDays() * DAY), new Date(nowMs), single],
  );
  const windowIds = windowRows.map((r) => r.id);

  const { rows: existing } = await pool.query(
    `select ${EXISTING_COLUMNS}
       from stories s left join entities e on e.id = s.main_entity_id
      where s.feed_id = $1 and (s.status = any($2::story_status[])
            or ($3::text[] is not null and s.status not in ('merged', 'rejected') and exists (select 1 from story_posts sp where sp.story_id = s.id and sp.post_id = any($3::text[]))))
      order by s.last_post_at desc nulls last`,
    [feed.id, LIVE, postIds],
  );

  let plans = [];
  if (single) {
    // One story from all the given posts: the existing story that holds any of them, else a new one.
    const target = existing.find((s) => s.post_ids.some((id) => postIds?.includes(id))) ?? null;
    if (windowIds.length || target) plans = [{ ref: target?.id ?? `report-${feed.id}`, existing: target, newPostIds: windowIds, title: title ?? target?.headline ?? '', why: title ? `Report: ${title}` : null, confidence: null }];
  } else if (windowIds.length) {
    const windowWorld = await loadWorld(windowIds);
    const live = existing.filter((s) => LIVE.includes(s.status));
    const out = await ask(ctx, { step: 'grouping', prompt: '03_story_grouping', input: groupingInput(windowWorld, windowIds, live), label: `feed-${feed.id}` });
    plans = planFromGrouping(out, windowIds, live).filter((p) => {
      if (p.existing || enoughForStory(windowWorld, p.newPostIds)) return true;
      log(`[stories] "${p.title}" left unassigned: fewer than 2 sources and no post with lift 3 or more`);
      return false;
    });
    log(`[stories] grouping: ${windowIds.length} new posts → ${plans.filter((p) => !p.existing).length} new stories, ${plans.filter((p) => p.existing).length} attached`);
  } else log('[stories] no new posts to group');

  // Existing stories whose posts got new comment groups since their last version are rebuilt too.
  const planned = new Set(plans.map((p) => p.existing?.id).filter(Boolean));
  const candidates = existing.filter((s) => !planned.has(s.id) && (LIVE.includes(s.status) || single));
  const prints = await storedFingerprints(candidates.map((s) => s.id));
  for (const s of candidates) {
    const fp = prints.get(s.id);
    if (fp?.stored && fp.stored !== fp.current) plans.push({ ref: s.id, existing: s, newPostIds: [], title: s.headline ?? '', why: null, confidence: null, reason: 'new comments' });
  }

  const buildAll = async (list) => {
    const results = await runPool(list, parallel(), (plan) => buildOne(ctx, plan));
    return results.map((r, i) => {
      if (!r?.error) return r;
      log(`[stories] ${list[i].existing ? list[i].existing.id : `new story "${list[i].title}"`} failed: ${String(r.error.message).slice(0, 300)}`);
      return { storyId: list[i].existing?.id ?? null, isNew: !list[i].existing, version: null, passed: false, status: list[i].existing?.status ?? null, error: String(r.error.message).slice(0, 300) };
    });
  };
  const built = await buildAll(plans);

  // A report whose posts are already in its story, with nothing new to build, still names that story.
  if (single && !plans.length) {
    const target = existing.find((s) => s.post_ids.some((id) => postIds?.includes(id)));
    if (target) {
      const { rows } = await pool.query('select version, passed from story_versions where story_id = $1 order by version desc limit 1', [target.id]);
      built.push({ storyId: target.id, isNew: false, version: rows[0]?.version ?? null, passed: Boolean(rows[0]?.passed), status: target.status, unchanged: true });
    }
  }

  await refreshOthers(feed.id, built.map((b) => b.storyId).filter(Boolean), nowMs, log);

  // Stories that absorbed another in the same-story check get a new version with the extra posts now,
  // through the same checks and editor rule.
  const keptIds = await reviewSplitCandidates(ctx);
  if (keptIds.length) {
    const { rows: kept } = await pool.query(
      `select ${EXISTING_COLUMNS} from stories s left join entities e on e.id = s.main_entity_id
        where s.id = any($1::uuid[]) and s.status not in ('merged', 'rejected')`,
      [keptIds],
    );
    const rebuilt = await buildAll(kept.map((s) => ({ ref: s.id, existing: s, newPostIds: [], title: s.headline ?? '', why: null, confidence: null, reason: 'merged' })));
    for (const r of rebuilt) {
      const i = built.findIndex((b) => b.storyId === r.storyId);
      if (i >= 0) built.splice(i, 1);
      built.push({ ...r, merged: true });
    }
  }
  return built;
}
