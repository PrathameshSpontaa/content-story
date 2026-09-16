// Collection: the daily pass over everything any workspace tracks (each handle, subreddit and
// keyword scraped once, whoever tracks it), and search-based collection for brands, keywords and
// on-demand reports. Posts are upserted, every capture adds a metrics snapshot, and the comment
// pass goes deep on the best posts. AI never runs here; this file is only counts and rows.
import { pool, tx } from '../lib/db.js';
import { runActor } from './apify.js';
import { isFake, readTikTokSubtitle } from './fixtures.js';
import { accountKey, applyLift, clean, normalizeComments, normalizePosts } from './normalize.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NULL_WS = '00000000-0000-0000-0000-000000000000';

export const ACTORS = {
  x: 'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest',
  igPosts: 'apify/instagram-post-scraper',
  igComments: 'apify/instagram-comment-scraper',
  liPosts: 'harvestapi/linkedin-profile-posts',
  liComments: 'harvestapi/linkedin-post-comments',
  ytVideos: 'streamers/youtube-scraper',
  ytComments: 'streamers/youtube-comments-scraper',
  ttVideos: 'clockworks/tiktok-scraper',
  ttComments: 'clockworks/tiktok-comments-scraper',
  reddit: 'automation-lab/reddit-scraper',
};

// Prices per item, checked 2026-09-13 (dryrun/config/actors.md).
export const PRICE = {
  tweet: 0.00025, igPost: 0.0017, igComment: 0.0026, liPost: 0.002, liComment: 0.002,
  ytVideo: 0.004, ytComment: 0.002, ttVideo: 0.0037, ttComment: 0.00125, rdPost: 0.00115, rdComment: 0.000575,
};

// Lowest maxTotalChargeUsd each actor accepts (actors.md); the cap is never set below it.
const FLOOR = {
  [ACTORS.ytComments]: 0.5, [ACTORS.ttVideos]: 0.5, [ACTORS.liComments]: 0.01,
  [ACTORS.igPosts]: 0.005, [ACTORS.igComments]: 0.0026, [ACTORS.liPosts]: 0.002,
};
// The hard cap is the estimate from the PRICE table with room for start fees and overshoot.
export const capFor = (actor, estimate) => Math.max(FLOOR[actor] ?? 0.01, Math.ceil((estimate * 1.5 + 0.01) * 100) / 100);

// Posts fetched per handle per run, and how deep the comment pass goes on the best posts.
const POSTS_PER = { x: 20, instagram: 6, linkedin: 6, youtube: 4, tiktok: 5, reddit: 6 };
const REDDIT_COMMENTS = 50;
export const COMMENT_PLAN = {
  x: { posts: 15, per: 100 },
  instagram: { posts: 8, per: 50 },
  linkedin: { posts: 8, per: 100 },
  youtube: { posts: 8, per: 100 },
  tiktok: { posts: 8, per: 100 },
};
const SEARCH_PLAN = { x: { posts: 5, per: 100 }, youtube: { posts: 4, per: 100 }, tiktok: { posts: 4, per: 100 } };

const envInt = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' ? Number(process.env[name]) : fallback);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const unix = (ms) => Math.floor(ms / 1000);
const queryKey = (q) => String(q ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const slug = (q) => queryKey(q).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const spanLimit = (spanMs, short, mid, long) => (spanMs <= DAY ? short : spanMs <= 7 * DAY ? mid : long);

// ---------- what to collect ----------

// Every active target across every workspace (or one workspace's, for an on-demand refresh), folded
// into one list per kind. A creator tracked by five workspaces appears once with the union of their platforms.
export async function loadTargets(workspaceId = null) {
  const { rows } = await pool.query(
    `select t.kind::text as kind, t.creator_id, t.query, array_agg(distinct p)::text[] as platforms
       from tracking_targets t, unnest(t.platforms) p
      where t.active and ($1::uuid is null or t.workspace_id = $1::uuid)
      group by t.kind, t.creator_id, t.query`,
    [workspaceId],
  );
  const creators = new Map();
  const communities = new Map();
  const keywords = new Map();
  for (const r of rows) {
    if (r.kind === 'creator') {
      const set = creators.get(r.creator_id) ?? new Set();
      r.platforms.forEach((p) => set.add(p));
      creators.set(r.creator_id, set);
    } else if (r.kind === 'community') {
      const key = queryKey(r.query);
      const name = key.replace(/^r\//, '');
      if (name) communities.set(key, { query: r.query, name });
    } else if (r.kind === 'keyword') {
      const key = queryKey(r.query);
      const cur = keywords.get(key) ?? { key, query: r.query.trim(), platforms: new Set() };
      r.platforms.forEach((p) => cur.platforms.add(p));
      keywords.set(key, cur);
    }
  }
  return {
    creators: [...creators].map(([creator_id, platforms]) => ({ creator_id, platforms: [...platforms] })),
    communities: [...communities.values()],
    keywords: [...keywords.values()].map((k) => ({ ...k, platforms: [...k.platforms] })),
  };
}

// creator_handles with the creator's name; the normalizer matches authors against these.
export async function loadHandles(creatorIds = null) {
  const { rows } = await pool.query(
    `select h.id, h.creator_id, c.name as creator_name, h.platform::text as platform, h.handle, h.url, h.last_collected_at
       from creator_handles h join creators c on c.id = h.creator_id
      where $1::uuid[] is null or h.creator_id = any($1::uuid[])`,
    [creatorIds],
  );
  return rows;
}

// One job per platform for the handles due, each with its own window; Reddit is one job for all subreddits.
function postJobs({ byPlatform, communities, now, since }) {
  const jobs = [];
  const earliest = (list) => Math.min(...list.map((h) => since(h)));
  const x = byPlatform.x ?? [];
  if (x.length) jobs.push({
    platform: 'x', label: 'posts', actor: ACTORS.x, handles: x,
    estimate: x.length * POSTS_PER.x * PRICE.tweet,
    input: { searchTerms: x.map((h) => `from:${clean(h.handle)} since_time:${unix(since(h))} until_time:${unix(now)}`), queryType: 'Latest', maxItems: POSTS_PER.x },
  });
  const ig = byPlatform.instagram ?? [];
  if (ig.length) jobs.push({
    platform: 'instagram', label: 'posts', actor: ACTORS.igPosts, handles: ig,
    estimate: ig.length * POSTS_PER.instagram * PRICE.igPost,
    input: { username: ig.map((h) => clean(h.handle)), resultsLimit: POSTS_PER.instagram, onlyPostsNewerThan: isoDay(earliest(ig)), skipPinnedPosts: true, dataDetailLevel: 'basicData' },
  });
  const li = byPlatform.linkedin ?? [];
  if (li.length) jobs.push({
    platform: 'linkedin', label: 'posts', actor: ACTORS.liPosts, handles: li,
    estimate: li.length * POSTS_PER.linkedin * PRICE.liPost + li.length * 0.001,
    input: { targetUrls: li.map((h) => h.url), maxPosts: POSTS_PER.linkedin, postedLimit: spanLimit(now - earliest(li), '24h', 'week', 'month'), includeQuotePosts: true, includeReposts: false, scrapeReactions: false, scrapeComments: false },
  });
  const yt = byPlatform.youtube ?? [];
  if (yt.length) jobs.push({
    platform: 'youtube', label: 'posts', actor: ACTORS.ytVideos, handles: yt,
    estimate: yt.length * POSTS_PER.youtube * PRICE.ytVideo,
    input: {
      startUrls: yt.map((h) => ({ url: `${h.url.replace(/\/$/, '')}/videos` })),
      maxResults: POSTS_PER.youtube, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: 'NEWEST',
      transcriptionAndSubtitle: 'ALWAYS_SUBTITLES', subtitlesLanguage: 'en', subtitlesFormat: 'plaintext',
      aiVideoDescription: false, aiVideoSummary: false,
    },
  });
  const tt = byPlatform.tiktok ?? [];
  if (tt.length) jobs.push({
    platform: 'tiktok', label: 'posts', actor: ACTORS.ttVideos, handles: tt,
    estimate: tt.length * POSTS_PER.tiktok * PRICE.ttVideo + 0.001,
    input: {
      profiles: tt.map((h) => clean(h.handle)), profileScrapeSections: ['videos'], profileSorting: 'latest', resultsPerPage: POSTS_PER.tiktok,
      excludePinnedPosts: true, downloadSubtitlesOptions: 'DOWNLOAD_SUBTITLES', commentsPerPost: 0, maxRepliesPerComment: 0,
      shouldDownloadVideos: false, shouldDownloadCovers: false, proxyCountryCode: 'None',
    },
  });
  if (communities.length) jobs.push({
    platform: 'reddit', label: 'threads', actor: ACTORS.reddit, handles: [],
    estimate: communities.length * POSTS_PER.reddit * (PRICE.rdPost + REDDIT_COMMENTS * PRICE.rdComment) + 0.003,
    input: {
      urls: communities.map((c) => `https://www.reddit.com/r/${c.name}/`), sort: 'top', timeFilter: 'week', maxPostsPerSource: POSTS_PER.reddit,
      includeComments: true, maxCommentsPerPost: REDDIT_COMMENTS, commentDepth: 2, deduplicatePosts: true, outputFormat: 'default',
    },
  });
  return jobs.map((j) => ({ ...j, cap: capFor(j.actor, j.estimate) }));
}

// Search inputs per platform (actors.md). Instagram and LinkedIn have no search; they are skipped.
function searchJobs({ query, platforms, from, to, log }) {
  const jobs = [];
  const label = `search-${slug(query)}`;
  const items = envInt('SEARCH_ITEMS', 40);
  const span = to - from;
  const hashtag = query.trim().startsWith('#') ? query.trim().slice(1) : null;
  for (const platform of platforms) {
    if (platform === 'x') jobs.push({
      platform, label, actor: ACTORS.x, estimate: items * PRICE.tweet,
      input: { searchTerms: [`${hashtag ? `#${hashtag}` : `"${query.trim()}"`} since_time:${unix(from)} until_time:${unix(to)}`], queryType: 'Latest', maxItems: items },
    });
    else if (platform === 'youtube') jobs.push({
      platform, label, actor: ACTORS.ytVideos, estimate: items * PRICE.ytVideo,
      input: {
        searchQueries: [query.trim()], maxResults: items, maxResultsShorts: 0, maxResultStreams: 0,
        sortingOrder: 'relevance', dateFilter: spanLimit(span, 'today', 'week', 'month'),
        transcriptionAndSubtitle: 'ALWAYS_SUBTITLES', subtitlesLanguage: 'en', subtitlesFormat: 'plaintext', aiVideoDescription: false, aiVideoSummary: false,
      },
    });
    else if (platform === 'tiktok') jobs.push({
      platform, label, actor: ACTORS.ttVideos, estimate: items * PRICE.ttVideo + 0.001,
      input: {
        ...(hashtag ? { hashtags: [hashtag] } : { searchQueries: [query.trim()], searchSection: '/video' }),
        resultsPerPage: items, downloadSubtitlesOptions: 'DOWNLOAD_SUBTITLES', commentsPerPost: 0, maxRepliesPerComment: 0,
        shouldDownloadVideos: false, shouldDownloadCovers: false, proxyCountryCode: 'None',
      },
    });
    else if (platform === 'reddit') jobs.push({
      platform, label, actor: ACTORS.reddit, estimate: items * (PRICE.rdPost + 30 * PRICE.rdComment) + 0.003,
      input: {
        urls: [`https://www.reddit.com/search/?q=${encodeURIComponent(query.trim())}&sort=top&t=${spanLimit(span, 'day', 'week', 'month')}`],
        sort: 'top', timeFilter: spanLimit(span, 'day', 'week', 'month'), maxPostsPerSource: items,
        includeComments: true, maxCommentsPerPost: 30, commentDepth: 1, deduplicatePosts: true, outputFormat: 'default',
      },
    });
    else log(`[${platform}/${label}] no search actor for ${platform}, skipped`);
  }
  return jobs.map((j) => ({ ...j, cap: capFor(j.actor, j.estimate) }));
}

// ---------- the comment pass ----------

// Best post per account first, so every creator's audience is heard, then the rest by lift.
export function pickForComments(posts, platform, limit) {
  const candidates = posts
    .filter((p) => p.platform === platform && (p.metrics?.comments ?? 0) > 0)
    .sort((a, b) => (b.lift ?? 1) - (a.lift ?? 1) || (b.engagement ?? 0) - (a.engagement ?? 0));
  const best = new Map();
  for (const p of candidates) if (!best.has(accountKey(p))) best.set(accountKey(p), p);
  const first = [...best.values()];
  const rest = candidates.filter((p) => !first.includes(p));
  return [...first, ...rest].slice(0, limit);
}

// Fills the run's comment budget one post at a time across platforms, keeping each post's depth,
// so the best posts get 100+ comments rather than every post getting a few.
export function planComments(posts, plan, budget) {
  const queues = Object.entries(plan).map(([platform, p]) => ({ platform, per: p.per, list: pickForComments(posts, platform, p.posts) }));
  const picked = Object.fromEntries(queues.map((q) => [q.platform, []]));
  let left = budget;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      if (!q.list.length || q.per > left) continue;
      picked[q.platform].push(q.list.shift());
      left -= q.per;
      progressed = true;
    }
  }
  return picked;
}

function commentJobs(pick, plan, label = 'comments') {
  const jobs = [];
  const xs = pick.x ?? [];
  if (xs.length) jobs.push({
    platform: 'x', label: 'replies', actor: ACTORS.x, targets: xs, estimate: xs.length * plan.x.per * PRICE.tweet,
    input: { searchTerms: xs.map((p) => `conversation_id:${p.raw_id}`), queryType: 'Latest', maxItems: plan.x.per },
  });
  const ig = pick.instagram ?? [];
  if (ig.length) jobs.push({
    platform: 'instagram', label, actor: ACTORS.igComments, targets: ig, estimate: ig.length * plan.instagram.per * PRICE.igComment,
    input: { directUrls: ig.map((p) => p.url), resultsLimit: plan.instagram.per, includeNestedComments: false },
  });
  const li = pick.linkedin ?? [];
  if (li.length) jobs.push({
    platform: 'linkedin', label, actor: ACTORS.liComments, targets: li, estimate: li.length * plan.linkedin.per * PRICE.liComment,
    input: { posts: li.map((p) => p.url), maxItems: plan.linkedin.per, postedLimit: 'any', scrapeReplies: false, profileScraperMode: 'short' },
  });
  const yt = pick.youtube ?? [];
  if (yt.length) jobs.push({
    platform: 'youtube', label, actor: ACTORS.ytComments, targets: yt, estimate: yt.length * plan.youtube.per * PRICE.ytComment,
    input: { startUrls: yt.map((p) => ({ url: p.url })), maxComments: plan.youtube.per, sortCommentsBy: 'TOP_COMMENTS' },
  });
  const tt = pick.tiktok ?? [];
  if (tt.length) jobs.push({
    platform: 'tiktok', label, actor: ACTORS.ttComments, targets: tt, estimate: tt.length * plan.tiktok.per * PRICE.ttComment,
    input: { postURLs: tt.map((p) => p.url), commentsPerPost: plan.tiktok.per, maxRepliesPerComment: 0 },
  });
  return jobs.map((j) => ({ ...j, cap: capFor(j.actor, j.estimate) }));
}

// Collects comments on the chosen posts, skipping posts that already have that many saved.
async function commentPass({ posts, plan, budget, runId, workspaceId, log }) {
  const ids = posts.map((p) => p.post_id);
  const have = new Map(ids.length ? (await pool.query('select post_id, count(*)::int as n from comments where post_id = any($1) group by 1', [ids])).rows.map((r) => [r.post_id, r.n]) : []);
  const fresh = posts.filter((p) => (have.get(p.post_id) ?? 0) < (plan[p.platform]?.per ?? 0));
  const jobs = commentJobs(planComments(fresh, plan, budget), plan);
  if (!jobs.length) return { comments: 0, newComments: 0, newIds: [], usd: 0, jobs: 0 };
  const results = await runAll(jobs, { runId, workspaceId, log });
  const raw = {};
  for (const r of results) if (!r.error) raw[r.job.platform] = [...(raw[r.job.platform] ?? []), ...r.items];
  const { comments } = normalizeComments(raw, { posts });
  const saved = await tx((client) => saveComments(client, comments));
  const capped = results.find((r) => r.capped)?.capped ?? null;
  return { comments: comments.length, newComments: saved.inserted, newIds: saved.newIds, usd: results.reduce((s, r) => s + (r.usd ?? 0), 0), jobs: jobs.length, capped };
}

// ---------- running and saving ----------

async function runAll(jobs, { runId, workspaceId, log, concurrency = 3 }) {
  const queue = [...jobs];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const { items, usd, captureId, status } = await runActor({ actor: job.actor, input: job.input, platform: job.platform, label: job.label, maxTotalChargeUsd: job.cap, runId, workspaceId, log });
        results.push({ job, items, usd: usd ?? 0, captureId, status });
      } catch (err) {
        log(`[${job.platform}/${job.label}] failed: ${err.message}`);
        results.push({ job, items: [], usd: 0, error: err.message, capped: err?.name === 'SpendCapReached' ? err : null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

// TikTok gives subtitle links, not text; one small GET per video. Fake mode reads the dry run's files.
async function tiktokSubtitles(videos, windowFrom) {
  const out = new Map();
  for (const v of videos) {
    if (!v?.id || (windowFrom && Date.parse(v.createTimeISO) < windowFrom)) continue;
    if (isFake()) {
      const text = readTikTokSubtitle(String(v.id));
      if (text) out.set(String(v.id), text);
      continue;
    }
    const links = v.videoMeta?.subtitleLinks || [];
    const link = links.find((l) => /^en/i.test(l.language || '')) || links[0];
    if (!link?.downloadLink) continue;
    try {
      const res = await fetch(link.downloadLink);
      if (res.ok) out.set(String(v.id), await res.text());
    } catch {
      // A missing subtitle only means that video has no transcript.
    }
  }
  return out;
}

// Recent engagement per account already in the database, so lift has a median to compare with.
async function loadBaseline(posts) {
  const handleIds = [...new Set(posts.map((p) => p.handle_id).filter(Boolean))];
  const communities = [...new Set(posts.map((p) => p.community).filter(Boolean).map((c) => c.toLowerCase()))];
  if (!handleIds.length && !communities.length) return new Map();
  const { rows } = await pool.query(
    `select p.id as post_id, p.platform::text as platform, p.handle_id, p.community,
            coalesce(m.likes, 0) + 2 * coalesce(m.comments, 0) + 3 * coalesce(m.shares, 0) as engagement
       from posts p
       join lateral (select * from post_metrics m where m.post_id = p.id order by m.captured_at desc limit 1) m on true
      where p.published_at > now() - interval '14 days'
        and (p.handle_id = any($1::uuid[]) or lower(p.community) = any($2::text[]))`,
    [handleIds, communities],
  );
  const baseline = new Map();
  for (const r of rows) {
    const key = accountKey({ platform: r.platform, handle_id: r.handle_id, community: r.community });
    baseline.set(key, [...(baseline.get(key) ?? []), { post_id: r.post_id, engagement: Number(r.engagement) }]);
  }
  return baseline;
}

// Upserts posts (text and metrics-related fields refresh; the row and its id stay) and adds one
// metrics snapshot per post for this capture. Returns which ids were new.
async function savePosts(client, posts, { captureIdByPlatform, capturedAt }) {
  if (!posts.length) return { newIds: [], ids: [] };
  const rows = posts.map((p) => ({
    id: p.post_id, platform: p.platform, platform_post_id: p.raw_id, handle_id: p.handle_id ?? null, community: p.community ?? null,
    url: p.url ?? '', kind: p.kind, text: p.text ?? '', transcript: p.transcript ?? '', shared_urls: p.shared_urls ?? [],
    published_at: p.published_at, raw_capture_id: captureIdByPlatform[p.platform] ?? null,
  }));
  const { rows: saved } = await client.query(
    `insert into posts select * from jsonb_populate_recordset(null::posts, $1::jsonb)
     on conflict (platform, platform_post_id) do update set
       url = excluded.url, kind = excluded.kind, text = excluded.text, shared_urls = excluded.shared_urls,
       transcript = case when excluded.transcript <> '' then excluded.transcript else posts.transcript end,
       handle_id = coalesce(excluded.handle_id, posts.handle_id), community = coalesce(excluded.community, posts.community),
       raw_capture_id = coalesce(excluded.raw_capture_id, posts.raw_capture_id)
     returning id, (xmax = 0) as inserted`,
    [JSON.stringify(rows)],
  );
  const metrics = posts.map((p) => ({
    post_id: p.post_id, captured_at: capturedAt, likes: p.metrics?.likes ?? null, comments: p.metrics?.comments ?? null,
    shares: p.metrics?.shares ?? null, views: p.metrics?.views ?? null, engagement: p.engagement ?? null, lift: p.lift ?? null,
  }));
  await client.query(`insert into post_metrics select * from jsonb_populate_recordset(null::post_metrics, $1::jsonb) on conflict do nothing`, [JSON.stringify(metrics)]);
  return { newIds: saved.filter((r) => r.inserted).map((r) => r.id), ids: saved.map((r) => r.id) };
}

async function saveComments(client, comments) {
  if (!comments.length) return { inserted: 0, newIds: [] };
  const rows = comments.map((c) => ({
    id: c.comment_id, post_id: c.post_id, parent_id: c.parent_id ?? null, author: c.author ?? 'unknown', is_creator: Boolean(c.is_creator),
    likes: c.likes ?? 0, text: c.text, published_at: c.published_at ?? null, time_approx: Boolean(c.time_approx), url: c.url ?? null,
  }));
  const { rows: saved } = await client.query(
    `insert into comments select * from jsonb_populate_recordset(null::comments, $1::jsonb)
     on conflict (id) do update set likes = excluded.likes, text = excluded.text, is_creator = comments.is_creator or excluded.is_creator,
       parent_id = coalesce(excluded.parent_id, comments.parent_id), published_at = coalesce(excluded.published_at, comments.published_at)
     returning id, (xmax = 0) as inserted`,
    [JSON.stringify(rows)],
  );
  return { inserted: saved.filter((r) => r.inserted).length, newIds: saved.filter((r) => r.inserted).map((r) => r.id) };
}

// Runs post jobs, normalizes, saves posts with a metrics snapshot and any comments that came along.
async function collectPosts({ jobs, handles, windowFrom, keepUntracked, runId, workspaceId, log }) {
  const now = Date.now();
  const results = await runAll(jobs, { runId, workspaceId, log });
  const raw = {};
  const captureIdByPlatform = {};
  for (const r of results) {
    if (r.error) continue;
    raw[r.job.platform] = [...(raw[r.job.platform] ?? []), ...r.items];
    captureIdByPlatform[r.job.platform] = r.captureId;
  }
  const subtitles = await tiktokSubtitles(raw.tiktok ?? [], windowFrom);
  const { posts, comments, dropped } = normalizePosts(raw, { handles, collectedAt: now, windowFrom, keepUntracked, subtitles });
  applyLift(posts, await loadBaseline(posts));
  const capturedAt = new Date(now).toISOString();
  const saved = await tx(async (client) => {
    const p = await savePosts(client, posts, { captureIdByPlatform, capturedAt });
    const c = await saveComments(client, comments);
    return { ...p, comments: c };
  });
  log(`posts: ${posts.length} normalized (${saved.newIds.length} new), ${comments.length} comments came along (${saved.comments.inserted} new); dropped ${JSON.stringify(dropped)}`);
  return { results, posts, comments, saved, capturedAt, usd: results.reduce((s, r) => s + (r.usd ?? 0), 0), captureIds: Object.values(captureIdByPlatform) };
}

// ---------- entry points ----------

const markCollected = (key, platform, at) =>
  pool.query(
    `insert into query_collections (query_key, platform, last_collected_at) values ($1, $2, $3)
     on conflict (query_key, platform) do update set last_collected_at = excluded.last_collected_at`,
    [key, platform, at],
  );

// The scheduled pass, or with workspaceId one workspace's on-demand refresh (same shared cache).
// minHours skips sources collected this recently (the scheduled run passes it from the settings;
// otherwise env COLLECT_MIN_HOURS, default 20). For tests: windowDays (how far back a
// never-collected handle goes; default 7), commentBudget (env COMMENTS_PER_RUN, default 1500),
// skipKeywords. `capReached` in the result is the spend-cap error if any Apify call hit the cap.
export async function collectDaily({ runId, workspaceId = null, log = console.log, minHours = envInt('COLLECT_MIN_HOURS', 20), windowDays = 7, commentBudget = envInt('COMMENTS_PER_RUN', 1500), skipKeywords = false } = {}) {
  const now = Date.now();
  const targets = await loadTargets(workspaceId);
  const wanted = new Map(targets.creators.map((c) => [c.creator_id, new Set(c.platforms)]));
  const handles = await loadHandles();
  const since = (h) => (h.last_collected_at ? Math.max(Date.parse(h.last_collected_at), now - 30 * DAY) : now - windowDays * DAY);
  const due = handles.filter((h) => wanted.get(h.creator_id)?.has(h.platform) && !(h.last_collected_at && now - Date.parse(h.last_collected_at) < minHours * HOUR));
  const byPlatform = {};
  for (const h of due) (byPlatform[h.platform] ||= []).push(h);
  const windowFrom = Math.min(now - windowDays * DAY, ...due.map(since));
  // Subreddits share the keyword cache table: key 'r/<name>', platform reddit.
  const subKey = (c) => `r/${c.name}`;
  const { rows: subRows } = await pool.query(`select query_key, last_collected_at from query_collections where platform = 'reddit' and query_key = any($1::text[])`, [targets.communities.map(subKey)]);
  const subLast = new Map(subRows.map((r) => [r.query_key, Date.parse(r.last_collected_at)]));
  const dueCommunities = targets.communities.filter((c) => !(subLast.has(subKey(c)) && now - subLast.get(subKey(c)) < minHours * HOUR));
  log(`${workspaceId ? `refresh ${workspaceId}` : 'daily'} (sources older than ${minHours}h): ${targets.creators.length} creators (${due.length} handles due of ${handles.filter((h) => wanted.get(h.creator_id)?.has(h.platform)).length}), ${dueCommunities.length} of ${targets.communities.length} subreddits due, ${targets.keywords.length} keywords`);

  const jobs = postJobs({ byPlatform, communities: dueCommunities, now, since });
  for (const j of jobs) log(`  ${`${j.platform}/${j.label}`.padEnd(18)} ~$${j.estimate.toFixed(3)} cap $${j.cap}  ${j.actor}`);
  const totals = { handles: 0, communities: 0, posts: 0, comments: 0, usd: 0, newPosts: 0, newComments: 0, postIds: [], newPostIds: [], newCommentIds: [], capturedAt: [], captureIds: [], capReached: null };
  const add = (r) => {
    totals.capReached ??= r.capped ?? r.results?.find((x) => x.capped)?.capped ?? null;
    totals.usd += r.usd;
    totals.captureIds.push(...r.captureIds);
    totals.capturedAt.push(r.capturedAt);
    totals.posts += r.posts.length;
    totals.newPosts += r.saved.newIds.length;
    totals.newPostIds.push(...r.saved.newIds);
    totals.postIds.push(...r.saved.ids);
    totals.comments += r.comments.length;
    totals.newComments += r.saved.comments.inserted;
    totals.newCommentIds.push(...r.saved.comments.newIds);
  };

  let posts = [];
  if (jobs.length) {
    const r = await collectPosts({ jobs, handles, windowFrom, keepUntracked: false, runId, workspaceId: null, log });
    add(r);
    posts = r.posts;
    const collected = r.results.filter((x) => !x.error).flatMap((x) => x.job.handles.map((h) => h.id));
    if (collected.length) await pool.query('update creator_handles set last_collected_at = $2 where id = any($1::uuid[])', [collected, r.capturedAt]);
    totals.handles = collected.length;
    if (r.results.some((x) => x.job.platform === 'reddit' && !x.error)) {
      for (const c of dueCommunities) await markCollected(subKey(c), 'reddit', r.capturedAt);
      totals.communities = dueCommunities.length;
    }
  }

  // Keywords: search once per platform, shared by every workspace that tracks the word.
  if (!skipKeywords) {
    for (const kw of targets.keywords) {
      const { rows } = await pool.query('select platform::text as platform, last_collected_at from query_collections where query_key = $1', [kw.key]);
      const last = new Map(rows.map((r) => [r.platform, Date.parse(r.last_collected_at)]));
      const platforms = kw.platforms.filter((p) => !(last.has(p) && now - last.get(p) < minHours * HOUR));
      if (!platforms.length) continue;
      const from = Math.min(...platforms.map((p) => (last.has(p) ? Math.max(last.get(p), now - 30 * DAY) : now - windowDays * DAY)));
      try {
        const r = await searchCollect({ runId, workspaceId: null, query: kw.query, platforms, dateFrom: from, dateTo: now, log, commentBudget: Math.min(commentBudget, 300) });
        add(r);
        posts.push(...r.posts);
        for (const p of r.searched) await markCollected(kw.key, p, r.capturedAt);
      } catch (err) {
        log(`keyword "${kw.query}" failed: ${err.message}`);
      }
    }
  }

  // The deep comment pass on the best posts of this run.
  const pass = await commentPass({ posts, plan: COMMENT_PLAN, budget: commentBudget, runId, workspaceId: null, log });
  totals.comments += pass.comments;
  totals.newComments += pass.newComments;
  totals.newCommentIds.push(...pass.newIds);
  totals.usd += pass.usd;
  totals.capReached ??= pass.capped;
  log(`comments pass: ${pass.jobs} jobs, ${pass.comments} comments (${pass.newComments} new)`);
  totals.usd = Math.round(totals.usd * 1e6) / 1e6;
  return totals;
}

// Search-based collection with everything the daily pass needs to know about what it did.
async function searchCollect({ runId, workspaceId = null, query, platforms, dateFrom, dateTo, log, commentBudget }) {
  const text = String(query ?? '').trim();
  if (!text) throw new Error('collectForQuery needs a query');
  const to = dateTo ? (typeof dateTo === 'number' ? dateTo : Date.parse(dateTo)) : Date.now();
  const from = dateFrom ? (typeof dateFrom === 'number' ? dateFrom : Date.parse(dateFrom)) : to - 7 * DAY;
  const toEnd = typeof dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? to + DAY : to;
  const jobs = searchJobs({ query: text, platforms: platforms ?? [], from, to: toEnd, log });
  const none = { posts: [], comments: [], saved: { newIds: [], ids: [], comments: { inserted: 0, newIds: [] } }, searched: [], capturedAt: new Date().toISOString(), captureIds: [], usd: 0 };
  if (!jobs.length) return none;
  for (const j of jobs) log(`  ${`${j.platform}/${j.label}`.padEnd(18)} ~$${j.estimate.toFixed(3)} cap $${j.cap}  ${j.actor}`);

  const handles = await loadHandles();
  const r = await collectPosts({ jobs, handles, windowFrom: from, keepUntracked: true, runId, workspaceId, log });
  // Only what the search actually ran counts as searched; a failed platform stays due.
  const ran = new Set(r.results.filter((x) => !x.error).map((x) => x.job.platform));
  const posts = r.posts.filter((p) => Date.parse(p.published_at) <= toEnd);
  if (posts.length) {
    await pool.query(
      `insert into post_queries (post_id, query, workspace_id, found_at)
       select p.id, $2, $3::uuid, $4 from unnest($1::text[]) p(id)
       on conflict (post_id, lower(query), coalesce(workspace_id, '${NULL_WS}'::uuid)) do update set found_at = excluded.found_at`,
      [posts.map((p) => p.post_id), text, workspaceId, r.capturedAt],
    );
  }
  const pass = await commentPass({ posts, plan: SEARCH_PLAN, budget: commentBudget, runId, workspaceId, log });
  return {
    posts,
    comments: r.comments,
    commentsCollected: r.comments.length + pass.comments,
    saved: { ...r.saved, comments: { inserted: r.saved.comments.inserted + pass.newComments, newIds: [...r.saved.comments.newIds, ...pass.newIds] } },
    searched: jobs.map((j) => j.platform).filter((p) => ran.has(p)),
    capturedAt: r.capturedAt,
    captureIds: r.captureIds,
    usd: Math.round((r.usd + pass.usd) * 1e6) / 1e6,
    capped: r.results.find((x) => x.capped)?.capped ?? pass.capped ?? null,
  };
}

// Search-based collection for a brand, keyword or on-demand report. dateFrom/dateTo accept ISO
// dates or ms. Posts found this way carry no handle (unless the author is a tracked creator) and
// are recorded in post_queries under the query and workspace that asked.
export async function collectForQuery({ runId, workspaceId = null, query, platforms, dateFrom, dateTo, log = console.log, commentBudget = envInt('COMMENTS_PER_RUN', 1500) } = {}) {
  const d = await searchCollect({ runId, workspaceId, query, platforms, dateFrom, dateTo, log, commentBudget });
  return { postIds: d.posts.map((p) => p.post_id), posts: d.posts.length, comments: d.commentsCollected ?? 0, usd: d.usd };
}
