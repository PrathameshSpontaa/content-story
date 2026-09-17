'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../../lib/session.js';
import { WatchlistError } from '../../../../lib/profiles.js';
import { createWatchlist, deleteWatchlist, getWatchlist, removeTag, renameWatchlist, saveTag, setWatchlistTargets } from '../../../../lib/watchlists.js';
import { chooseWatchlist } from '../../watchlist-choice.js';

const OOPS = 'Something went wrong on our side. Try again in a minute.';
const text = (formData, key) => String(formData.get(key) ?? '');

// The sidebar lists the watchlists and the Stories page their tags, so changes refresh the whole app.
const refresh = () => revalidatePath('/', 'layout');

function failure(err) {
  if (err instanceof WatchlistError) return { ok: false, message: err.message };
  console.error(err);
  return { ok: false, message: OOPS };
}

export async function createWatchlistAction(_prev, formData) {
  const session = await requireSession();
  let created;
  try {
    created = await createWatchlist(session.workspace.id, { name: text(formData, 'name'), userId: session.user.id });
  } catch (err) {
    return failure(err);
  }
  refresh();
  redirect(`/watchlists/${created.id}`);
}

export async function renameWatchlistAction(_prev, formData) {
  const session = await requireSession();
  try {
    const { name } = await renameWatchlist(session.workspace.id, text(formData, 'watchlistId'), text(formData, 'name'));
    refresh();
    return { ok: true, message: `Renamed to ${name}.` };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteWatchlistAction(formData) {
  const session = await requireSession();
  try {
    await deleteWatchlist(session.workspace.id, text(formData, 'watchlistId'));
  } catch (err) {
    if (!(err instanceof WatchlistError)) throw err;
  }
  refresh();
  redirect('/watchlists');
}

// Adds a tag written from scratch, or saves changes to one (`id`).
export async function saveTagAction(_prev, formData) {
  const session = await requireSession();
  try {
    const id = text(formData, 'id');
    const tag = await saveTag(session.workspace.id, text(formData, 'watchlistId'), {
      id: id || null,
      name: text(formData, 'name'),
      rule: text(formData, 'rule'),
      minSources: text(formData, 'minSources'),
    });
    refresh();
    return { ok: true, message: id ? `Saved ${tag.name}. It applies from the next refresh.` : `Added ${tag.name}. It applies from the next refresh.` };
  } catch (err) {
    return failure(err);
  }
}

export async function addTemplateTagAction(formData) {
  const session = await requireSession();
  const watchlistId = text(formData, 'watchlistId');
  try {
    await saveTag(session.workspace.id, watchlistId, { template: text(formData, 'template') });
  } catch (err) {
    if (!(err instanceof WatchlistError)) throw err;
  }
  refresh();
}

export async function removeTagAction(formData) {
  const session = await requireSession();
  await removeTag(session.workspace.id, text(formData, 'watchlistId'), text(formData, 'tagId'));
  refresh();
}

// Who's in a watchlist, from its ticked boxes. Someone unticked who is in no other watchlist is unfollowed.
export async function saveWatchlistFollowsAction(_prev, formData) {
  const session = await requireSession();
  try {
    const result = await setWatchlistTargets(session.workspace.id, text(formData, 'watchlistId'), formData.getAll('targetId').map(String));
    refresh();
    const parts = [
      result.added ? `${result.added} added` : null,
      result.removed ? `${result.removed} taken out` : null,
      result.unfollowed ? `${result.unfollowed} unfollowed, as they were in no other watchlist` : null,
    ].filter(Boolean);
    return { ok: true, message: parts.length ? `Saved: ${parts.join(', ')}.` : 'Nothing changed.' };
  } catch (err) {
    return failure(err);
  }
}

// The watchlist the Following page puts new follows into.
export async function chooseWatchlistAction(watchlistId) {
  const session = await requireSession();
  const watchlist = await getWatchlist(session.workspace.id, String(watchlistId ?? ''));
  if (!watchlist) return { error: 'That watchlist is gone. Reload the page.' };
  await chooseWatchlist(watchlist.id);
  return { ok: true };
}

// "Follow someone new" from a watchlist: the Following page opens with that watchlist picked.
export async function followIntoWatchlistAction(formData) {
  const session = await requireSession();
  const watchlist = await getWatchlist(session.workspace.id, text(formData, 'watchlistId'));
  if (watchlist) await chooseWatchlist(watchlist.id);
  redirect('/following');
}
