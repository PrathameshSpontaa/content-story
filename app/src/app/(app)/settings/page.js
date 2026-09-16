import Link from 'next/link';
import { getPlanState } from '../../../../lib/accounts.js';
import { getAlertSettings } from '../../../../lib/alerts.js';
import { USE_CASES } from '../../../../lib/catalog.js';
import { getDigestSettings } from '../../../../lib/digests.js';
import { fmtDay } from '../../../../lib/format.js';
import { GST_STATES } from '../../../../lib/india.js';
import { requireSession } from '../../../../lib/session.js';
import { listInvites, listMembers } from '../../../../lib/team.js';
import ActionForm from '../../components/action-form.js';
import Avatar from '../../components/avatar.js';
import { cancelInviteAction, changeRoleAction, inviteAction, removeMemberAction, saveAlertsAction, saveDigestAction, updateWorkspaceAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const session = await requireSession();
  const { workspace } = session;
  const [members, invites, alerts, digest, plan] = await Promise.all([
    listMembers(workspace.id),
    listInvites(workspace.id),
    getAlertSettings(workspace.id),
    getDigestSettings(workspace.id),
    getPlanState(workspace.id),
  ]);
  const useCase = USE_CASES.find((u) => u.id === workspace.useCase);
  const canEdit = ['owner', 'admin'].includes(session.role);
  const isOwner = session.role === 'owner';
  const seatsUsed = members.length + invites.length;

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Settings</h1>
        <p>Your workspace, the details on your invoices, what we email you, and who has access.</p>
      </header>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <h2>Workspace and invoice details</h2>
            <ActionForm action={updateWorkspaceAction} submitLabel="Save changes" resetOnSuccess={false}>
              <label className="field">
                <span>Workspace name</span>
                <input name="name" defaultValue={workspace.name} required minLength={2} maxLength={80} />
              </label>
              <label className="field">
                <span>
                  GSTIN <small>optional, for business invoices</small>
                </span>
                <input name="gstin" defaultValue={workspace.gstin ?? ''} placeholder="27AAPFU0939F1ZV" maxLength={15} spellCheck={false} autoComplete="off" />
              </label>
              <label className="field">
                <span>State for GST</span>
                <select name="billingState" defaultValue={workspace.billingState ?? ''}>
                  <option value="">Choose a state</option>
                  {GST_STATES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>
          </section>

          <section className="panel">
            <h2>Alerts</h2>
            <p className="muted-note">An email when a story involving someone you follow gets hot. 2 credits per alert.</p>
            <ActionForm action={saveAlertsAction} submitLabel="Save alerts" resetOnSuccess={false} className="topgap">
              <label className="check">
                <input type="checkbox" name="active" defaultChecked={alerts.active} disabled={!canEdit} />
                <span>Send me alerts</span>
              </label>
              <div className="field-row">
                <label className="field">
                  <span>
                    Minimum heat <small>0 to 100</small>
                  </span>
                  <input type="number" name="minHeat" min={0} max={100} step={1} defaultValue={alerts.minHeat} disabled={!canEdit} required />
                </label>
                <label className="field">
                  <span>Send to</span>
                  <input type="email" name="destination" defaultValue={alerts.destination} disabled={!canEdit} required />
                </label>
              </div>
            </ActionForm>
          </section>

          <section className="panel">
            <h2>Digest</h2>
            <p className="muted-note">The top stories for you, by email. Daily digests go out each morning (IST), weekly ones on Monday. 5 credits per digest.</p>
            <ActionForm action={saveDigestAction} submitLabel="Save digest" resetOnSuccess={false} className="topgap">
              <div className="field-row">
                <label className="field">
                  <span>How often</span>
                  <select name="frequency" defaultValue={digest.frequency} disabled={!canEdit}>
                    <option value="off">Off</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </label>
                <label className="field">
                  <span>Send to</span>
                  <input type="email" name="destination" defaultValue={digest.destination} disabled={!canEdit} required />
                </label>
              </div>
              {digest.lastSentOn ? <p className="hint">Last sent {fmtDay(digest.lastSentOn)}.</p> : null}
            </ActionForm>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2>Team</h2>
            <ul className="members">
              {members.map((m) => (
                <li key={m.user_id}>
                  <Avatar name={m.name ?? m.email} size="sm" />
                  <span className="member-name">
                    <b>{m.name ?? m.email}</b>
                    <span>{m.email}</span>
                  </span>
                  {isOwner && m.user_id !== session.user.id ? (
                    <span className="member-tools">
                      <ActionForm action={changeRoleAction} submitLabel="Change" pendingLabel="…" variant="ghost sm" resetOnSuccess={false}>
                        <input type="hidden" name="userId" value={m.user_id} />
                        <select name="role" defaultValue={m.role} aria-label={`Role for ${m.email}`}>
                          <option value="owner">Owner</option>
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                        </select>
                      </ActionForm>
                      <ActionForm action={removeMemberAction} submitLabel="Remove" pendingLabel="…" variant="ghost sm danger">
                        <input type="hidden" name="userId" value={m.user_id} />
                      </ActionForm>
                    </span>
                  ) : (
                    <span className="pill">{m.role}</span>
                  )}
                </li>
              ))}
              {invites.map((i) => (
                <li key={i.id}>
                  <Avatar name={i.email} size="sm" />
                  <span className="member-name">
                    <b>{i.email}</b>
                    <span>
                      Invited as {i.role} · link works until {fmtDay(i.expires_at)}
                    </span>
                  </span>
                  {canEdit ? (
                    <ActionForm action={cancelInviteAction} submitLabel="Cancel" pendingLabel="…" variant="ghost sm">
                      <input type="hidden" name="inviteId" value={i.id} />
                    </ActionForm>
                  ) : (
                    <span className="pill">invited</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="hint">
              {seatsUsed} of {plan.seats} {plan.seats === 1 ? 'seat' : 'seats'} on the {plan.name}
              {plan.status === 'trial' ? '' : ' plan'}.
              {plan.status === 'trial' ? (
                <>
                  {' '}
                  Inviting teammates comes with the Pro and Agency plans. <Link href="/billing">See plans</Link>
                </>
              ) : null}
            </p>
            {canEdit ? (
              <ActionForm action={inviteAction} submitLabel="Send invite" pendingLabel="Sending…" className="topgap">
                <div className="field-row">
                  <label className="field">
                    <span>Invite by email</span>
                    <input type="email" name="email" placeholder="name@company.com" required />
                  </label>
                  <label className="field">
                    <span>Role</span>
                    <select name="role" defaultValue="member">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                </div>
              </ActionForm>
            ) : null}
          </section>

          <section className="panel">
            <h2>Your account</h2>
            <dl className="details">
              <div className="details-row">
                <dt>Signed in as</dt>
                <dd>{session.user.email}</dd>
              </div>
              <div className="details-row">
                <dt>Your role</dt>
                <dd>{session.role}</dd>
              </div>
              <div className="details-row">
                <dt>Using it for</dt>
                <dd>
                  {useCase ? useCase.label : 'Not set'} · <Link href="/welcome">Run setup again</Link>
                </dd>
              </div>
              <div className="details-row">
                <dt>Member since</dt>
                <dd>{fmtDay(workspace.createdAt)}</dd>
              </div>
            </dl>
            <p className="hint">Change your name, email or sign-in methods from your picture at the top of the menu.</p>
            <p className="hint">
              To close your account and delete its data, <Link href="/contact">contact us</Link>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
