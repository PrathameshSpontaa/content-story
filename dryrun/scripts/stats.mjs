// Steps 5 and 7: every number on the story page is computed here, never by the AI.
// Usage: node scripts/stats.mjs [story_id]
import { join } from 'node:path';
import { DATA, commentWeight, loadWorld, readJson, round1, writeJson } from './lib.mjs';

const only = process.argv[2];
const MIN_COMMENTS_PER_SIDE = 8;
const SHIFT_POINTS = 15;
// 36h suits a daily feed; this dry run looks back over a whole week.
const HALF_LIFE_HOURS = 72;

const world = loadWorld();
const { posts, postById, commentById, groupById, cardByPost } = world;
const { stories } = readJson(join(DATA, 'stories.json'));
const datasetNow = Math.max(...posts.map((p) => Date.parse(p.published_at)).filter(Number.isFinite));

const pct = (a, b) => (a + b > 0 ? Math.round((100 * a) / (a + b)) : null);

function timeOf(id) {
  if (postById.has(id)) return Date.parse(postById.get(id).published_at);
  const c = commentById.get(id);
  if (c) return Date.parse(c.published_at || postById.get(c.post_id)?.published_at);
  return NaN;
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
  return {
    agree_pct: pct(agree, disagree),
    disagree_pct: pct(disagree, agree),
    asks,
    comments: rows.length,
    agree_weight: round1(agree),
    disagree_weight: round1(disagree),
  };
}

for (const story of stories) {
  if (only && story.story_id !== only) continue;
  const narrative = readJson(join(DATA, 'narrative', `${story.story_id}.json`), null);
  if (!narrative) {
    console.log(`${story.story_id}: no narrative yet, skipped`);
    continue;
  }
  const warnings = new Set();
  const storyPosts = story.post_ids.map((id) => postById.get(id)).filter(Boolean);
  const angleCount = (narrative.angles || []).length;

  // Beat times come from the earliest source that reports the moment.
  const beatTimes = (narrative.beats || []).map((beat, index) => {
    const ids = [...(beat.source_post_ids || []), ...(beat.source_comment_ids || [])];
    const times = ids.map(timeOf).filter(Number.isFinite);
    ids.filter((id) => !Number.isFinite(timeOf(id))).forEach((id) => warnings.add(`beat ${index}: unknown or undated source ${id}`));
    return { index, at: times.length ? new Date(Math.min(...times)).toISOString() : null };
  });
  const beatOrder = [...beatTimes]
    .sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity))
    .map((b) => b.index);

  // One row per comment that reacts to an angle.
  const rows = [];
  for (const r of narrative.reactions || []) {
    if (r.angle_index == null) continue;
    if (!(r.angle_index >= 0 && r.angle_index < angleCount)) {
      warnings.add(`reaction ${r.group_id}: angle_index ${r.angle_index} does not exist`);
      continue;
    }
    const group = groupById.get(r.group_id);
    if (!group) {
      warnings.add(`reaction: unknown group ${r.group_id}`);
      continue;
    }
    const platform = postById.get(group.post_id)?.platform;
    let unknown = 0;
    for (const id of group.comment_ids || []) {
      const c = commentById.get(id);
      if (!c) {
        unknown += 1;
        continue;
      }
      rows.push({ angle: r.angle_index, platform, relation: r.relation, weight: commentWeight(c.likes), time: Date.parse(c.published_at) });
    }
    if (unknown) warnings.add(`group ${group.group_id}: ${unknown} comment IDs not found in comments.json`);
  }

  const platformsWithComments = [...new Set(rows.map((r) => r.platform))];
  const angleReactions = (narrative.angles || []).map((angle, i) => {
    const mine = rows.filter((r) => r.angle === i);
    return {
      angle_index: i,
      title: angle.title,
      kind: angle.kind,
      total: summarize(mine),
      by_platform: platformsWithComments
        .map((platform) => ({ platform, ...summarize(mine.filter((r) => r.platform === platform)) }))
        .filter((p) => p.comments > 0),
    };
  });

  // A beat is a turning point when agreement on an angle moves sharply after it.
  const reactionShifts = [];
  for (const beat of beatTimes) {
    if (!beat.at) continue;
    const t = Date.parse(beat.at);
    for (let i = 0; i < angleCount; i++) {
      for (const platform of platformsWithComments) {
        const mine = rows.filter((r) => r.angle === i && r.platform === platform && Number.isFinite(r.time) && r.relation !== 'asks');
        const before = mine.filter((r) => r.time < t);
        const after = mine.filter((r) => r.time >= t);
        if (before.length < MIN_COMMENTS_PER_SIDE || after.length < MIN_COMMENTS_PER_SIDE) continue;
        const beforePct = summarize(before).agree_pct;
        const afterPct = summarize(after).agree_pct;
        if (beforePct != null && afterPct != null && Math.abs(afterPct - beforePct) >= SHIFT_POINTS) {
          reactionShifts.push({
            angle_index: i, platform, before_pct: beforePct, after_pct: afterPct,
            after_beat: beat.index, comments_before: before.length, comments_after: after.length,
          });
        }
      }
    }
  }
  const turningPoints = [...new Set(reactionShifts.map((s) => s.after_beat))].sort((a, b) => a - b);

  const creators = new Set(storyPosts.map((p) => p.creator_id).filter(Boolean)).size;
  // Subreddits count as independent sources for heat, as they do when grouping stories.
  const sources = new Set(storyPosts.map((p) => p.creator_id ?? p.handle)).size;
  const platforms = [...new Set(storyPosts.map((p) => p.platform))];
  const maxLift = Math.max(1, ...storyPosts.map((p) => p.lift || 0));
  const splits = angleReactions
    .map((a) => a.total)
    .filter((t) => t.agree_weight + t.disagree_weight > 0)
    .map((t) => 1 - Math.abs(t.agree_weight - t.disagree_weight) / (t.agree_weight + t.disagree_weight));
  const split = splits.length ? splits.reduce((s, x) => s + x, 0) / splits.length : 0;
  const lastActivity = Math.max(...storyPosts.map((p) => Date.parse(p.published_at)));
  const ageHours = Math.max(0, (datasetNow - lastActivity) / 3.6e6);
  const raw = Math.log1p(maxLift) * Math.sqrt(Math.max(1, sources)) * Math.max(1, platforms.length) ** 0.7 * (1 + split);
  const heat = Math.round(100 * (raw / (raw + 6)) * 0.5 ** (ageHours / HALF_LIFE_HOURS));

  const categories = storyPosts.map((p) => cardByPost.get(p.post_id)?.category).filter(Boolean);
  const category = categories.sort((a, b) => categories.filter((c) => c === b).length - categories.filter((c) => c === a).length)[0] ?? 'Other';

  writeJson(join(DATA, 'stats', `${story.story_id}.json`), {
    story_id: story.story_id,
    category,
    posts: storyPosts.length,
    creators,
    sources,
    platforms: platforms.length,
    platform_list: platforms,
    comments_counted: rows.length,
    max_lift: round1(maxLift),
    split: Math.round(split * 100) / 100,
    age_hours: round1(ageHours),
    heat,
    first_post_at: new Date(Math.min(...storyPosts.map((p) => Date.parse(p.published_at)))).toISOString(),
    last_post_at: new Date(lastActivity).toISOString(),
    beat_times: beatTimes,
    beat_order: beatOrder,
    turning_points: turningPoints,
    angle_reactions: angleReactions,
    reaction_shifts: reactionShifts,
    warnings: [...warnings],
  });
  console.log(`${story.story_id}: heat ${heat}, ${creators} creators, ${platforms.length} platforms, ${rows.length} comments counted, ${turningPoints.length} turning points, ${warnings.size} warnings`);
}
