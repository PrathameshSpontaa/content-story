import { NextResponse } from 'next/server';
import { FinderError, findChannels, suggestCreators } from '../../../../../lib/finder.js';
import { getSession } from '../../../../../lib/session.js';

export const dynamic = 'force-dynamic';

// The channel finder. POST { name, link, creatorId } finds one creator's channels;
// POST { suggest: true, niche, useCase } suggests creators for a niche. A search takes 10–60 seconds.
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in again to search.' }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send JSON.' }, { status: 400 });
  }
  const workspaceId = session.workspace.id;
  try {
    if (body?.suggest) {
      const creators = await suggestCreators(workspaceId, { niche: String(body.niche ?? ''), useCase: String(body.useCase ?? '') });
      return NextResponse.json({ creators });
    }
    const creatorId = /^[0-9a-f-]{36}$/i.test(String(body?.creatorId ?? '')) ? body.creatorId : null;
    const found = await findChannels(workspaceId, { name: String(body?.name ?? ''), link: String(body?.link ?? ''), creatorId });
    return NextResponse.json(found);
  } catch (err) {
    if (err instanceof FinderError) return NextResponse.json({ error: err.message }, { status: 422 });
    console.error('[finder]', err);
    return NextResponse.json({ error: 'Something went wrong on our side. Paste their profile links instead.' }, { status: 500 });
  }
}
