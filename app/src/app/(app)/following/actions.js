'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../../lib/session.js';
import { WatchlistError, addTopic, followCreator, removeTarget } from '../../../../lib/watchlist.js';

const UUID = /^[0-9a-f-]{36}$/i;

// The sidebar lists who you follow, so every change refreshes the whole app layout.
const refresh = () => revalidatePath('/', 'layout');

function failure(err) {
  if (err instanceof WatchlistError) return { ok: false, message: err.message };
  console.error(err);
  return { ok: false, message: 'Something went wrong on our side. Try again in a minute.' };
}

// One-tap buttons: limits are shown on the page, so a refused follow just leaves the button as it was.
export async function followCreatorAction(formData) {
  const session = await requireSession();
  try {
    await followCreator(session.workspace.id, String(formData.get('creatorId') ?? ''));
  } catch (err) {
    if (!(err instanceof WatchlistError)) throw err;
  }
  refresh();
}

export async function followTopicAction(formData) {
  const session = await requireSession();
  const kind = formData.get('kind') === 'community' ? 'community' : 'keyword';
  try {
    await addTopic(session.workspace.id, { kind, query: formData.get('query') });
  } catch (err) {
    if (!(err instanceof WatchlistError)) throw err;
  }
  refresh();
}

export async function unfollowAction(formData) {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (UUID.test(id)) await removeTarget(session.workspace.id, id);
  refresh();
}

export async function addTopicAction(_previous, formData) {
  const session = await requireSession();
  const kind = formData.get('kind') === 'community' ? 'community' : 'keyword';
  try {
    const { query } = await addTopic(session.workspace.id, { kind, query: formData.get('query') });
    refresh();
    return { ok: true, message: `Following ${query}.` };
  } catch (err) {
    return failure(err);
  }
}
