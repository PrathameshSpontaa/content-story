'use server';

import { revalidatePath } from 'next/cache';
import { setStoryPublished } from '../../../../lib/admin.js';
import { addCredits } from '../../../../lib/credits.js';
import { ReportError, updateReport } from '../../../../lib/reports.js';
import { requireAdmin } from '../../../../lib/session.js';

const UUID = /^[0-9a-f-]{36}$/i;

export async function grantCreditsAction(_previous, formData) {
  const session = await requireAdmin();
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const nonce = String(formData.get('nonce') ?? '');
  const amount = Number(formData.get('amount'));
  if (!UUID.test(workspaceId) || !UUID.test(nonce)) return { ok: false, message: 'Reload the page and try again.' };
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) return { ok: false, message: 'Enter whole credits, 1 to 100,000.' };
  const note = String(formData.get('note') ?? '').trim().slice(0, 120) || 'Added by the Content-Story team';

  // The nonce is rendered with the form, so a double-submitted form grants once.
  const result = await addCredits(workspaceId, amount, { kind: 'grant', reference: `admin:${session.user.email}`, idempotencyKey: `admin-grant:${nonce}`, note });
  revalidatePath('/admin');
  return { ok: true, message: result.applied ? `Added ${amount.toLocaleString('en-IN')}.` : 'Already added.' };
}

export async function updateReportAction(_previous, formData) {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return { ok: false, message: 'Reload the page and try again.' };
  try {
    await updateReport(id, {
      status: formData.get('status'),
      storyId: String(formData.get('storyId') ?? ''),
      usedCredits: String(formData.get('usedCredits') ?? ''),
      note: String(formData.get('note') ?? '').trim().slice(0, 300),
    });
  } catch (err) {
    if (err instanceof ReportError) return { ok: false, message: err.message };
    throw err;
  }
  revalidatePath('/admin');
  return { ok: true, message: 'Report updated.' };
}

export async function publishAction(formData) {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return;
  await setStoryPublished(id, formData.get('published') === 'true');
  revalidatePath('/admin');
  revalidatePath('/feed');
}
