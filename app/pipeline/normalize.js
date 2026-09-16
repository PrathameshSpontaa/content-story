// Turns raw Apify items from six platforms into the post and comment shapes the database stores.
// Same ids as the dry run (x_<id>, ig_<shortCode>, li_<id>, yt_<id>, tt_<id>, rd_<id>), so a post
// seen again lands on its existing row. Pure functions: no files, no database.

const DAY = 86_400_000;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const UNIT = { second: 1e3, minute: 6e4, hour: 3.6e6, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

export const clean = (h) => String(h ?? '').replace(/^@/, '').trim().toLowerCase();
export const liSlug = (url) => (String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? '').toLowerCase();
const round1 = (n) => Math.round(n * 10) / 10;

export function parseDate(value, collectedAt = Date.now()) {
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

export function num(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 0 ? null : value;
  const m = String(value).replace(/,/g, '').trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1));
}

const urlsIn = (text) => [...new Set((String(text ?? '').match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).filter((u) => !/\/\/t\.co\//.test(u)))];

export function subtitleText(content) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->') && !/^(WEBVTT|NOTE|Kind:|Language:)/.test(l));
  return lines.filter((l, i) => l !== lines[i - 1]).join(' ');
}

// Engagement counts comments and shares more than likes; lift compares a post with its account's median.
export const engagementOf = (m) => (m?.likes ?? 0) + 2 * (m?.comments ?? 0) + 3 * (m?.shares ?? 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
export const accountKey = (p) => `${p.platform}|${p.handle_id ?? p.community ?? p.account}`;

// Tracked handles (rows of creator_handles with the creator's name) indexed the way each platform
// names its authors: lower-cased handle without @, or the profile slug for LinkedIn.
function indexHandles(handles) {
  const byKey = {};
  for (const h of handles ?? []) {
    const key = h.platform === 'linkedin' ? liSlug(h.url) || clean(h.handle) : clean(h.handle);
    (byKey[h.platform] ||= new Map()).set(key, h);
  }
  return {
    find: (platform, key) => byKey[platform]?.get(platform === 'linkedin' ? String(key ?? '').toLowerCase() : clean(key)) ?? null,
    all: (platform) => [...(byKey[platform]?.values() ?? [])],
  };
}

// Reads posts (and any comments that arrive with them) out of raw items grouped by platform.
// Options: handles (creator_handles rows), collectedAt (ms), windowFrom (ms; older posts are dropped,
// Reddit excepted, as in the dry run), keepUntracked (search results from accounts we don't track),
// subtitles (Map of TikTok video id to VTT text).
export function normalizePosts(rawByPlatform, { handles = [], collectedAt = Date.now(), windowFrom = null, keepUntracked = false, subtitles = new Map() } = {}) {
  const tracked = indexHandles(handles);
  const raw = (platform) => (Array.isArray(rawByPlatform?.[platform]) ? rawByPlatform[platform] : []);
  const date = (v) => parseDate(v, collectedAt);
  const windowStart = windowFrom != null ? windowFrom - DAY / 2 : null;
  const postMap = new Map();
  const comments = [];
  const dropped = { outside_window: 0, no_date: 0, not_tracked_account: 0, retweets_or_replies_to_others: 0 };

  function addPost(p) {
    if (!p.published_at) {
      dropped.no_date += 1;
      return null;
    }
    if (p.platform !== 'reddit' && windowStart != null && Date.parse(p.published_at) < windowStart) {
      dropped.outside_window += 1;
      return null;
    }
    const post = { quotes_post_id: null, transcript: '', shared_urls: [], handle_id: null, creator_id: null, community: null, ...p };
    postMap.set(post.post_id, post);
    return post;
  }
  // Who a post belongs to: a tracked handle, or (for search results) the author as seen.
  function owner(platform, key, fallback) {
    const h = tracked.find(platform, key);
    if (h) return { handle_id: h.id, creator_id: h.creator_id, creator: h.creator_name ?? fallback.creator, handle: h.platform === 'linkedin' ? fallback.handle : h.handle, account: clean(key) };
    if (!keepUntracked) {
      dropped.not_tracked_account += 1;
      return null;
    }
    return { handle_id: null, creator_id: null, creator: fallback.creator, handle: fallback.handle, account: clean(key) };
  }

  // X
  for (const t of raw('x')) {
    const handle = t.author?.userName;
    if (!t.id || !t.url || !handle) {
      dropped.not_tracked_account += 1;
      continue;
    }
    const who = owner('x', handle, { creator: t.author?.name ?? `@${handle}`, handle: `@${handle}` });
    if (!who) continue;
    if (t.isRetweet || (who.handle_id && t.isReply && clean(t.inReplyToUsername) !== clean(handle))) {
      dropped.retweets_or_replies_to_others += 1;
      continue;
    }
    const expanded = (t.entities?.urls ?? []).map((u) => u.expanded_url ?? u.expandedUrl).filter(Boolean);
    addPost({
      post_id: `x_${t.id}`, raw_id: String(t.id), platform: 'x', ...who,
      url: t.url ?? t.twitterUrl, published_at: date(t.createdAt), kind: t.isReply ? 'thread' : 'post',
      text: t.text ?? '', shared_urls: [...new Set([...expanded, ...urlsIn(t.text)])],
      quotes_post_id: t.quoted_tweet?.id ? `x_${t.quoted_tweet.id}` : null,
      metrics: { likes: num(t.likeCount), comments: num(t.replyCount), shares: (num(t.retweetCount) ?? 0) + (num(t.quoteCount) ?? 0), views: num(t.viewCount) },
    });
  }

  // Instagram (latestComments ride along with the post)
  for (const p of raw('instagram')) {
    if (!p.shortCode || p.error) {
      dropped.not_tracked_account += 1;
      continue;
    }
    const who = owner('instagram', p.ownerUsername, { creator: p.ownerFullName ?? `@${p.ownerUsername}`, handle: `@${p.ownerUsername}` });
    if (!who) continue;
    const post = addPost({
      post_id: `ig_${p.shortCode}`, raw_id: String(p.id ?? p.shortCode), platform: 'instagram', ...who,
      url: p.url ?? `https://www.instagram.com/p/${p.shortCode}/`, published_at: date(p.timestamp),
      kind: p.productType === 'clips' ? 'reel' : p.type === 'Video' ? 'video' : 'post',
      text: p.caption ?? '', transcript: p.transcript ?? '', shared_urls: urlsIn(p.caption),
      metrics: { likes: num(p.likesCount), comments: num(p.commentsCount), shares: num(p.reshareCount), views: num(p.videoPlayCount ?? p.videoViewCount) },
    });
    if (post) for (const k of p.latestComments ?? []) comments.push(...igComments(k, post, null, collectedAt));
  }

  // LinkedIn
  for (const p of raw('linkedin')) {
    if ((p.type && p.type !== 'post') || !p.id) {
      dropped.not_tracked_account += 1;
      continue;
    }
    const slug = p.author?.publicIdentifier || liSlug(p.author?.linkedinUrl);
    const who = owner('linkedin', slug, { creator: p.author?.name ?? slug, handle: p.author?.name ?? slug });
    if (!who) continue;
    addPost({
      post_id: `li_${p.id}`, raw_id: String(p.id), platform: 'linkedin', ...who, account: String(slug).toLowerCase(),
      url: p.linkedinUrl ?? p.socialContent?.shareUrl, published_at: date(p.postedAt?.date ?? p.postedAt?.timestamp), kind: 'post',
      text: p.content ?? '', shared_urls: urlsIn(p.content),
      metrics: { likes: num(p.engagement?.likes), comments: num(p.engagement?.comments), shares: num(p.engagement?.shares), views: null },
    });
  }

  // YouTube: the handle, or the channel URL/id when the stored handle is a channel link.
  for (const v of raw('youtube')) {
    if (!v.id || v.error) continue;
    const byChannel = tracked.find('youtube', v.channelUsername)
      ? null
      : tracked.all('youtube').find((h) => [v.channelUrl, v.channelId].join(' ').includes(h.url.split('/').filter(Boolean).pop()));
    const key = byChannel ? byChannel.handle : v.channelUsername || v.channelName;
    const who = owner('youtube', key, { creator: v.channelName ?? key, handle: v.channelUsername ? `@${clean(v.channelUsername)}` : v.channelName });
    if (!who) continue;
    const subs = Array.isArray(v.subtitles) ? v.subtitles : [];
    const sub = subs.find((s) => /^en/i.test(s.language ?? '')) ?? subs[0];
    addPost({
      post_id: `yt_${v.id}`, raw_id: String(v.id), platform: 'youtube', ...who,
      url: v.url ?? `https://www.youtube.com/watch?v=${v.id}`, published_at: date(v.date), kind: v.type === 'shorts' ? 'short' : 'video',
      text: [v.title, v.text].filter(Boolean).join('\n\n'), transcript: subtitleText(sub?.srt ?? sub?.plaintext ?? sub?.text),
      shared_urls: urlsIn(v.text), metrics: { likes: num(v.likes), comments: num(v.commentsCount), shares: null, views: num(v.viewCount) },
    });
  }

  // TikTok (subtitles are fetched by the caller; inline comments appear when the run asked for them)
  for (const v of raw('tiktok')) {
    if (!v.id || v.error) continue;
    const name = v.authorMeta?.name;
    const who = owner('tiktok', name, { creator: v.authorMeta?.nickName ?? `@${name}`, handle: `@${name}` });
    if (!who) continue;
    const post = addPost({
      post_id: `tt_${v.id}`, raw_id: String(v.id), platform: 'tiktok', ...who,
      url: v.webVideoUrl, published_at: date(v.createTimeISO ?? v.createTime), kind: 'video',
      text: v.text ?? '', transcript: subtitleText(subtitles.get(String(v.id)) ?? ''),
      metrics: { likes: num(v.diggCount), comments: num(v.commentCount), shares: num(v.shareCount), views: num(v.playCount) },
    });
    if (post) for (const k of v.comments ?? []) comments.push(ttComment(k, post, collectedAt));
  }

  // Reddit: communities, not creators; the original poster is flagged as is_creator on comments.
  const redditItems = raw('reddit');
  for (const item of redditItems.filter((i) => i.type === 'post')) {
    const id = String(item.id).replace(/^t3_/, '');
    addPost({
      post_id: `rd_${id}`, raw_id: id, platform: 'reddit', creator: `r/${item.subreddit}`, handle: `r/${item.subreddit}`, account: clean(item.author),
      community: `r/${item.subreddit}`, url: redditUrl(item.permalink) ?? item.url, published_at: date(item.createdAt), kind: 'thread',
      text: [item.title, item.selfText].filter(Boolean).join('\n\n'),
      shared_urls: item.link && !/reddit\.com|redd\.it/.test(item.link) ? [item.link] : [],
      metrics: { likes: num(item.score), comments: num(item.numComments), shares: null, views: null },
    });
  }
  for (const item of redditItems.filter((i) => i.type === 'comment')) {
    const post = postMap.get(`rd_${String(item.postId).replace(/^t3_/, '')}`);
    if (post) comments.push(rdComment(item, post, collectedAt));
  }

  const posts = [...postMap.values()];
  for (const p of posts) p.engagement = engagementOf(p.metrics);
  posts.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
  return { posts, comments: finishComments(comments, posts), dropped };
}

// Lift: a post's engagement against the median of its account. `baseline` maps accountKey to the
// account's recent engagements already in the database, so a small daily batch still has a median.
export function applyLift(posts, baseline = new Map()) {
  const byAccount = new Map();
  for (const p of posts) byAccount.set(accountKey(p), [...(byAccount.get(accountKey(p)) ?? []), p]);
  for (const [key, list] of byAccount) {
    const known = new Map((baseline.get(key) ?? []).map((b) => [b.post_id, b.engagement]));
    for (const p of list) known.set(p.post_id, p.engagement ?? engagementOf(p.metrics));
    const values = [...known.values()];
    const base = median(values);
    for (const p of list) p.lift = values.length >= 3 ? round1((p.engagement ?? engagementOf(p.metrics)) / Math.max(base, 1)) : 1;
  }
  return posts;
}

// ---------- comments ----------
const redditUrl = (permalink) => (!permalink ? null : permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`);
const igCode = (url) => String(url ?? '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1];

function igComments(k, post, parentId, collectedAt) {
  if (!k?.id) return [];
  const author = k.ownerUsername ?? k.owner?.username;
  const out = [{
    comment_id: `igc_${k.id}`, post_id: post.post_id, platform: 'instagram', parent_id: parentId,
    author: `@${author}`, is_creator: clean(author) === post.account, likes: num(k.likesCount) ?? 0,
    text: k.text ?? '', published_at: parseDate(k.timestamp, collectedAt), url: k.commentUrl ?? post.url,
  }];
  for (const reply of k.replies ?? []) out.push(...igComments(reply, post, `igc_${k.id}`, collectedAt));
  return out;
}

function liComments(k, post, parentId, collectedAt) {
  if (!k?.id) return [];
  const likes = Array.isArray(k.reactionTypeCounts)
    ? k.reactionTypeCounts.reduce((s, r) => s + (r.count ?? 0), 0)
    : num(k.engagement?.likes ?? k.likes) ?? 0;
  const out = [{
    comment_id: `lic_${k.id}`, post_id: post.post_id, platform: 'linkedin', parent_id: parentId,
    author: k.actor?.name ?? 'LinkedIn member',
    is_creator: Boolean(post.account && liSlug(k.actor?.linkedinUrl) === post.account),
    author_flag: k.actor?.author === true,
    likes, text: k.commentary ?? k.text ?? '', published_at: parseDate(k.createdAt ?? k.createdAtTimestamp, collectedAt), url: k.linkedinUrl ?? post.url,
  }];
  for (const reply of k.replies ?? []) out.push(...liComments(reply, post, `lic_${k.id}`, collectedAt));
  return out;
}

const ttComment = (k, post, collectedAt) => ({
  comment_id: `ttc_${k.cid}`, post_id: post.post_id, platform: 'tiktok', parent_id: k.repliesToId ? `ttc_${k.repliesToId}` : null,
  author: `@${k.uniqueId}`, is_creator: clean(k.uniqueId) === post.account, likes: num(k.diggCount) ?? 0,
  text: k.text ?? '', published_at: parseDate(k.createTimeISO ?? k.createTime, collectedAt), url: post.url,
});

function rdComment(item, post, collectedAt) {
  const parent = String(item.parentId ?? '');
  return {
    comment_id: `rdc_${String(item.id).replace(/^t1_/, '')}`, post_id: post.post_id, platform: 'reddit',
    parent_id: parent.startsWith('t1_') ? `rdc_${parent.slice(3)}` : null, author: `u/${item.author}`,
    is_creator: Boolean(item.isSubmitter), likes: num(item.score) ?? 0, text: item.body ?? '',
    published_at: parseDate(item.createdAt, collectedAt), url: redditUrl(item.permalink) ?? post.url,
  };
}

// Reads comments collected in a separate pass and attaches them to known posts. `posts` needs
// post_id, platform, raw_id, url and account (the owner's lower-cased handle or LinkedIn slug).
export function normalizeComments(rawByPlatform, { posts = [], collectedAt = Date.now() } = {}) {
  const raw = (platform) => (Array.isArray(rawByPlatform?.[platform]) ? rawByPlatform[platform] : []);
  const postById = new Map(posts.map((p) => [p.post_id, p]));
  const out = [];

  for (const r of raw('x')) {
    const post = postById.get(`x_${r.conversationId}`);
    if (!post || !r.id || String(r.id) === String(r.conversationId)) continue;
    out.push({
      comment_id: `xc_${r.id}`, post_id: post.post_id, platform: 'x',
      parent_id: r.inReplyToId && String(r.inReplyToId) !== String(r.conversationId) ? `xc_${r.inReplyToId}` : null,
      author: `@${r.author?.userName}`, is_creator: clean(r.author?.userName) === post.account,
      likes: num(r.likeCount) ?? 0, text: r.text ?? '', published_at: parseDate(r.createdAt, collectedAt), url: r.url ?? r.twitterUrl ?? post.url,
    });
  }
  for (const k of raw('instagram')) {
    if (k.error) continue;
    const post = postById.get(`ig_${igCode(k.postUrl)}`);
    if (post) out.push(...igComments(k, post, null, collectedAt));
  }
  const liPosts = posts.filter((p) => p.platform === 'linkedin');
  for (const k of raw('linkedin')) {
    if (k.type && k.type !== 'comment') continue;
    const haystack = JSON.stringify([k.linkedinUrl, k.query, k.input, k.postUrl, k.postId]);
    const post = liPosts.find((p) => p.raw_id === String(k.postId)) ?? liPosts.find((p) => haystack.includes(p.raw_id));
    if (post) out.push(...liComments(k, post, null, collectedAt));
  }
  for (const k of raw('youtube')) {
    const videoId = k.videoId ?? String(k.pageUrl ?? '').match(/[?&]v=([^&]+)/)?.[1];
    const post = postById.get(`yt_${videoId}`);
    if (!post || !k.cid) continue;
    out.push({
      comment_id: `ytc_${k.cid}`, post_id: post.post_id, platform: 'youtube', parent_id: k.replyToCid ? `ytc_${k.replyToCid}` : null,
      author: k.author ?? 'YouTube user', is_creator: Boolean(k.authorIsChannelOwner), likes: num(k.voteCount) ?? 0,
      text: k.comment ?? '', published_at: parseDate(k.publishedTimeText, collectedAt), time_approx: true, url: post.url,
    });
  }
  for (const k of raw('tiktok')) {
    const videoId = String(k.videoWebUrl ?? k.submittedVideoUrl ?? k.input ?? '').match(/video\/(\d+)/)?.[1];
    const post = postById.get(`tt_${videoId}`);
    if (post && k.cid) out.push(ttComment(k, post, collectedAt));
  }
  for (const item of raw('reddit').filter((i) => i.type === 'comment')) {
    const post = postById.get(`rd_${String(item.postId).replace(/^t3_/, '')}`);
    if (post) out.push(rdComment(item, post, collectedAt));
  }
  return { comments: finishComments(out, posts) };
}

// Keeps comments on known posts with text, one per id; replies whose parent wasn't collected
// become top-level; LinkedIn's actor.author flag is trusted only when it isn't set on most of a post's comments.
function finishComments(list, posts) {
  const known = new Set(posts.map((p) => p.post_id));
  const byId = new Map();
  for (const c of list) if (c.comment_id && known.has(c.post_id) && String(c.text ?? '').trim()) byId.set(c.comment_id, c);
  const comments = [...byId.values()];
  for (const c of comments) if (c.parent_id && !byId.has(c.parent_id)) c.parent_id = null;

  const liByPost = new Map();
  for (const c of comments) if (c.platform === 'linkedin') liByPost.set(c.post_id, [...(liByPost.get(c.post_id) ?? []), c]);
  for (const group of liByPost.values()) {
    const flagged = group.filter((c) => c.author_flag).length;
    const trust = flagged > 0 && flagged <= Math.max(1, group.length * 0.3);
    for (const c of group) c.is_creator = c.is_creator || (trust && c.author_flag);
  }
  for (const c of comments) {
    delete c.author_flag;
    c.time_approx = Boolean(c.time_approx);
  }
  return comments;
}
