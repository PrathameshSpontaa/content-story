// Every number on the story page is computed here, never by the AI: counts, reaction percentages,
// beat times, turning points from real comment timestamps, and heat with a daily time decay.
export const MIN_COMMENTS_PER_SIDE = 8;
export const SHIFT_POINTS = 15;
// A YouTube "2 days ago" time is only good to about a day; such a comment counts on one side of a
// beat only when it is further than this from the beat.
export const APPROX_MARGIN_HOURS = 24;

const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
// A daily feed cools quickly: a story with no new posts loses half its heat every 36 hours.
export const halfLifeHours = () => envNumber('STORY_HEAT_HALF_LIFE_HOURS', 36);

export const round1 = (n) => Math.round(n * 10) / 10;
// A comment liked by thousands represents more people than one nobody liked.
export const commentWeight = (likes) => 1 + Math.log1p(Math.max(0, Number(likes) || 0));
const pct = (a, b) => (a + b > 0 ? Math.round((100 * a) / (a + b)) : null);
const ms = (value) => (value == null ? NaN : value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));

// Heat from 0 to 100: how far posts beat their creators' usual engagement, independent sources,
// platforms and how split reactions are, halved for every half-life since the last post.
export function heatScore({ maxLift = 1, sources = 1, platforms = 1, split = 0, lastPostAt, now = Date.now() }) {
  const ageHours = Math.max(0, (ms(now) - ms(lastPostAt)) / 3.6e6) || 0;
  const raw = Math.log1p(Math.max(1, maxLift)) * Math.sqrt(Math.max(1, sources)) * Math.max(1, platforms) ** 0.7 * (1 + split);
  return Math.round(100 * (raw / (raw + 6)) * 0.5 ** (ageHours / halfLifeHours()));
}

function summarize(rows) {
  let agree = 0;
  let disagree = 0;
  let asks = 0;
  for (const r of rows) {
    if (r.relation === 'agrees') agree += r.weight;
    else if (r.relation === 'disagrees') disagree += r.weight;
    else if (r.relation === 'asks') asks += 1;
  }
  return { agree_pct: pct(agree, disagree), disagree_pct: pct(disagree, agree), asks, comments: rows.length, agree_weight: round1(agree), disagree_weight: round1(disagree) };
}

// Counts that need no narrative: posts, creators, sources (a subreddit counts as a source), platforms.
export function storyCounts(world, postIds) {
  const posts = postIds.map((id) => world.postById.get(id)).filter(Boolean);
  const times = posts.map((p) => ms(p.published_at)).filter(Number.isFinite);
  return {
    posts,
    creators: new Set(posts.map((p) => p.creator_id).filter(Boolean)).size,
    // A post found by search with no known author counts as its own source.
    sources: new Set(posts.map((p) => p.creator_id ?? p.handle ?? `post:${p.post_id}`)).size,
    platformList: [...new Set(posts.map((p) => p.platform))],
    maxLift: Math.max(1, ...posts.map((p) => Number(p.lift) || 0)),
    firstPostAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastPostAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

// The category most of the story's posts were given.
export function storyCategory(world, postIds) {
  const counts = new Map();
  for (const id of postIds) {
    const c = world.cardByPost.get(id)?.category;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Other';
}

// For each entity, the sum over posts of salience × log(1 + lift). `canonical` maps an entity name
// to one key, so aliases ("Astra", "GPT-6 Astra") add up as one entity.
export function entityRanking(world, postIds, canonical = (name) => String(name).trim().toLowerCase(), limit = 15) {
  const ranking = new Map();
  for (const postId of postIds) {
    const post = world.postById.get(postId);
    const card = world.cardByPost.get(postId);
    if (!post || !card) continue;
    const lift = Math.max(1, Number(post.lift) || 1);
    for (const e of card.entities ?? []) {
      const key = canonical(e.name, e.type);
      const row = ranking.get(key) ?? { key, name: e.name, type: e.type, posts: new Set(), score: 0, best: 0 };
      row.posts.add(postId);
      row.score += (Number(e.salience) || 0) * Math.log1p(lift);
      // The name shown is the longest spelling seen, which is the most specific one.
      if (String(e.name).length > String(row.name).length) row.name = e.name;
      ranking.set(key, row);
    }
  }
  return [...ranking.values()]
    .map((r) => ({ key: r.key, name: r.name, type: r.type, posts_mentioning: r.posts.size, score: round1(r.score) }))
    .sort((a, b) => b.score - a.score || b.posts_mentioning - a.posts_mentioning)
    .slice(0, limit);
}

// Steps 5 and 7 of the dry run: beat times, reaction numbers per angle and platform, turning points
// and heat for one story, from its narrative and the collected posts, groups and comments.
export function computeStats({ storyId, narrative, world, postIds, now = Date.now() }) {
  const warnings = new Set();
  const { posts, creators, sources, platformList, maxLift, firstPostAt, lastPostAt } = storyCounts(world, postIds);
  const angleCount = (narrative.angles ?? []).length;

  const timeOf = (id) => {
    if (world.postById.has(id)) return { t: ms(world.postById.get(id).published_at), approx: false };
    const c = world.commentById.get(id);
    if (c) return c.published_at ? { t: ms(c.published_at), approx: Boolean(c.time_approx) } : { t: ms(world.postById.get(c.post_id)?.published_at), approx: true };
    return { t: NaN, approx: false };
  };

  // Beat times come from the earliest source that reports the moment. Exact times win over approximate ones.
  const beatTimes = (narrative.beats ?? []).map((beat, index) => {
    const ids = [...(beat.source_post_ids ?? []), ...(beat.source_comment_ids ?? [])];
    const times = ids.map((id) => ({ id, ...timeOf(id) }));
    times.filter((x) => !Number.isFinite(x.t)).forEach((x) => warnings.add(`beat ${index}: unknown or undated source ${x.id}`));
    const known = times.filter((x) => Number.isFinite(x.t));
    const exact = known.filter((x) => !x.approx);
    const pool = exact.length ? exact : known;
    return { index, at: pool.length ? new Date(Math.min(...pool.map((x) => x.t))).toISOString() : null, ...(pool.length && !exact.length ? { approx: true } : {}) };
  });
  const beatOrder = [...beatTimes].sort((a, b) => (a.at ? ms(a.at) : Infinity) - (b.at ? ms(b.at) : Infinity)).map((b) => b.index);

  // One row per comment that reacts to an angle.
  const rows = [];
  for (const r of narrative.reactions ?? []) {
    if (r.angle_index == null) continue;
    if (!(r.angle_index >= 0 && r.angle_index < angleCount)) {
      warnings.add(`reaction ${r.group_id}: angle_index ${r.angle_index} does not exist`);
      continue;
    }
    const group = world.groupById.get(r.group_id);
    if (!group) {
      warnings.add(`reaction: unknown group ${r.group_id}`);
      continue;
    }
    const platform = world.postById.get(group.post_id)?.platform;
    let unknown = 0;
    for (const id of group.comment_ids ?? []) {
      const c = world.commentById.get(id);
      if (!c) {
        unknown += 1;
        continue;
      }
      rows.push({ angle: r.angle_index, platform, relation: r.relation, weight: commentWeight(c.likes), time: c.published_at ? ms(c.published_at) : NaN, approx: Boolean(c.time_approx) });
    }
    if (unknown) warnings.add(`group ${group.group_id}: ${unknown} comment IDs not found in the collected comments`);
  }

  const platformsWithComments = [...new Set(rows.map((r) => r.platform))];
  const angleReactions = (narrative.angles ?? []).map((angle, i) => {
    const mine = rows.filter((r) => r.angle === i);
    return {
      angle_index: i,
      title: angle.title,
      kind: angle.kind,
      total: summarize(mine),
      by_platform: platformsWithComments.map((platform) => ({ platform, ...summarize(mine.filter((r) => r.platform === platform)) })).filter((p) => p.comments > 0),
    };
  });

  // A beat is a turning point when agreement on an angle moves sharply after it, measured on the
  // comments' own timestamps. Approximate times only count when clearly on one side of the beat.
  const margin = APPROX_MARGIN_HOURS * 3.6e6;
  const reactionShifts = [];
  for (const beat of beatTimes) {
    if (!beat.at) continue;
    const t = ms(beat.at);
    for (let i = 0; i < angleCount; i++) {
      for (const platform of platformsWithComments) {
        const mine = rows.filter((r) => r.angle === i && r.platform === platform && Number.isFinite(r.time) && r.relation !== 'asks');
        const before = mine.filter((r) => (r.approx ? r.time < t - margin : r.time < t));
        const after = mine.filter((r) => (r.approx ? r.time >= t + margin : r.time >= t));
        if (before.length < MIN_COMMENTS_PER_SIDE || after.length < MIN_COMMENTS_PER_SIDE) continue;
        const beforePct = summarize(before).agree_pct;
        const afterPct = summarize(after).agree_pct;
        if (beforePct != null && afterPct != null && Math.abs(afterPct - beforePct) >= SHIFT_POINTS) {
          reactionShifts.push({ angle_index: i, platform, before_pct: beforePct, after_pct: afterPct, after_beat: beat.index, comments_before: before.length, comments_after: after.length });
        }
      }
    }
  }
  const turningPoints = [...new Set(reactionShifts.map((s) => s.after_beat))].sort((a, b) => a - b);

  const splits = angleReactions
    .map((a) => a.total)
    .filter((t) => t.agree_weight + t.disagree_weight > 0)
    .map((t) => 1 - Math.abs(t.agree_weight - t.disagree_weight) / (t.agree_weight + t.disagree_weight));
  const split = splits.length ? splits.reduce((s, x) => s + x, 0) / splits.length : 0;
  const ageHours = lastPostAt ? Math.max(0, (ms(now) - ms(lastPostAt)) / 3.6e6) : 0;

  return {
    story_id: storyId,
    category: storyCategory(world, postIds),
    posts: posts.length,
    creators,
    sources,
    platforms: platformList.length,
    platform_list: platformList,
    comments_counted: rows.length,
    max_lift: round1(maxLift),
    split: Math.round(split * 100) / 100,
    age_hours: round1(ageHours),
    heat: heatScore({ maxLift, sources, platforms: platformList.length, split, lastPostAt, now }),
    first_post_at: firstPostAt,
    last_post_at: lastPostAt,
    beat_times: beatTimes,
    beat_order: beatOrder,
    turning_points: turningPoints,
    angle_reactions: angleReactions,
    reaction_shifts: reactionShifts,
    warnings: [...warnings],
  };
}
