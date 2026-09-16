'use server';

// Admin settings actions: save one section of operator settings, or start a full collection run now.
import { revalidatePath } from 'next/cache';
import { saveSettingsSection } from '../../../../../lib/admin.js';
import { requestFullRefresh } from '../../../../../lib/refresh.js';
import { requireAdmin } from '../../../../../lib/session.js';

const SAVED = { timing: 'Timing saved.', review: 'AI review saved.', on_demand: 'On-demand refresh saved.' };

async function save(section, formData) {
  const session = await requireAdmin();
  try {
    await saveSettingsSection(section, formData, { userId: session.user.id });
  } catch (err) {
    // Database errors carry a code; bad values are plain messages meant for the form.
    if (err?.code) throw err;
    return { ok: false, message: err.message };
  }
  revalidatePath('/admin/settings');
  revalidatePath('/admin');
  revalidatePath('/stories');
  return { ok: true, message: `${SAVED[section]} Changes apply within a minute while the worker is running.` };
}

export async function saveTimingAction(_previous, formData) {
  return save('timing', formData);
}

export async function saveReviewAction(_previous, formData) {
  return save('review', formData);
}

export async function saveOnDemandAction(_previous, formData) {
  return save('on_demand', formData);
}

export async function runCollectionAction() {
  const session = await requireAdmin();
  const result = await requestFullRefresh({ userId: session.user.id });
  revalidatePath('/admin/settings');
  revalidatePath('/admin/runs');
  return { ok: Boolean(result.ok), message: result.message };
}
