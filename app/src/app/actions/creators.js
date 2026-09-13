'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/session.js';
import { ExistingCreatorError, WatchlistError, createCreator, followCreator, getCreatorSummary, unfollowCreator } from '../../../lib/watchlist.js';

const OOPS = 'Something went wrong on our side. Try again in a minute.';

// The sidebar lists who you follow, so changes refresh the whole app layout.
const refresh = () => revalidatePath('/', 'layout');

// follow: false adds the creator without following them (onboarding saves picks at the end).
export async function createCreatorAction(input) {
  const session = await requireSession();
  const follow = input?.follow !== false;
  const profiles = Array.isArray(input?.profiles)
    ? input.profiles.slice(0, 10).map((p) => ({ platform: String(p?.platform ?? ''), input: String(p?.input ?? '') }))
    : [];
  try {
    const creator = await createCreator(session.workspace.id, { name: String(input?.name ?? ''), profiles, follow });
    if (follow) refresh();
    return { creator };
  } catch (err) {
    if (err instanceof ExistingCreatorError) return { error: err.message, existing: err.creator };
    if (err instanceof WatchlistError) return { error: err.message };
    console.error(err);
    return { error: OOPS };
  }
}

export async function followCreatorByIdAction(creatorId) {
  const session = await requireSession();
  const id = String(creatorId ?? '');
  try {
    await followCreator(session.workspace.id, id);
  } catch (err) {
    if (err instanceof WatchlistError) return { error: err.message };
    console.error(err);
    return { error: OOPS };
  }
  refresh();
  return { creator: await getCreatorSummary(session.workspace.id, id) };
}

export async function unfollowCreatorByIdAction(creatorId) {
  const session = await requireSession();
  await unfollowCreator(session.workspace.id, String(creatorId ?? ''));
  refresh();
  return { ok: true };
}
