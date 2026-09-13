// Step 1: turns six platforms' raw Apify output into data/posts.json and data/comments.json.
// Safe to run any number of times; it only reads data/raw/.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ROOT, readJson, round1, writeJson } from './lib.mjs';

const DAY = 86_400_000;
const meta = readJson(join(DATA, 'raw', 'meta.json'));
const collectedAt = Date.parse(meta.collected_at);
const windowStart = Date.parse(meta.window_from) - DAY / 2;
const creators = readJson(join(ROOT, 'config', 'creators.json')).creators;
const raw = (platform, label) => readJson(join(DATA, 'raw', platform, `${label}.json`), []);

// ---------- helpers ----------
const clean = (h) => String(h ?? '').replace(/^@/, '').trim().toLowerCase();
const liSlug = (url) => (String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? '').toLowerCase();

const lookup = {};
for (const c of creators) {
  for (const [platform, account] of Object.entries(c.handles)) {
    const key = platform === 'linkedin' ? liSlug(account.url) : clean(account.handle);
    (lookup[platform] ||= new Map()).set(key, c);
  }
}
const creatorFor = (platform, key) => lookup[platform]?.get(platform === 'linkedin' ? String(key ?? '').toLowerCase() : clean(key));

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const UNIT = { second: 1e3, minute: 6e4, hour: 3.6e6, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

function parseDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const s = String(value).trim();
  // X: "Thu Oct 17 09:30:41 +0000 2024"
  const x = s.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/);
  if (x) return new Date(`${x[7]}-${MONTHS[x[1]]}-${x[2].padStart(2, '0')}T${x[3]}${x[4]}${x[5]}:${x[6]}`).toISOString();
  // YouTube: "3 days ago", "Streamed 2 weeks ago"
  const rel = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (rel) return new Date(collectedAt - Number(rel[1]) * UNIT[rel[2].toLowerCase()]).toISOString();
  if (/^\d{10,13}$/.test(s)) return parseDate(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function num(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 0 ? null : value;
  const m = String(value).replace(/,/g, '').trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1));
}

const urlsIn = (text) => [...new Set((String(text ?? '').match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).filter((u) => !/\/\/t\.co\//.test(u)))];

function subtitleText(content) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->') && !/^(WEBVTT|NOTE|Kind:|Language:)/.test(l));
  return lines.filter((l, i) => l !== lines[i - 1]).join(' ');
}

// ---------- collectors ----------
const postMap = new Map();
const commentMap = new Map();
const dropped = { outside_window: 0, no_date: 0, not_tracked_account: 0, retweets_or_replies_to_others: 0 };

function addPost(p) {
  if (!p.published_at) {
    dropped.no_date += 1;
    return;
  }
  if (p.platform !== 'reddit' && Date.parse(p.published_at) < windowStart) {
    dropped.outside_window += 1;
    return;
  }
  postMap.set(p.post_id, { quotes_post_id: null, transcript: '', shared_urls: [], ...p });
}
const addComment = (c) => c.comment_id && c.post_id && commentMap.set(c.comment_id, c);

// X
for (const t of raw('x', 'posts')) {
  const handle = t.author?.userName;
  const c = creatorFor('x', handle);
  if (!t.id || !c) {
    dropped.not_tracked_account += 1;
    continue;
  }
  if (t.isRetweet || (t.isReply && clean(t.inReplyToUsername) !== clean(handle))) {
    dropped.retweets_or_replies_to_others += 1;
    continue;
  }
  const expanded = (t.entities?.urls ?? []).map((u) => u.expanded_url ?? u.expandedUrl).filter(Boolean);
  addPost({
    post_id: `x_${t.id}`, raw_id: String(t.id), platform: 'x', creator_id: c.id, creator: c.name, handle: `@${handle}`,
    url: t.url ?? t.twitterUrl, published_at: parseDate(t.createdAt), kind: t.isReply ? 'thread' : 'post',
    text: t.text ?? '', shared_urls: [...new Set([...expanded, ...urlsIn(t.text)])],
    metrics: { likes: num(t.likeCount), comments: num(t.replyCount), shares: (num(t.retweetCount) ?? 0) + (num(t.quoteCount) ?? 0), views: num(t.viewCount) },
  });
}
for (const r of raw('x', 'replies')) {
  const post = postMap.get(`x_${r.conversationId}`);
  if (!post || !r.id || String(r.id) === String(r.conversationId)) continue;
  addComment({
    comment_id: `xc_${r.id}`, post_id: post.post_id, platform: 'x',
    parent_id: r.inReplyToId && String(r.inReplyToId) !== String(r.conversationId) ? `xc_${r.inReplyToId}` : null,
    author: `@${r.author?.userName}`, is_creator: clean(r.author?.userName) === clean(post.handle),
    likes: num(r.likeCount) ?? 0, text: r.text ?? '', published_at: parseDate(r.createdAt), url: r.url ?? r.twitterUrl ?? post.url,
  });
}

// Instagram
function addIgComment(k, post, parentId) {
  if (!k?.id) return;
  const author = k.ownerUsername ?? k.owner?.username;
  addComment({
    comment_id: `igc_${k.id}`, post_id: post.post_id, platform: 'instagram', parent_id: parentId,
    author: `@${author}`, is_creator: clean(author) === clean(post.handle), likes: num(k.likesCount) ?? 0,
    text: k.text ?? '', published_at: parseDate(k.timestamp), url: k.commentUrl ?? post.url,
  });
  for (const reply of k.replies ?? []) addIgComment(reply, post, `igc_${k.id}`);
}
for (const p of raw('instagram', 'posts')) {
  const c = creatorFor('instagram', p.ownerUsername);
  if (!c || !p.shortCode) {
    dropped.not_tracked_account += 1;
    continue;
  }
  addPost({
    post_id: `ig_${p.shortCode}`, raw_id: String(p.id ?? p.shortCode), platform: 'instagram', creator_id: c.id, creator: c.name,
    handle: `@${p.ownerUsername}`, url: p.url ?? `https://www.instagram.com/p/${p.shortCode}/`, published_at: parseDate(p.timestamp),
    kind: p.productType === 'clips' ? 'reel' : p.type === 'Video' ? 'video' : 'post',
    text: p.caption ?? '', transcript: p.transcript ?? '', shared_urls: urlsIn(p.caption),
    metrics: { likes: num(p.likesCount), comments: num(p.commentsCount), shares: num(p.reshareCount), views: num(p.videoPlayCount ?? p.videoViewCount) },
  });
  const post = postMap.get(`ig_${p.shortCode}`);
  if (post) for (const k of p.latestComments ?? []) addIgComment(k, post, null);
}
const igCode = (url) => String(url ?? '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1];
for (const k of raw('instagram', 'comments')) {
  if (k.error) continue;
  const post = postMap.get(`ig_${igCode(k.postUrl)}`);
  if (post) addIgComment(k, post, null);
}

// LinkedIn
for (const p of raw('linkedin', 'posts')) {
  if (p.type && p.type !== 'post') continue;
  const c = creatorFor('linkedin', p.author?.publicIdentifier || liSlug(p.author?.linkedinUrl));
  if (!c || !p.id) {
    dropped.not_tracked_account += 1;
    continue;
  }
  addPost({
    post_id: `li_${p.id}`, raw_id: String(p.id), platform: 'linkedin', creator_id: c.id, creator: c.name,
    handle: p.author?.name ?? c.name, url: p.linkedinUrl ?? p.socialContent?.shareUrl,
    published_at: parseDate(p.postedAt?.date ?? p.postedAt?.timestamp), kind: 'post',
    text: p.content ?? '', shared_urls: urlsIn(p.content),
    metrics: { likes: num(p.engagement?.likes), comments: num(p.engagement?.comments), shares: num(p.engagement?.shares), views: null },
  });
}
const liPosts = [...postMap.values()].filter((p) => p.platform === 'linkedin');
function liPostFor(k) {
  const direct = liPosts.find((p) => p.raw_id === String(k.postId));
  if (direct) return direct;
  const haystack = JSON.stringify([k.linkedinUrl, k.query, k.input, k.postUrl, k.postId]);
  return liPosts.find((p) => haystack.includes(p.raw_id)) ?? null;
}
function addLiComment(k, post, parentId) {
  if (!k?.id) return;
  const creatorSlug = liSlug(creators.find((c) => c.id === post.creator_id)?.handles.linkedin?.url);
  const likes = Array.isArray(k.reactionTypeCounts)
    ? k.reactionTypeCounts.reduce((s, r) => s + (r.count ?? 0), 0)
    : num(k.engagement?.likes ?? k.likes) ?? 0;
  addComment({
    comment_id: `lic_${k.id}`, post_id: post.post_id, platform: 'linkedin', parent_id: parentId,
    author: k.actor?.name ?? 'LinkedIn member',
    is_creator: Boolean(creatorSlug && liSlug(k.actor?.linkedinUrl) === creatorSlug),
    author_flag: k.actor?.author === true,
    likes, text: k.commentary ?? k.text ?? '', published_at: parseDate(k.createdAt ?? k.createdAtTimestamp), url: k.linkedinUrl ?? post.url,
  });
  for (const reply of k.replies ?? []) addLiComment(reply, post, `lic_${k.id}`);
}
for (const k of raw('linkedin', 'comments')) {
  if (k.type && k.type !== 'comment') continue;
  const post = liPostFor(k);
  if (post) addLiComment(k, post, null);
}

// YouTube
for (const v of raw('youtube', 'posts')) {
  if (!v.id || v.error) continue;
  const c =
    creatorFor('youtube', v.channelUsername) ??
    creators.find((cr) => cr.handles.youtube && [v.channelUrl, v.channelId].join(' ').includes(cr.handles.youtube.url.split('/').filter(Boolean).pop()));
  if (!c) {
    dropped.not_tracked_account += 1;
    continue;
  }
  const subs = Array.isArray(v.subtitles) ? v.subtitles : [];
  const sub = subs.find((s) => /^en/i.test(s.language ?? '')) ?? subs[0];
  addPost({
    post_id: `yt_${v.id}`, raw_id: String(v.id), platform: 'youtube', creator_id: c.id, creator: c.name,
    handle: c.handles.youtube.handle, url: v.url ?? `https://www.youtube.com/watch?v=${v.id}`,
    published_at: parseDate(v.date), kind: v.type === 'shorts' ? 'short' : 'video',
    text: [v.title, v.text].filter(Boolean).join('\n\n'), transcript: subtitleText(sub?.srt ?? sub?.plaintext ?? sub?.text),
    shared_urls: urlsIn(v.text), metrics: { likes: num(v.likes), comments: num(v.commentsCount), shares: null, views: num(v.viewCount) },
  });
}
for (const k of raw('youtube', 'comments')) {
  const videoId = k.videoId ?? String(k.pageUrl ?? '').match(/[?&]v=([^&]+)/)?.[1];
  const post = postMap.get(`yt_${videoId}`);
  if (!post || !k.cid) continue;
  addComment({
    comment_id: `ytc_${k.cid}`, post_id: post.post_id, platform: 'youtube', parent_id: k.replyToCid ? `ytc_${k.replyToCid}` : null,
    author: k.author ?? 'YouTube user', is_creator: Boolean(k.authorIsChannelOwner), likes: num(k.voteCount) ?? 0,
    text: k.comment ?? '', published_at: parseDate(k.publishedTimeText), time_approx: true, url: post.url,
  });
}

// TikTok
for (const v of raw('tiktok', 'posts')) {
  if (!v.id || v.error) continue;
  const c = creatorFor('tiktok', v.authorMeta?.name);
  if (!c) {
    dropped.not_tracked_account += 1;
    continue;
  }
  const subFile = join(DATA, 'raw', 'tiktok', 'subtitles', `${v.id}.vtt`);
  addPost({
    post_id: `tt_${v.id}`, raw_id: String(v.id), platform: 'tiktok', creator_id: c.id, creator: c.name,
    handle: `@${v.authorMeta.name}`, url: v.webVideoUrl, published_at: parseDate(v.createTimeISO ?? v.createTime), kind: 'video',
    text: v.text ?? '', transcript: existsSync(subFile) ? subtitleText(readFileSync(subFile, 'utf8')) : '',
    metrics: { likes: num(v.diggCount), comments: num(v.commentCount), shares: num(v.shareCount), views: num(v.playCount) },
  });
}
for (const k of raw('tiktok', 'comments')) {
  const videoId = String(k.videoWebUrl ?? k.submittedVideoUrl ?? k.input ?? '').match(/video\/(\d+)/)?.[1];
  const post = postMap.get(`tt_${videoId}`);
  if (!post || !k.cid) continue;
  addComment({
    comment_id: `ttc_${k.cid}`, post_id: post.post_id, platform: 'tiktok', parent_id: k.repliesToId ? `ttc_${k.repliesToId}` : null,
    author: `@${k.uniqueId}`, is_creator: clean(k.uniqueId) === clean(post.handle), likes: num(k.diggCount) ?? 0,
    text: k.text ?? '', published_at: parseDate(k.createTimeISO ?? k.createTime), url: post.url,
  });
}

// Reddit: communities, not creators; the original poster is flagged as is_creator.
const redditItems = raw('reddit', 'threads');
const redditUrl = (permalink) => (!permalink ? null : permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`);
for (const item of redditItems.filter((i) => i.type === 'post')) {
  const id = String(item.id).replace(/^t3_/, '');
  addPost({
    post_id: `rd_${id}`, raw_id: id, platform: 'reddit', creator_id: null, creator: `r/${item.subreddit}`, handle: `r/${item.subreddit}`,
    url: redditUrl(item.permalink) ?? item.url, published_at: parseDate(item.createdAt), kind: 'thread',
    text: [item.title, item.selfText].filter(Boolean).join('\n\n'),
    shared_urls: item.link && !/reddit\.com|redd\.it/.test(item.link) ? [item.link] : [],
    metrics: { likes: num(item.score), comments: num(item.numComments), shares: null, views: null },
  });
}
for (const item of redditItems.filter((i) => i.type === 'comment')) {
  const post = postMap.get(`rd_${String(item.postId).replace(/^t3_/, '')}`);
  if (!post) continue;
  const parent = String(item.parentId ?? '');
  addComment({
    comment_id: `rdc_${String(item.id).replace(/^t1_/, '')}`, post_id: post.post_id, platform: 'reddit',
    parent_id: parent.startsWith('t1_') ? `rdc_${parent.slice(3)}` : null, author: `u/${item.author}`,
    is_creator: Boolean(item.isSubmitter), likes: num(item.score) ?? 0, text: item.body ?? '',
    published_at: parseDate(item.createdAt), url: redditUrl(item.permalink) ?? post.url,
  });
}

// ---------- finishing ----------
const posts = [...postMap.values()];
const comments = [...commentMap.values()].filter((c) => postMap.has(c.post_id) && c.text.trim());

// Replies whose parent wasn't collected become top-level.
for (const c of comments) if (c.parent_id && !commentMap.has(c.parent_id)) c.parent_id = null;

// LinkedIn's actor.author flag is unverified; trust it only if it isn't set on most comments of a post.
const liByPost = Object.groupBy(comments.filter((c) => c.platform === 'linkedin'), (c) => c.post_id);
for (const list of Object.values(liByPost)) {
  const flagged = list.filter((c) => c.author_flag).length;
  const trust = flagged > 0 && flagged <= Math.max(1, list.length * 0.3);
  for (const c of list) {
    c.is_creator = c.is_creator || (trust && c.author_flag);
    delete c.author_flag;
  }
}

// Lift: engagement compared with the same account's other posts this week.
const engagement = (p) => (p.metrics.likes ?? 0) + 2 * (p.metrics.comments ?? 0) + 3 * (p.metrics.shares ?? 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const byAccount = Object.groupBy(posts, (p) => `${p.platform}|${p.creator_id ?? p.handle}`);
for (const list of Object.values(byAccount)) {
  const base = median(list.map(engagement));
  for (const p of list) {
    p.engagement = engagement(p);
    p.lift = list.length >= 3 ? round1(p.engagement / Math.max(base, 1)) : 1;
  }
}

posts.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
writeJson(join(DATA, 'posts.json'), posts);
writeJson(join(DATA, 'comments.json'), comments);

const report = {};
for (const p of posts) {
  const r = (report[p.platform] ||= { posts: 0, with_transcript: 0, comments: 0, creator_replies: 0, accounts: new Set() });
  r.posts += 1;
  if (p.transcript) r.with_transcript += 1;
  r.accounts.add(p.creator_id ?? p.handle);
}
for (const c of comments) {
  const r = report[c.platform];
  if (!r) continue;
  r.comments += 1;
  if (c.is_creator) r.creator_replies += 1;
}
const table = Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { ...v, accounts: v.accounts.size }]));
writeJson(join(DATA, 'collection_report.json'), { collected_at: meta.collected_at, window_from: meta.window_from, platforms: table, dropped });
console.table(table);
console.log('dropped:', dropped);
console.log(`normalize: ${posts.length} posts, ${comments.length} comments → data/posts.json, data/comments.json`);
