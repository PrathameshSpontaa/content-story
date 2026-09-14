// Creator profiles from the dry run: the stored form of each handle, and the profile photo each
// channel's collector returned with the creator's posts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const liSlug = (url) => (String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? '').toLowerCase();

export const handleFor = (platform, account) =>
  platform === 'linkedin' ? liSlug(account.url) : platform === 'youtube' ? account.handle : `@${String(account.handle).replace(/^@/, '')}`;

// X serves a 48px photo by default; the 200px one stays sharp at avatar size.
const largerX = (url) => String(url).replace(/_normal(\.\w+)$/, '_200x200$1');

// Where each collector puts the author's photo. Instagram's post collector doesn't return one.
const PHOTO_OF = {
  x: (post) => (post.author?.profilePicture ? largerX(post.author.profilePicture) : null),
  youtube: (post) => post.channelAvatarUrl ?? null,
  linkedin: (post) => post.author?.avatar?.url ?? null,
  tiktok: (post) => post.authorMeta?.avatar ?? post.authorMeta?.originalAvatarUrl ?? null,
};

// Map of `${creatorConfigId}|${platform}` → photo URL, taken from each creator's newest post.
export function readAvatars(dataDir, posts) {
  const byRawPost = new Map();
  for (const [platform, photoOf] of Object.entries(PHOTO_OF)) {
    const file = join(dataDir, 'raw', platform, 'posts.json');
    if (!existsSync(file)) continue;
    for (const raw of JSON.parse(readFileSync(file, 'utf8'))) {
      const url = raw?.id == null ? null : photoOf(raw);
      if (url) byRawPost.set(`${platform}|${raw.id}`, url);
    }
  }
  const avatars = new Map();
  const newestFirst = [...posts].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  for (const p of newestFirst) {
    const url = p.creator_id ? byRawPost.get(`${p.platform}|${p.raw_id}`) : null;
    const key = `${p.creator_id}|${p.platform}`;
    if (url && !avatars.has(key)) avatars.set(key, url);
  }
  return avatars;
}
