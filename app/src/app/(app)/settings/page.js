import Link from 'next/link';
import { listMembers } from '../../../../lib/accounts.js';
import { fmtDay } from '../../../../lib/format.js';
import { GST_STATES } from '../../../../lib/india.js';
import { requireSession } from '../../../../lib/session.js';
import ActionForm from '../../components/action-form.js';
import { updateWorkspaceAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const session = await requireSession();
  const { workspace } = session;
  const members = await listMembers(workspace.id);

  return (
    <main className="apppage">
      <header className="pagehead">
        <h1>Settings</h1>
        <p className="dek">Your workspace, the details on your invoices, and who has access.</p>
      </header>

      <div className="addgrid">
        <section className="panel">
          <h2>Workspace and billing details</h2>
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
          <h2>Team</h2>
          <ul className="members">
            {members.map((m) => (
              <li key={m.email}>
                <b>{m.name ?? m.email}</b>
                <span className="pill">{m.role}</span>
                <span>{m.email}</span>
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
              <dt>Workspace since</dt>
              <dd>{fmtDay(workspace.createdAt)}</dd>
            </div>
          </dl>
          <p className="hint">Change your name, email, password or sign-in methods from the menu under your picture, top right.</p>
          <p className="hint">
            To close your account and delete its data, <Link href="/contact">contact us</Link>.
          </p>
        </section>
      </div>
    </main>
  );
}
