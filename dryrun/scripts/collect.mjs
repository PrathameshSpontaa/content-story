// Step 0: collects posts, then comments on the posts worth it.
// Usage:
//   node scripts/collect.mjs plan       show what will run and what it should cost (no API calls)
//   node scripts/collect.mjs posts      pass 1: last 7 days of posts from every creator + subreddits
//   node scripts/normalize.mjs          turn raw files into data/posts.json
//   node scripts/collect.mjs comments   pass 2: comments on the best posts per platform
//   node scripts/normalize.mjs          again, now with comments
import { join } from 'node:path';
import { DATA, ROOT, readJson, writeJson, writeText } from './lib.mjs';
import { runActor, whoAmI } from './apify.mjs';

const mode = process.argv[2] || 'plan';
const DAY = 86_400_000;
const config = readJson(join(ROOT, 'config', 'creators.json'));
const accounts = (platform) => config.creators.filter((c) => c.handles[platform]).map((c) => c.handles[platform]);

const ACTORS = {
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

// Free-plan prices per item, checked 2026-09-13 (config/actors.md).
const PRICE = {
  tweet: 0.00025, igPost: 0.0017, igComment: 0.0026, liPost: 0.002, liComment: 0.002,
  ytVideo: 0.004, ytComment: 0.002, ttVideo: 0.0037, ttComment: 0.00125, rdPost: 0.00115, rdComment: 0.000575,
};

// How many posts per platform get their comments collected, and how many comments each.
const COMMENT_PLAN = {
  x: { posts: 15, per: 20 },
  instagram: { posts: 8, per: 15 },
  linkedin: { posts: 8, per: 20 },
  youtube: { posts: 8, per: 20 },
  tiktok: { posts: 8, per: 25 },
};

function postJobs(meta) {
  const since = Math.floor(Date.parse(meta.window_from) / 1000);
  const until = Math.floor(Date.parse(meta.collected_at) / 1000);
  const x = accounts('x');
  const ig = accounts('instagram');
  const li = accounts('linkedin');
  const yt = accounts('youtube');
  const tt = accounts('tiktok');
  const subs = config.subreddits;
  return [
    {
      platform: 'x', label: 'posts', actor: ACTORS.x, cap: 0.1,
      estimate: x.length * 20 * PRICE.tweet,
      input: { searchTerms: x.map((a) => `from:${a.handle} since_time:${since} until_time:${until}`), queryType: 'Latest', maxItems: 20 },
    },
    {
      platform: 'instagram', label: 'posts', actor: ACTORS.igPosts, cap: 0.15,
      estimate: ig.length * 6 * PRICE.igPost,
      input: { username: ig.map((a) => a.handle), resultsLimit: 6, onlyPostsNewerThan: meta.window_from.slice(0, 10), skipPinnedPosts: true, dataDetailLevel: 'basicData' },
    },
    {
      platform: 'linkedin', label: 'posts', actor: ACTORS.liPosts, cap: 0.15,
      estimate: li.length * 6 * PRICE.liPost,
      input: { targetUrls: li.map((a) => a.url), maxPosts: 6, postedLimit: 'week', includeQuotePosts: true, includeReposts: false, scrapeReactions: false, scrapeComments: false },
    },
    {
      platform: 'youtube', label: 'posts', actor: ACTORS.ytVideos, cap: 0.25,
      estimate: yt.length * 4 * PRICE.ytVideo,
      input: {
        startUrls: yt.map((a) => ({ url: `${a.url.replace(/\/$/, '')}/videos` })),
        maxResults: 4, maxResultsShorts: 0, maxResultStreams: 0, sortVideosBy: 'NEWEST',
        transcriptionAndSubtitle: 'ALWAYS_SUBTITLES', subtitlesLanguage: 'en', subtitlesFormat: 'plaintext',
        aiVideoDescription: false, aiVideoSummary: false,
      },
    },
    {
      platform: 'tiktok', label: 'posts', actor: ACTORS.ttVideos, cap: 0.5,
      estimate: tt.length * 5 * PRICE.ttVideo + 0.001,
      input: {
        profiles: tt.map((a) => a.handle), profileScrapeSections: ['videos'], profileSorting: 'latest', resultsPerPage: 5,
        excludePinnedPosts: true, downloadSubtitlesOptions: 'DOWNLOAD_SUBTITLES', commentsPerPost: 0, maxRepliesPerComment: 0,
        shouldDownloadVideos: false, shouldDownloadCovers: false, proxyCountryCode: 'None',
      },
    },
    {
      platform: 'reddit', label: 'threads', actor: ACTORS.reddit, cap: 0.3,
      estimate: subs.length * 6 * PRICE.rdPost + subs.length * 6 * 20 * PRICE.rdComment + 0.003,
      input: { urls: subs.map((s) => s.url), sort: 'top', timeFilter: 'week', maxPostsPerSource: 6, includeComments: true, maxCommentsPerPost: 20, commentDepth: 2, deduplicatePosts: true, outputFormat: 'default' },
    },
  ];
}

// Best post per creator first, so every creator's audience is heard, then the rest by lift.
function pickForComments(posts, platform, limit) {
  const candidates = posts
    .filter((p) => p.platform === platform && (p.metrics?.comments ?? 0) > 0)
    .sort((a, b) => (b.lift ?? 1) - (a.lift ?? 1) || (b.engagement ?? 0) - (a.engagement ?? 0));
  const best = new Map();
  for (const p of candidates) if (!best.has(p.creator_id)) best.set(p.creator_id, p);
  const first = [...best.values()];
  const rest = candidates.filter((p) => !first.includes(p));
  return [...first, ...rest].slice(0, limit);
}

function commentJobs(posts) {
  const pick = Object.fromEntries(Object.entries(COMMENT_PLAN).map(([pl, plan]) => [pl, pickForComments(posts, pl, plan.posts)]));
  const jobs = [];
  if (pick.x.length) jobs.push({
    platform: 'x', label: 'replies', actor: ACTORS.x, cap: 0.12, targets: pick.x,
    estimate: pick.x.length * COMMENT_PLAN.x.per * PRICE.tweet,
    input: { searchTerms: pick.x.map((p) => `conversation_id:${p.raw_id}`), queryType: 'Latest', maxItems: COMMENT_PLAN.x.per },
  });
  if (pick.instagram.length) jobs.push({
    platform: 'instagram', label: 'comments', actor: ACTORS.igComments, cap: 0.35, targets: pick.instagram,
    estimate: pick.instagram.length * COMMENT_PLAN.instagram.per * PRICE.igComment,
    input: { directUrls: pick.instagram.map((p) => p.url), resultsLimit: COMMENT_PLAN.instagram.per, includeNestedComments: false },
  });
  if (pick.linkedin.length) jobs.push({
    platform: 'linkedin', label: 'comments', actor: ACTORS.liComments, cap: 0.35, targets: pick.linkedin,
    estimate: pick.linkedin.length * COMMENT_PLAN.linkedin.per * PRICE.liComment,
    input: { posts: pick.linkedin.map((p) => p.url), maxItems: COMMENT_PLAN.linkedin.per, postedLimit: 'any', scrapeReplies: false, profileScraperMode: 'short' },
  });
  if (pick.youtube.length) jobs.push({
    platform: 'youtube', label: 'comments', actor: ACTORS.ytComments, cap: 0.5, targets: pick.youtube,
    estimate: pick.youtube.length * COMMENT_PLAN.youtube.per * PRICE.ytComment,
    input: { startUrls: pick.youtube.map((p) => ({ url: p.url })), maxComments: COMMENT_PLAN.youtube.per, sortCommentsBy: 'TOP_COMMENTS' },
  });
  if (pick.tiktok.length) jobs.push({
    platform: 'tiktok', label: 'comments', actor: ACTORS.ttComments, cap: 0.3, targets: pick.tiktok,
    estimate: pick.tiktok.length * COMMENT_PLAN.tiktok.per * PRICE.ttComment,
    input: { postURLs: pick.tiktok.map((p) => p.url), commentsPerPost: COMMENT_PLAN.tiktok.per, maxRepliesPerComment: 0 },
  });
  return jobs;
}

async function runAll(jobs, concurrency = 3) {
  const queue = [...jobs];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const { items } = await runActor({ actor: job.actor, input: job.input, platform: job.platform, label: job.label, maxTotalChargeUsd: job.cap });
        results.push({ job, items: items.length });
      } catch (err) {
        console.log(`[${job.platform}/${job.label}] failed: ${err.message}`);
        results.push({ job, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

async function fetchTikTokSubtitles(meta) {
  const videos = readJson(join(DATA, 'raw', 'tiktok', 'posts.json'), []);
  let saved = 0;
  for (const v of videos) {
    if (Date.parse(v.createTimeISO) < Date.parse(meta.window_from)) continue;
    const links = v.videoMeta?.subtitleLinks || [];
    const link = links.find((l) => /^en/i.test(l.language || '')) || links[0];
    if (!link?.downloadLink) continue;
    try {
      const res = await fetch(link.downloadLink);
      if (res.ok) {
        writeText(join(DATA, 'raw', 'tiktok', 'subtitles', `${v.id}.vtt`), await res.text());
        saved += 1;
      }
    } catch {
      // A missing subtitle only means that video has no transcript.
    }
  }
  console.log(`tiktok: saved subtitles for ${saved} videos`);
}

const money = (n) => `$${n.toFixed(2)}`;
const printJobs = (jobs) => {
  for (const j of jobs) console.log(`  ${`${j.platform}/${j.label}`.padEnd(20)} ~${money(j.estimate).padEnd(7)} cap ${money(j.cap)}  ${j.actor}`);
  const est = jobs.reduce((s, j) => s + j.estimate, 0);
  const cap = jobs.reduce((s, j) => s + j.cap, 0);
  console.log(`  ${'total'.padEnd(20)} ~${money(est).padEnd(7)} cap ${money(cap)}`);
  return { est, cap };
};

if (mode === 'plan') {
  const now = new Date();
  const meta = { collected_at: now.toISOString(), window_from: new Date(now - 7 * DAY).toISOString() };
  console.log('Pass 1 · posts');
  const one = printJobs(postJobs(meta));
  console.log('Pass 2 · comments (if every slot fills)');
  const fake = Object.entries(COMMENT_PLAN).flatMap(([platform, plan]) =>
    Array.from({ length: plan.posts }, (_, i) => ({ platform, creator_id: `c${i}`, raw_id: '0', url: 'u', metrics: { comments: 1 } })),
  );
  const two = printJobs(commentJobs(fake));
  console.log(`\nExpected about ${money(one.est + two.est)}. Hard ceiling if every cap is hit: ${money(one.cap + two.cap)}.`);
} else if (mode === 'posts') {
  const me = await whoAmI();
  console.log(`Apify account ${me.username}, plan ${me.plan}`);
  if (String(me.plan).toUpperCase() === 'FREE') console.log('note: on the Free plan the X scraper returns only about 15 tweets per run');
  const now = new Date();
  const meta = { collected_at: now.toISOString(), window_from: new Date(now - 7 * DAY).toISOString(), apify_plan: me.plan };
  writeJson(join(DATA, 'raw', 'meta.json'), meta);
  const jobs = postJobs(meta);
  printJobs(jobs);
  await runAll(jobs);
  await fetchTikTokSubtitles(meta);
  console.log('Pass 1 done. Next: node scripts/normalize.mjs');
} else if (mode === 'comments') {
  const posts = readJson(join(DATA, 'posts.json'));
  const jobs = commentJobs(posts);
  writeJson(join(DATA, 'raw', 'comment_targets.json'), jobs.map((j) => ({ platform: j.platform, posts: j.targets.map((p) => ({ post_id: p.post_id, creator: p.creator, lift: p.lift, url: p.url })) })));
  printJobs(jobs);
  await runAll(jobs);
  console.log('Pass 2 done. Next: node scripts/normalize.mjs');
} else {
  console.log('Usage: node scripts/collect.mjs <plan|posts|comments>');
  process.exitCode = 1;
}
