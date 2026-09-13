import { NextResponse } from 'next/server';
import { looksLikeProfile } from '../../../../lib/profiles.js';
import { getSession } from '../../../../lib/session.js';
import { lookupProfile, searchCreators } from '../../../../lib/watchlist.js';

export const dynamic = 'force-dynamic';

// The creator finder: a name searches everyone we know; a pasted link or @handle is looked up.
// GET /api/creators?q=tanmay  ·  ?q=instagram.com/name  ·  ?q=@name&platform=youtube
export async function GET(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in again to search.' }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const q = (params.get('q') ?? '').slice(0, 200);
  const platform = params.get('platform');
  if (platform || looksLikeProfile(q)) {
    return NextResponse.json({ kind: 'lookup', ...(await lookupProfile(session.workspace.id, q, platform)) });
  }
  return NextResponse.json({ kind: 'search', creators: await searchCreators(session.workspace.id, q) });
}
