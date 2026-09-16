'use server';

// Admin server actions: credit grants, report updates and story review (approve, unpublish, reject, merge,
// keep separate). Every review decision made here is recorded as a person's (review_source 'human').
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { keepSeparate, mergeStory, rejectStory, setStoryPublished } from '../../../../lib/admin.js';
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

function refresh(storyId) {
  revalidatePath('/admin');
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath('/stories');
  revalidatePath(`/stories/${storyId}`);
}

// Quick publish or unpublish from the queue table.
export async function publishAction(formData) {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return;
  await setStoryPublished(id, formData.get('published') === 'true', { reviewerId: session.user.id });
  refresh(id);
}

// Approve, unpublish or reject one story, with an optional note; used by the review page's forms.
export async function reviewAction(_previous, formData) {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!UUID.test(id)) return { ok: false, message: 'Reload the page and try again.' };
  const by = { reviewerId: session.user.id, note };

  let ok = false;
  let message = '';
  if (decision === 'approve') {
    ok = await setStoryPublished(id, true, by);
    message = ok ? 'Published.' : 'Not published: it needs a version that passed every check, and can’t be a merged story.';
  } else if (decision === 'unpublish') {
    ok = await setStoryPublished(id, false, by);
    message = ok ? 'Unpublished.' : 'Nothing changed.';
  } else if (decision === 'reject') {
    ok = await rejectStory(id, by);
    message = ok ? 'Rejected. It stays out of the feed.' : 'Nothing changed.';
  } else {
    return { ok: false, message: 'Pick an action.' };
  }
  refresh(id);
  return { ok, message };
}

// Merge candidate buttons: merge either way, or keep the pair separate. Lands back on the review
// page with a short notice.
export async function mergeAction(formData) {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const otherId = String(formData.get('otherId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!UUID.test(id) || !UUID.test(otherId)) redirect('/admin');

  let notice = '';
  let landing = id;
  try {
    if (decision === 'merge_this_into_other') {
      await mergeStory(id, otherId, { reviewerId: session.user.id, note });
      notice = 'Merged. Its posts moved to the other story.';
      landing = otherId;
    } else if (decision === 'merge_other_into_this') {
      await mergeStory(otherId, id, { reviewerId: session.user.id, note });
      notice = 'Merged the other story into this one.';
    } else if (decision === 'keep_separate') {
      notice = (await keepSeparate(id, otherId)) ? 'Kept as two stories.' : 'Nothing to resolve.';
    } else {
      notice = 'Pick an action.';
    }
  } catch (err) {
    notice = err.message;
  }
  refresh(id);
  refresh(otherId);
  redirect(`/admin/stories/${landing}?notice=${encodeURIComponent(notice)}`);
}

// Quick reject from the queue table.
export async function rejectAction(formData) {
  const session = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) return;
  await rejectStory(id, { reviewerId: session.user.id });
  refresh(id);
}

// The "Unsure merges" tab: merge one story of a pair into the other, or keep both. Lands back on the
// tab with a short notice.
export async function pairAction(formData) {
  const session = await requireAdmin();
  const a = String(formData.get('a') ?? '');
  const b = String(formData.get('b') ?? '');
  const decision = String(formData.get('decision') ?? '');
  if (!UUID.test(a) || !UUID.test(b)) redirect('/admin?filter=pairs');

  let notice = '';
  try {
    if (decision === 'merge_a_into_b') {
      await mergeStory(a, b, { reviewerId: session.user.id });
      notice = 'Merged the first story into the second.';
    } else if (decision === 'merge_b_into_a') {
      await mergeStory(b, a, { reviewerId: session.user.id });
      notice = 'Merged the second story into the first.';
    } else if (decision === 'keep_separate') {
      notice = (await keepSeparate(a, b)) ? 'Kept as two stories.' : 'Nothing to resolve.';
    } else {
      notice = 'Pick an action.';
    }
  } catch (err) {
    notice = err.message;
  }
  refresh(a);
  refresh(b);
  redirect(`/admin?filter=pairs&notice=${encodeURIComponent(notice)}`);
}
