'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '../../../lib/session.js';
import { toggleSaved } from '../../../lib/stories.js';

export async function toggleSaveAction(formData) {
  const session = await requireSession();
  const storyId = String(formData.get('storyId') ?? '');
  await toggleSaved(session.workspace.id, session.user.id, storyId);
  revalidatePath('/stories');
  revalidatePath(`/stories/${storyId}`);
}
