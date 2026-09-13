import Link from 'next/link';
import { listMembers } from '../../../../lib/accounts.js';
import { USE_CASES } from '../../../../lib/catalog.js';
import { fmtDay } from '../../../../lib/format.js';
import { GST_STATES } from '../../../../lib/india.js';
import { requireSession } from '../../../../lib/session.js';
import ActionForm from '../../components/action-form.js';
import Avatar from '../../components/avatar.js';
import { updateWorkspaceAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const session = await requireSession();
  const { workspace } = session;
  const members = await listMembers(workspace.id);
  const useCase = USE_CASES.find((u) => u.id === workspace.useCase);

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Settings</h1>
        <p>Your workspace, the details on your invoices, and who has access.</p>
      </header>

      <div className="split">
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

        <div className="stack">
          <section className="panel">
            <h2>Team</h2>
            <ul className="members">
              {members.map((m) => (
                <li key={m.email}>
                  <Avatar name={m.name ?? m.email} size="sm" />
                  <span className="member-name">
                    <b>{m.name ?? m.email}</b>
                    <span>{m.email}</span>
                  </span>
                  <span className="pill">{m.role}</span>
                </li>
              ))}
            </ul>
            <p className="hint">Inviting teammates comes with the Pro and Agency plans at paid launch.</p>
          </section>

          <section className="panel">
            <h2>Your account</h2>
            <dl className="details">
              <div className="details-row">
                <dt>Signed in as</dt>
                <dd>{session.user.email}</dd>
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
