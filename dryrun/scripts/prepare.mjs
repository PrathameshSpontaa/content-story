// Builds the input files for each AI step from what's already on disk.
// Usage: node scripts/prepare.mjs <cards|groups|grouping|builder|writer> [batch size]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, chunk, commentWeight, loadWorld, readJson, resetDir, round1, truncate, writeJson } from './lib.mjs';

const [stage, sizeArg] = process.argv.slice(2);
const pad = (n) => String(n).padStart(2, '0');

function writeBatches(dir, inputs, size) {
  resetDir(dir);
  const batches = chunk(inputs, size);
  batches.forEach((batch, i) => writeJson(join(dir, `batch_${pad(i + 1)}.json`), batch));
  return batches.length;
}

const stages = {
  cards() {
    const { posts } = loadWorld();
    const todo = posts.filter((p) => !existsSync(join(DATA, 'cards', `${p.post_id}.json`)));
    const inputs = todo.map((p) => ({
      post_id: p.post_id,
      platform: p.platform,
      creator: p.creator,
      handle: p.handle,
      published_at: p.published_at,
      kind: p.kind,
      text: truncate(p.text, 4000),
      transcript: truncate(p.transcript, 8000),
      shared_urls: p.shared_urls || [],
      lift: p.lift ?? null,
    }));
    const n = writeBatches(join(DATA, 'inputs', 'cards'), inputs, Number(sizeArg) || 12);
    console.log(`cards: ${inputs.length} posts need a card → ${n} batch files in data/inputs/cards/`);
  },

  groups() {
    const { posts, comments, cardByPost } = loadWorld();
    const byPost = new Map();
    for (const c of comments) byPost.set(c.post_id, [...(byPost.get(c.post_id) || []), c]);
    const todo = posts.filter((p) => byPost.get(p.post_id)?.length && !existsSync(join(DATA, 'groups', `${p.post_id}.json`)));
    const inputs = todo.map((p) => {
      const about = cardByPost.get(p.post_id)?.about;
      return {
        post: {
          post_id: p.post_id,
          platform: p.platform,
          creator: p.creator,
          handle: p.handle,
          text: truncate([p.text, about && `(summary) ${about}`].filter(Boolean).join('\n'), 1500),
        },
        comments: byPost
          .get(p.post_id)
          .sort((a, b) => (b.likes || 0) - (a.likes || 0))
          .slice(0, 80)
          .map((c) => ({
            comment_id: c.comment_id,
            parent_id: c.parent_id ?? null,
            author: c.author,
            is_creator: Boolean(c.is_creator),
            likes: c.likes || 0,
            text: truncate(c.text, 600),
          })),
      };
    });
    const n = writeBatches(join(DATA, 'inputs', 'groups'), inputs, Number(sizeArg) || 4);
    console.log(`groups: ${inputs.length} posts with comments need groups → ${n} batch files in data/inputs/groups/`);
  },

  grouping() {
    const { posts, cardByPost } = loadWorld();
    const missing = posts.filter((p) => !cardByPost.has(p.post_id)).length;
    if (missing) console.log(`warning: ${missing} posts have no card yet and are left out`);
    const cards = posts
      .filter((p) => cardByPost.get(p.post_id)?.newsworthy)
      .map((p) => {
        const card = cardByPost.get(p.post_id);
        return {
          post_id: p.post_id,
          platform: p.platform,
          creator: p.creator,
          published_at: p.published_at,
          lift: p.lift ?? null,
          about: card.about,
          entities: (card.entities || []).map((e) => e.name),
          claims: (card.claims || []).map((c) => c.text),
          shared_urls: p.shared_urls || [],
          quotes_post_id: p.quotes_post_id ?? null,
        };
      });
    const times = posts.map((p) => p.published_at).filter(Boolean).sort();
    writeJson(join(DATA, 'inputs', 'grouping.json'), {
      window: { from: times[0]?.slice(0, 10), to: times.at(-1)?.slice(0, 10) },
      cards,
    });
    console.log(`grouping: ${cards.length} newsworthy cards of ${posts.length} posts → data/inputs/grouping.json`);
  },

  builder() {
    const { postById, commentById, cardByPost, groupsByPost } = loadWorld();
    const { stories } = readJson(join(DATA, 'stories.json'));
    resetDir(join(DATA, 'inputs', 'builder'));
    for (const story of stories) {
      const ranking = new Map();
      const cards = [];
      const commentGroups = [];
      const creatorReplies = [];

      for (const postId of story.post_ids) {
        const post = postById.get(postId);
        const card = cardByPost.get(postId);
        if (!post || !card) continue;
        const lift = Math.max(1, post.lift || 1);
        for (const e of card.entities || []) {
          const key = e.name.trim().toLowerCase();
          const row = ranking.get(key) || { name: e.name, type: e.type, posts: new Set(), score: 0 };
          row.posts.add(postId);
          row.score += (Number(e.salience) || 0) * Math.log1p(lift);
          ranking.set(key, row);
        }
        cards.push({
          post_id: postId,
          platform: post.platform,
          creator: post.creator,
          handle: post.handle,
          published_at: post.published_at,
          lift: post.lift ?? null,
          url: post.url,
          about: card.about,
          type: card.type,
          claims: card.claims || [],
          events: card.events || [],
        });

        const result = groupsByPost.get(postId);
        for (const g of result?.groups || []) {
          const ids = (g.comment_ids || []).filter((id) => commentById.has(id));
          commentGroups.push({
            group_id: g.group_id,
            post_id: postId,
            platform: post.platform,
            label: g.label,
            point: g.point,
            reaction_to_creator: g.reaction_to_creator,
            size: ids.length,
            like_weight: round1(ids.reduce((sum, id) => sum + commentWeight(commentById.get(id).likes), 0)),
            samples: (g.sample_ids || [])
              .filter((id) => commentById.has(id))
              .slice(0, 5)
              .map((id) => ({ comment_id: id, likes: commentById.get(id).likes || 0, text: truncate(commentById.get(id).text, 300) })),
          });
        }
        for (const r of result?.creator_replies || []) {
          const c = commentById.get(r.comment_id);
          if (c) creatorReplies.push({ comment_id: r.comment_id, post_id: postId, author: c.author, summary: r.summary });
        }
      }

      const entityRanking = [...ranking.values()]
        .map((r) => ({ name: r.name, type: r.type, posts_mentioning: r.posts.size, score: round1(r.score) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);

      writeJson(join(DATA, 'inputs', 'builder', `${story.story_id}.json`), {
        story: { story_id: story.story_id, working_title: story.working_title },
        entity_ranking: entityRanking,
        cards,
        comment_groups: commentGroups,
        creator_replies: creatorReplies,
      });
    }
    console.log(`builder: ${stories.length} story inputs → data/inputs/builder/`);
  },

  lens() {
    const { postById, commentById, cardByPost, groupsByPost } = loadWorld();
    const { stories } = readJson(join(DATA, 'stories.json'));
    const order = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];
    resetDir(join(DATA, 'inputs', 'lens'));
    let count = 0;
    for (const story of stories) {
      const narrative = readJson(join(DATA, 'narrative', `${story.story_id}.json`), null);
      const stats = readJson(join(DATA, 'stats', `${story.story_id}.json`), null);
      if (!narrative || !stats) continue;
      const posts = story.post_ids.map((id) => postById.get(id)).filter(Boolean);
      const platforms = order.filter((pl) => posts.some((p) => p.platform === pl)).map((platform) => {
        const mine = posts.filter((p) => p.platform === platform);
        const commentGroups = mine.flatMap((p) =>
          (groupsByPost.get(p.post_id)?.groups ?? []).map((g) => ({
            group_id: g.group_id,
            post_id: p.post_id,
            label: g.label,
            point: g.point,
            reaction_to_creator: g.reaction_to_creator,
            size: g.comment_ids.filter((id) => commentById.has(id)).length,
            samples: g.sample_ids
              .filter((id) => commentById.has(id))
              .slice(0, 3)
              .map((id) => ({ comment_id: id, likes: commentById.get(id).likes || 0, text: truncate(commentById.get(id).text, 280) })),
          })),
        );
        return {
          platform,
          creators: [...new Set(mine.map((p) => `${p.creator} (${p.handle})`))],
          posts: mine.map((p) => {
            const card = cardByPost.get(p.post_id);
            return {
              post_id: p.post_id,
              creator: p.creator,
              handle: p.handle,
              kind: p.kind,
              published_at: p.published_at,
              lift: p.lift,
              about: card?.about ?? '',
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
      writeJson(join(DATA, 'inputs', 'lens', `${story.story_id}.json`), {
        story: {
          story_id: story.story_id,
          working_title: story.working_title,
          main_character: narrative.main_character?.name,
          angles: (narrative.angles || []).map((a, i) => ({ angle_index: i, title: a.title, thesis: a.thesis })),
        },
        platforms,
      });
      count += 1;
    }
    console.log(`lens: ${count} story inputs → data/inputs/lens/`);
  },

  // Usage: node scripts/prepare.mjs edit s1,s2   (no list = every finished story)
  edit() {
    const only = sizeArg ? new Set(sizeArg.split(',')) : null;
    const { stories } = readJson(join(DATA, 'stories.json'));
    let count = 0;
    for (const story of stories) {
      if (only && !only.has(story.story_id)) continue;
      const narrative = readJson(join(DATA, 'narrative', `${story.story_id}.json`), null);
      const written = readJson(join(DATA, 'written', `${story.story_id}.json`), null);
      const lens = readJson(join(DATA, 'lens', `${story.story_id}.json`), null);
      const stats = readJson(join(DATA, 'stats', `${story.story_id}.json`), null);
      if (!narrative || !written || !lens || !stats) continue;
      const strip = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');
      writeJson(join(DATA, 'inputs', 'edit', `${story.story_id}.json`), {
        story_id: story.story_id,
        main_character: narrative.main_character?.name,
        current_headline: written.headline,
        narrative: (written.narrative || []).map((s) => strip(s.sentence)),
        contrast: (lens.contrast || []).map((s) => strip(s.sentence)),
        platform_takes: (lens.platforms || []).map((p) => ({
          platform: p.platform,
          take: p.take,
          creators_say: strip(p.creators_say?.text),
          audience_says: strip(p.audience_says?.text),
        })),
        numbers: { creators: stats.creators, sources: stats.sources, platforms: stats.platforms, posts: stats.posts, comments: stats.comments_counted },
      });
      count += 1;
    }
    console.log(`edit: ${count} story inputs → data/inputs/edit/`);
  },

  writer() {
    const { postById, commentById } = loadWorld();
    const { stories } = readJson(join(DATA, 'stories.json'));
    resetDir(join(DATA, 'inputs', 'writer'));
    let count = 0;
    for (const story of stories) {
      const narrative = readJson(join(DATA, 'narrative', `${story.story_id}.json`), null);
      const stats = readJson(join(DATA, 'stats', `${story.story_id}.json`), null);
      const builderInput = readJson(join(DATA, 'inputs', 'builder', `${story.story_id}.json`), null);
      if (!narrative || !stats || !builderInput) continue;

      const commentIds = new Set();
      for (const b of narrative.beats || []) (b.source_comment_ids || []).forEach((id) => commentIds.add(id));
      for (const a of narrative.angles || []) (a.evidence || []).forEach((e) => commentById.has(e.source_id) && commentIds.add(e.source_id));
      for (const g of builderInput.comment_groups) g.samples.forEach((s) => commentIds.add(s.comment_id));
      for (const r of builderInput.creator_replies) commentIds.add(r.comment_id);

      writeJson(join(DATA, 'inputs', 'writer', `${story.story_id}.json`), {
        narrative,
        numbers: {
          creators: stats.creators,
          platforms: stats.platforms,
          heat: stats.heat,
          beat_times: stats.beat_times.map((b) => b.at),
          turning_points: stats.turning_points,
          angle_reactions: stats.angle_reactions.map((a) => ({
            angle_index: a.angle_index,
            by_platform: a.by_platform.map(({ platform, agree_pct, disagree_pct, asks, comments }) => ({
              platform, agree_pct, disagree_pct, asks, comments,
            })),
          })),
          reaction_shifts: stats.reaction_shifts,
        },
        sources: {
          posts: story.post_ids.map((id) => postById.get(id)).filter(Boolean).map((p) => ({
            post_id: p.post_id,
            platform: p.platform,
            handle: p.handle,
            text: truncate(p.text, 1200),
            transcript_excerpt: truncate(p.transcript, 1200),
          })),
          comments: [...commentIds].slice(0, 200).map((id) => commentById.get(id)).filter(Boolean).map((c) => ({
            comment_id: c.comment_id,
            post_id: c.post_id,
            author: c.author,
            likes: c.likes || 0,
            text: truncate(c.text, 400),
          })),
        },
      });
      count += 1;
    }
    console.log(`writer: ${count} story inputs → data/inputs/writer/`);
  },
};

if (!stages[stage]) {
  console.log(`Usage: node scripts/prepare.mjs <${Object.keys(stages).join('|')}> [batch size]`);
  process.exit(1);
}
stages[stage]();
