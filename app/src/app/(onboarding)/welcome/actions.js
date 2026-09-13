'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { skipOnboarding } from '../../../../lib/accounts.js';
import { requireSession } from '../../../../lib/session.js';
import { completeOnboarding } from '../../../../lib/watchlist.js';

const list = (value) => (Array.isArray(value) ? value.slice(0, 100).map(String) : []);

export async function finishOnboardingAction(payload) {
  const session = await requireSession();
  try {
    await completeOnboarding(session.workspace.id, {
      useCase: String(payload?.useCase ?? ''),
      creatorIds: list(payload?.creatorIds),
      communities: list(payload?.communities),
      keywords: list(payload?.keywords),
    });
  } catch (err) {
    console.error(err);
    return { error: 'We couldn’t save your picks. Try again in a minute.' };
  }
  revalidatePath('/', 'layout');
  redirect('/stories?welcome=1');
}

export async function skipOnboardingAction() {
  const session = await requireSession();
  await skipOnboarding(session.workspace.id);
  revalidatePath('/', 'layout');
  redirect('/stories?tab=all');
}
