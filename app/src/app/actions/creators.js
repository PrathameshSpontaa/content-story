'use server';

import { revalidatePath } from 'next/cache';
import { collectAfterFollow } from '../../../lib/refresh.js';
import { requireSession } from '../../../lib/session.js';
import { ExistingCreatorError, LimitError, WatchlistError, addTopic, createCreator, followCreator, getCreatorSummary, slotUsage } from '../../../lib/watchlist.js';

const OOPS = 'Something went wrong on our side. Try again in a minute.';

// The sidebar lists who you follow, so changes refresh the whole app layout.
const refresh = () => revalidatePath('/', 'layout');

// A refused follow says which limit it hit, so the page can explain it next to the button.
function failure(err) {
  if (err instanceof LimitError) return { error: err.message, limit: { group: err.group, max: err.limit } };
  if (err instanceof ExistingCreatorError) return { error: err.message, existing: err.creator };
  if (err instanceof WatchlistError) return { error: err.message };
  console.error(err);
  return { error: OOPS };
}

async function tookLastSlot(workspaceId, kind) {
  const { used, limit } = await slotUsage(workspaceId, kind);
  return used >= limit;
}

// After a follow: start collecting now, and say whether this was the last slot.
async function followed(session, kind) {
  const [collecting, lastSlot] = await Promise.all([collectAfterFollow({ workspaceId: session.workspace.id, userId: session.user.id }), tookLastSlot(session.workspace.id, kind)]);
  return { collecting, lastSlot };
}

// follow: false adds the creator without following them (onboarding saves picks at the end).
export async function createCreatorAction(input) {
  const session = await requireSession();
  const follow = input?.follow !== false;
  const profiles = Array.isArray(input?.profiles)
    ? input.profiles.slice(0, 10).map((p) => ({ platform: String(p?.platform ?? ''), input: String(p?.input ?? '') }))
    : [];
  try {
    const creator = await createCreator(session.workspace.id, { name: String(input?.name ?? ''), profiles, follow });
    if (!follow) return { creator };
    refresh();
    return { creator, ...(await followed(session, 'creator')) };
  } catch (err) {
    return failure(err);
  }
}

export async function followCreatorByIdAction(creatorId) {
  const session = await requireSession();
  const id = String(creatorId ?? '');
  try {
    await followCreator(session.workspace.id, id);
  } catch (err) {
    return failure(err);
  }
  refresh();
  const [creator, rest] = await Promise.all([getCreatorSummary(session.workspace.id, id), followed(session, 'creator')]);
  return { creator, ...rest };
}

// Subreddits and brands are followed by name.
export async function followByNameAction(kind, query) {
  const session = await requireSession();
  const topicKind = kind === 'community' ? 'community' : 'keyword';
  try {
    const { query: name } = await addTopic(session.workspace.id, { kind: topicKind, query: String(query ?? '') });
    refresh();
    return { name, ...(await followed(session, topicKind)) };
  } catch (err) {
    return failure(err);
  }
}
