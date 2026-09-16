// Team: who is in a workspace, invites by email (within the plan's seats), roles, and removal.
// Only owners change roles or remove people, and a workspace always keeps at least one owner.
import { randomBytes } from 'node:crypto';
import { getPlanState } from './accounts.js';
import { pool, tx } from './db.js';
import { APP_URL, emailLayout, escapeHtml, sendEmail } from './notify.js';

// A problem the person can act on; its message is safe to show.
export class TeamError extends Error {}

export const ROLES = ['owner', 'admin', 'member'];
const INVITE_DAYS = 7;
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(String(s));

export async function listMembers(workspaceId) {
  const { rows } = await pool.query(
    `select u.id as user_id, u.email, u.name, m.role
       from memberships m join users u on u.id = m.user_id
      where m.workspace_id = $1
      order by array_position(array['owner', 'admin', 'member']::text[], m.role::text), u.email`,
    [workspaceId],
  );
  return rows;
}

export async function listInvites(workspaceId) {
  const { rows } = await pool.query(
    `select id, email, role, expires_at, created_at from invites
      where workspace_id = $1 and accepted_at is null and expires_at > now() order by created_at`,
    [workspaceId],
  );
  return rows;
}

// Seats in use: members plus invites still open.
async function seatsUsed(client, workspaceId) {
  const { rows } = await client.query(
    `select (select count(*) from memberships where workspace_id = $1)::int
          + (select count(*) from invites where workspace_id = $1 and accepted_at is null and expires_at > now())::int as used`,
    [workspaceId],
  );
  return rows[0].used;
}

function inviteEmail({ workspaceName, inviterName, role, token }) {
  const link = `${APP_URL()}/invite/${token}`;
  const title = `${inviterName} invited you to ${workspaceName}`;
  const html = emailLayout(
    title,
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">You’ve been invited to join ${escapeHtml(workspaceName)} on Content-Story as ${role === 'admin' ? 'an admin' : 'a member'}. The link works for ${INVITE_DAYS} days.</p>
     <p style="margin:16px 0 0"><a href="${link}" style="display:inline-block;padding:10px 16px;background:#1c1b18;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Accept the invite</a></p>
     <p style="margin:12px 0 0;font-size:13px;color:#6b675d">Sign in with this email address to accept it.</p>`,
  );
  const text = `${title}\n\nAccept the invite (valid ${INVITE_DAYS} days, sign in with this email address):\n${link}`;
  return { subject: title, html, text };
}

export async function createInvite({ workspaceId, email, role = 'member', invitedBy = null, log = console.log }) {
  const to = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new TeamError('Enter the email address to invite.');
  if (!['admin', 'member'].includes(role)) throw new TeamError('Invite people as an admin or a member.');

  const plan = await getPlanState(workspaceId);
  const invite = await tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    const member = await client.query(
      'select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and lower(u.email) = $2',
      [workspaceId, to],
    );
    if (member.rowCount) throw new TeamError(`${to} is already in this workspace.`);
    // A fresh invite replaces an open one for the same address.
    await client.query('delete from invites where workspace_id = $1 and lower(email) = $2 and accepted_at is null', [workspaceId, to]);
    const used = await seatsUsed(client, workspaceId);
    if (used >= plan.seats) {
      if (plan.status === 'trial') throw new TeamError('The free trial has one seat. Inviting teammates comes with the Pro and Agency plans.');
      throw new TeamError(`The ${plan.name} plan includes ${plan.seats} seats and all of them are taken (members and open invites). Remove someone or move to a bigger plan.`);
    }
    const token = randomBytes(16).toString('hex');
    const { rows } = await client.query(
      `insert into invites (workspace_id, email, role, token, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, token, expires_at`,
      [workspaceId, to, role, token, invitedBy, INVITE_DAYS],
    );
    return rows[0];
  });

  const { rows: ctx } = await pool.query(
    `select w.name as workspace_name, coalesce(u.name, u.email, 'A teammate') as inviter
       from workspaces w left join users u on u.id = $2 where w.id = $1`,
    [workspaceId, invitedBy],
  );
  const email_ = inviteEmail({ workspaceName: ctx[0]?.workspace_name ?? 'a workspace', inviterName: ctx[0]?.inviter ?? 'A teammate', role, token: invite.token });
  await sendEmail({ ...email_, to, workspaceId, kind: 'invite', note: `invite ${invite.id}`, log });
  return { id: invite.id, token: invite.token, expiresAt: invite.expires_at, email: to, role };
}

export async function getInvite(token) {
  if (!/^[0-9a-f]{32}$/.test(String(token))) return null;
  const { rows } = await pool.query(
    `select i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, w.name as workspace_name
       from invites i join workspaces w on w.id = i.workspace_id where i.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

// Adds the signed-in person to the workspace. Returns the workspace id.
export async function acceptInvite({ token, userId, email }) {
  const invite = await getInvite(token);
  if (!invite) throw new TeamError('This invite link isn’t valid.');
  if (invite.accepted_at) throw new TeamError('This invite has already been used.');
  if (new Date(invite.expires_at) < new Date()) throw new TeamError('This invite has expired. Ask for a new one.');
  if (String(invite.email).toLowerCase() !== String(email ?? '').trim().toLowerCase()) {
    throw new TeamError(`This invite was sent to ${invite.email}. Sign in with that address to accept it.`);
  }
  await tx(async (client) => {
    await client.query('insert into memberships (workspace_id, user_id, role) values ($1, $2, $3) on conflict (workspace_id, user_id) do nothing', [invite.workspace_id, userId, invite.role]);
    await client.query('update invites set accepted_at = now() where id = $1', [invite.id]);
  });
  return invite.workspace_id;
}

export async function cancelInvite({ workspaceId, inviteId }) {
  if (!isUuid(inviteId)) return false;
  const { rowCount } = await pool.query('delete from invites where workspace_id = $1 and id = $2 and accepted_at is null', [workspaceId, inviteId]);
  return rowCount === 1;
}

async function requireOwner(client, workspaceId, actorId) {
  const { rows } = await client.query('select role from memberships where workspace_id = $1 and user_id = $2', [workspaceId, actorId]);
  if (rows[0]?.role !== 'owner') throw new TeamError('Only workspace owners can do this.');
}

async function ownerCount(client, workspaceId) {
  const { rows } = await client.query(`select count(*)::int as n from memberships where workspace_id = $1 and role = 'owner'`, [workspaceId]);
  return rows[0].n;
}

export async function changeRole({ workspaceId, actorId, userId, role }) {
  if (!ROLES.includes(role)) throw new TeamError('Choose owner, admin or member.');
  if (!isUuid(userId)) throw new TeamError('That person isn’t in this workspace.');
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await requireOwner(client, workspaceId, actorId);
    const { rows } = await client.query('select role from memberships where workspace_id = $1 and user_id = $2', [workspaceId, userId]);
    if (!rows[0]) throw new TeamError('That person isn’t in this workspace.');
    if (rows[0].role === role) return false;
    if (rows[0].role === 'owner' && (await ownerCount(client, workspaceId)) === 1) throw new TeamError('A workspace needs at least one owner. Make someone else an owner first.');
    await client.query('update memberships set role = $3 where workspace_id = $1 and user_id = $2', [workspaceId, userId, role]);
    return true;
  });
}

export async function removeMember({ workspaceId, actorId, userId }) {
  if (!isUuid(userId)) throw new TeamError('That person isn’t in this workspace.');
  return tx(async (client) => {
    await client.query('select 1 from workspaces where id = $1 for update', [workspaceId]);
    await requireOwner(client, workspaceId, actorId);
    const { rows } = await client.query('select role from memberships where workspace_id = $1 and user_id = $2', [workspaceId, userId]);
    if (!rows[0]) throw new TeamError('That person isn’t in this workspace.');
    if (rows[0].role === 'owner' && (await ownerCount(client, workspaceId)) === 1) throw new TeamError('A workspace needs at least one owner. Make someone else an owner first.');
    await client.query('delete from memberships where workspace_id = $1 and user_id = $2', [workspaceId, userId]);
    return true;
  });
}
