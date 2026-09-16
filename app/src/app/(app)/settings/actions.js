'use server';

import { revalidatePath } from 'next/cache';
import { updateWorkspace } from '../../../../lib/accounts.js';
import { saveAlertSettings } from '../../../../lib/alerts.js';
import { FREQUENCIES, saveDigestSettings } from '../../../../lib/digests.js';
import { GSTIN_PATTERN, GST_STATES } from '../../../../lib/india.js';
import { requireSession } from '../../../../lib/session.js';
import { TeamError, cancelInvite, changeRole, createInvite, removeMember } from '../../../../lib/team.js';

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

// Runs fn and turns a problem the person can act on into the form's message.
async function attempt(fn, done = 'Saved.') {
  try {
    await fn();
    revalidatePath('/settings');
    return { ok: true, message: done };
  } catch (err) {
    if (err instanceof TeamError || /^Enter |^Choose /.test(err.message)) return { ok: false, message: err.message };
    throw err;
  }
}

export async function saveAlertsAction(_previous, formData) {
  const session = await requireSession();
  if (!['owner', 'admin'].includes(session.role)) return { ok: false, message: 'Only workspace owners and admins can change alerts.' };
  return attempt(() =>
    saveAlertSettings(session.workspace.id, {
      active: formData.get('active') === 'on',
      minHeat: formData.get('minHeat'),
      destination: formData.get('destination'),
    }),
  );
}

export async function saveDigestAction(_previous, formData) {
  const session = await requireSession();
  if (!['owner', 'admin'].includes(session.role)) return { ok: false, message: 'Only workspace owners and admins can change the digest.' };
  const frequency = String(formData.get('frequency') ?? 'off');
  if (!FREQUENCIES.includes(frequency)) return { ok: false, message: 'Choose off, daily or weekly.' };
  return attempt(() => saveDigestSettings(session.workspace.id, { frequency, destination: formData.get('destination') }));
}

export async function inviteAction(_previous, formData) {
  const session = await requireSession();
  if (!['owner', 'admin'].includes(session.role)) return { ok: false, message: 'Only workspace owners and admins can invite people.' };
  const email = String(formData.get('email') ?? '').trim();
  return attempt(
    () => createInvite({ workspaceId: session.workspace.id, email, role: String(formData.get('role') ?? 'member'), invitedBy: session.user.id }),
    `Invite sent to ${email.toLowerCase()}.`,
  );
}

export async function cancelInviteAction(_previous, formData) {
  const session = await requireSession();
  if (!['owner', 'admin'].includes(session.role)) return { ok: false, message: 'Only workspace owners and admins can cancel invites.' };
  return attempt(() => cancelInvite({ workspaceId: session.workspace.id, inviteId: String(formData.get('inviteId') ?? '') }), 'Invite cancelled.');
}

export async function changeRoleAction(_previous, formData) {
  const session = await requireSession();
  return attempt(
    () => changeRole({ workspaceId: session.workspace.id, actorId: session.user.id, userId: String(formData.get('userId') ?? ''), role: String(formData.get('role') ?? '') }),
    'Role changed.',
  );
}

export async function removeMemberAction(_previous, formData) {
  const session = await requireSession();
  return attempt(() => removeMember({ workspaceId: session.workspace.id, actorId: session.user.id, userId: String(formData.get('userId') ?? '') }), 'Removed.');
}
