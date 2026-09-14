'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../../lib/session.js';
import { LimitError, WatchlistError, addTopic, followCreator, getTarget, removeTarget, setTargetActive, slotUsage } from '../../../../lib/watchlist.js';

const OOPS = 'Something went wrong on our side. Try again in a minute.';

// The sidebar lists who you follow, so every change refreshes the whole app layout.
const refresh = () => revalidatePath('/', 'layout');

function failure(err) {
  if (err instanceof LimitError) return { error: err.message, limit: { group: err.group, max: err.limit } };
  if (err instanceof WatchlistError) return { error: err.message };
  console.error(err);
  return { error: OOPS };
}

// Follows a creator (by id), or a subreddit or brand (by name). Undoing an unfollow uses it too.
export async function followAction({ kind, creatorId, name }) {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  try {
    if (kind === 'creator') await followCreator(workspaceId, String(creatorId ?? ''));
    else await addTopic(workspaceId, { kind: kind === 'community' ? 'community' : 'keyword', query: String(name ?? '') });
  } catch (err) {
    return failure(err);
  }
  refresh();
  const { used, limit } = await slotUsage(workspaceId, kind);
  return { ok: true, lastSlot: used >= limit };
}

// Unfollowing removes the entry; the reply carries what's needed to follow it again.
export async function unfollowAction(targetId) {
  const session = await requireSession();
  const target = await getTarget(session.workspace.id, targetId);
  if (!target) return { error: 'That’s already gone from your list.' };
  await removeTarget(session.workspace.id, target.id);
  refresh();
  return { ok: true, undo: { kind: target.kind, creatorId: target.creator_id, name: target.query ?? target.name } };
}

// A paused entry stays in the list, isn't collected, and doesn't use a slot.
export async function setPausedAction(targetId, paused) {
  const session = await requireSession();
  const target = await getTarget(session.workspace.id, targetId);
  if (!target) return { error: 'That’s no longer in your list.' };
  try {
    await setTargetActive(session.workspace.id, target.id, !paused);
  } catch (err) {
    return failure(err);
  }
  refresh();
  return { ok: true };
}
