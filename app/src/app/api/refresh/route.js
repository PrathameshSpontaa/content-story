import { NextResponse } from 'next/server';
import { getRefreshStatus, requestRefresh } from '../../../../lib/refresh.js';
import { getSession } from '../../../../lib/session.js';

export const dynamic = 'force-dynamic';

// The Refresh control on the Stories page.
// GET /api/refresh: where this workspace's refresh stands. POST /api/refresh: ask for one now; a refusal
// (cooldown, daily limit, turned off) comes back as { ok: false, message, nextAllowedAt }.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in again to refresh.' }, { status: 401 });
  const status = await getRefreshStatus(session.workspace.id);
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in again to refresh.' }, { status: 401 });
  const workspaceId = session.workspace.id;
  const result = await requestRefresh({ workspaceId, userId: session.user.id, reason: 'button' });
  const status = await getRefreshStatus(workspaceId);
  return NextResponse.json({ ...result, status }, { headers: { 'Cache-Control': 'no-store' } });
}
