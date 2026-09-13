'use server';

import { revalidatePath } from 'next/cache';
import { updateWorkspace } from '../../../../lib/accounts.js';
import { GSTIN_PATTERN, GST_STATES } from '../../../../lib/india.js';
import { requireSession } from '../../../../lib/session.js';

export async function updateWorkspaceAction(_previous, formData) {
  const session = await requireSession();
  if (!['owner', 'admin'].includes(session.role)) return { ok: false, message: 'Only workspace owners and admins can change these details.' };

  const name = String(formData.get('name') ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) return { ok: false, message: 'The workspace name needs 2 to 80 characters.' };
  const gstin = String(formData.get('gstin') ?? '').trim().toUpperCase();
  if (gstin && !GSTIN_PATTERN.test(gstin)) return { ok: false, message: 'That GSTIN doesn’t look right. It has 15 characters, like 27AAPFU0939F1ZV.' };
  const billingState = String(formData.get('billingState') ?? '');
  if (billingState && !GST_STATES.some(([code]) => code === billingState)) return { ok: false, message: 'Choose a state from the list.' };
  if (gstin && billingState && gstin.slice(0, 2) !== billingState) return { ok: false, message: 'The first two digits of a GSTIN are its state code. They don’t match the state you chose.' };

  await updateWorkspace(session.workspace.id, { name, gstin, billingState });
  revalidatePath('/settings');
  return { ok: true, message: 'Saved.' };
}
