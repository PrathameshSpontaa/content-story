// The channel finder: a creator's name or one profile link in, their X, YouTube, LinkedIn, Instagram
// and TikTok profiles out, found by the AI searching the web. Also suggests creators for a niche. Answers
// are kept in creator_lookups for 30 days, so the same person or niche is only paid for once.
import { MODELS, generateJson, isFake } from '../pipeline/ai.js';
import { pool } from './db.js';
import { CREATOR_PLATFORMS, detectPlatform, parseHandle } from './profiles.js';
import { getCreatorSummary } from './watchlist.js';

const KEEP_DAYS = 30;
const DAILY_LOOKUPS = () => Number(process.env.FINDER_DAILY_LIMIT) || 60;
const finderModel = () => process.env.FINDER_MODEL || MODELS.strong();

export class FinderError extends Error {}

const CHANNEL_RULES = `Channels: x, youtube, linkedin, instagram, tiktok. Give each as a full profile URL
(x.com/handle, youtube.com/@handle or youtube.com/channel/UC…, linkedin.com/in/slug, instagram.com/handle,
tiktok.com/@handle). Only a profile that belongs to this same person: best is a link from their own
bio, website or link-in-bio page; next is the same name, photo and subject. Never guess a handle you
didn't see on the web. confidence: "high" when their own profile or site links it, "medium" when name
and subject clearly match, leave it out when unsure. LinkedIn: their personal /in/ profile only.`;

const FIND_PROMPT = `You find a content creator's official social media profiles by searching the web.
${CHANNEL_RULES}
If only a name is given and several people share it, choose the best-known creator and say who in "about".
Reply with JSON only, no other text:
{"name": "Their name as they use it", "about": "One line: who they are and what they post about", "channels": [{"platform": "instagram", "url": "https://www.instagram.com/handle/", "confidence": "high"}]}`;

const SUGGEST_PROMPT = `You suggest content creators worth following, by searching the web.
Pick up to 12 active creators (posting in the last month) who are well known for the niche given, and
fit the reader's purpose. When the niche names a country or language, pick creators from there.
${CHANNEL_RULES}
Reply with JSON only, no other text:
{"creators": [{"name": "…", "about": "One line: what they post about", "channels": [{"platform": "youtube", "url": "…", "confidence": "high"}]}]}`;

const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const keyText = (s) => clean(s, 120).toLowerCase();

// The model's channels, checked: a known platform, a URL on that platform that parses as a profile,
// one per platform. Unsure ones never get this far (the prompt leaves them out).
function cleanChannels(raw) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const platform = String(c?.platform ?? '').toLowerCase();
    const url = String(c?.url ?? '').trim();
    if (!CREATOR_PLATFORMS.includes(platform) || out.some((x) => x.platform === platform) || detectPlatform(url) !== platform) continue;
    try {
      const profile = parseHandle(platform, url);
      if (profile) out.push({ platform, ...profile, confidence: c?.confidence === 'high' ? 'high' : 'medium' });
    } catch {
      // Not a profile link (a post, a search page); skip it.
    }
  }
  return out;
}

async function cached(key) {
  const { rows } = await pool.query(`select result from creator_lookups where key = $1 and created_at > now() - make_interval(days => $2)`, [key, KEEP_DAYS]);
  return rows[0]?.result ?? null;
}

const remember = (key, result) =>
  pool.query(`insert into creator_lookups (key, result) values ($1, $2::jsonb) on conflict (key) do update set result = excluded.result, created_at = now()`, [key, JSON.stringify(result)]);

// A person can only start so many paid lookups a day; answers from the cache don't count.
async function assertUnderLimit(workspaceId) {
  const { rows } = await pool.query(
    `select count(*)::int as n from cost_events
      where workspace_id = $1 and units ->> 'step' in ('find_channels', 'suggest_creators') and created_at > now() - interval '1 day'`,
    [workspaceId],
  );
  if (rows[0].n >= DAILY_LOOKUPS()) throw new FinderError('You’ve looked up a lot of creators today. Paste their profile links instead, or try again tomorrow.');
}

async function ask({ workspaceId, step, label, system, user }) {
  await assertUnderLimit(workspaceId);
  try {
    return await generateJson({ model: finderModel(), system, user, step, label, workspaceId, webSearch: true, effort: 'low', maxAttempts: 2, maxOutputTokens: 8000 });
  } catch (err) {
    if (err?.name === 'SpendCapReached' || err?.dailyQuota) throw new FinderError('Finding creators is paused for today. Paste their profile links instead.');
    console.error(`[finder] ${step} failed:`, err.message);
    throw new FinderError('We couldn’t search for them just now. Try again, or paste their profile links.');
  }
}

// Which of these channels already belong to a creator on Content-Story: { creatorId → [platforms] }.
async function owners(channels) {
  if (!channels.length) return new Map();
  const { rows } = await pool.query(
    `select creator_id::text, platform::text from creator_handles
      where (platform::text, lower(handle)) in (select * from unnest($1::text[], $2::text[]))`,
    [channels.map((c) => c.platform), channels.map((c) => c.handle.toLowerCase())],
  );
  const map = new Map();
  for (const r of rows) map.set(r.creator_id, [...(map.get(r.creator_id) ?? []), r.platform]);
  return map;
}

// One creator's channels. Give a name, a profile link, or both. Returns { name, about, channels,
// existing }: `existing` is the creator already on Content-Story that owns one of the channels (with
// `channels` still listing everything found, so missing ones can be added to them).
export async function findChannels(workspaceId, { name = '', link = '', creatorId = null } = {}) {
  const who = clean(name, 80);
  let known = null;
  const platform = link ? detectPlatform(link) : null;
  if (link && CREATOR_PLATFORMS.includes(platform)) {
    try {
      known = { platform, ...parseHandle(platform, link) };
    } catch {
      known = null;
    }
  }
  if (!who && !known) throw new FinderError('Type their name or paste one of their profile links.');
  if (creatorId) await pool.query('update creators set channels_checked_at = now() where id = $1', [creatorId]);
  if (isFake()) return { name: who, about: '', channels: known ? [{ ...known, confidence: 'high' }] : [], existing: null };

  const key = known ? `find:${known.platform}:${known.handle.toLowerCase()}` : `find:name:${keyText(who)}`;
  let result = await cached(key);
  if (!result) {
    const user = [who ? `Name: ${who}` : null, known ? `Known profile: ${known.url}` : null, 'Find their profiles and reply with the JSON.'].filter(Boolean).join('\n');
    const out = await ask({ workspaceId, step: 'find_channels', label: key.slice(0, 80), system: FIND_PROMPT, user });
    result = { name: clean(out?.name, 80) || who, about: clean(out?.about), channels: cleanChannels(out?.channels) };
    // The profile they pasted is theirs whatever the search found.
    if (known) result.channels = [{ ...known, confidence: 'high' }, ...result.channels.filter((c) => c.platform !== known.platform)];
    await remember(key, result);
  }

  const owned = await owners(result.channels);
  const ownerId = creatorId ?? [...owned.keys()][0] ?? null;
  const existing = ownerId ? await getCreatorSummary(workspaceId, ownerId) : null;
  return { ...result, existing };
}

// Creators for a niche, each with channels, for onboarding. Ones already on Content-Story come back as
// `existing` (their summary) so picking them doesn't add a copy.
export async function suggestCreators(workspaceId, { niche = '', useCase = '' } = {}) {
  const topic = clean(niche, 120);
  if (topic.length < 3 || isFake()) return [];
  const purpose = { brand: 'a brand or marketing team', agency: 'an agency working with creators', media: 'a newsletter or media writer', exploring: 'someone exploring' }[useCase] ?? 'someone following the niche';
  const key = `suggest:${useCase || 'any'}:${keyText(topic)}`;
  let list = await cached(key);
  if (!list) {
    const out = await ask({
      workspaceId, step: 'suggest_creators', label: key.slice(0, 80), system: SUGGEST_PROMPT,
      user: `Niche: ${topic}\nReader: ${purpose}\nSuggest creators and reply with the JSON.`,
    });
    list = (Array.isArray(out?.creators) ? out.creators : [])
      .map((c) => ({ name: clean(c?.name, 80), about: clean(c?.about), channels: cleanChannels(c?.channels) }))
      .filter((c) => c.name && c.channels.length)
      .slice(0, 12);
    await remember(key, list);
  }
  const results = [];
  for (const c of list) {
    const owned = await owners(c.channels);
    const ownerId = [...owned.keys()][0];
    results.push({ ...c, existing: ownerId ? await getCreatorSummary(workspaceId, ownerId) : null });
  }
  return results;
}
