'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../../lib/session.js';
import { CREATOR_PLATFORMS, WatchlistError, addCreator, addTopic, removeTarget, setTargetActive } from '../../../../lib/watchlist.js';

const UUID = /^[0-9a-f-]{36}$/i;

function failure(err) {
  if (err instanceof WatchlistError) return { ok: false, message: err.message };
  console.error(err);
  return { ok: false, message: 'Something went wrong on our side. Try again in a minute.' };
}

export async function addCreatorAction(_previous, formData) {
  const session = await requireSession();
  try {
    const handles = Object.fromEntries(CREATOR_PLATFORMS.map((p) => [p, formData.get(p)]));
    const { creatorName, matchedExisting } = await addCreator(session.workspace.id, { name: formData.get('name'), handles });
    revalidatePath('/watchlist');
    revalidatePath('/feed');
    return {
      ok: true,
      message: matchedExisting ? `Added ${creatorName}. We already collect them, so their stories are in your feed now.` : `Added ${creatorName}.`,
    };
  } catch (err) {
    return failure(err);
  }
}

export async function addTopicAction(_previous, formData) {
  const session = await requireSession();
  try {
    const { query } = await addTopic(session.workspace.id, {
      kind: formData.get('kind'),
      query: formData.get('query'),
      platforms: formData.getAll('platforms'),
    });
    revalidatePath('/watchlist');
    revalidatePath('/feed');
    return { ok: true, message: `Added ${query}.` };
  } catch (err) {
    return failure(err);
  }
}

export async function setActiveAction(formData) {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return;
  try {
    await setTargetActive(session.workspace.id, id, formData.get('active') === 'true');
  } catch (err) {
    if (!(err instanceof WatchlistError)) throw err;
    // Resuming past the plan limit does nothing; the limit is shown on the page.
  }
  revalidatePath('/watchlist');
  revalidatePath('/feed');
}

export async function removeAction(formData) {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return;
  await removeTarget(session.workspace.id, id);
  revalidatePath('/watchlist');
  revalidatePath('/feed');
}
