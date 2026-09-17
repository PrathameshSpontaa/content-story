import { NextResponse } from 'next/server';
import { previewKeyword, searchCommunities, withCreatorStats } from '../../../../lib/following.js';
import { WatchlistError, looksLikeProfile, parseCommunity } from '../../../../lib/profiles.js';
import { getSession } from '../../../../lib/session.js';
import { lookupProfile, searchCreators } from '../../../../lib/watchlist.js';

export const dynamic = 'force-dynamic';

// The search box: a name searches everyone we know; a pasted link or @handle is looked up.
// scope=all (the Following page) also finds subreddits and previews the query as a brand or topic,
// with each result's numbers for the week.
// GET /api/creators?q=tanmay  ·  ?q=instagram.com/name  ·  ?q=@name&platform=youtube  ·  ?q=gemini&scope=all
export async function GET(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in again to search.' }, { status: 401 });

  const workspaceId = session.workspace.id;
  const params = request.nextUrl.searchParams;
  const q = (params.get('q') ?? '').slice(0, 200);
  const platform = params.get('platform');
  const all = params.get('scope') === 'all';

  if (platform || looksLikeProfile(q)) {
    const found = await lookupProfile(workspaceId, q, platform);
    if (all && found.status === 'community') {
      let name = null;
      try {
        name = parseCommunity(q);
      } catch (err) {
        if (!(err instanceof WatchlistError)) throw err;
      }
      const communities = await searchCommunities(workspaceId, q);
      const known = name && communities.some((c) => c.name.toLowerCase() === name.toLowerCase());
      return NextResponse.json({ kind: 'communities', communities, candidate: name && !known ? name : null });
    }
    if (all && found.creator) found.creator = (await withCreatorStats([found.creator], workspaceId))[0];
    return NextResponse.json({ kind: 'lookup', ...found });
  }

  const creators = await searchCreators(workspaceId, q);
  if (!all) return NextResponse.json({ kind: 'search', creators });
  const [withStats, communities, keyword] = await Promise.all([withCreatorStats(creators, workspaceId), searchCommunities(workspaceId, q), previewKeyword(workspaceId, q)]);
  return NextResponse.json({ kind: 'search', creators: withStats, communities, keyword });
}
