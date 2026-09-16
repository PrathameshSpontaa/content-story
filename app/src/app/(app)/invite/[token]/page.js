// Accepts a team invite. Signed in: joins the workspace and goes to the stories. Not signed in:
// a short page with a sign-in link that comes back here.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '../../../../../lib/session.js';
import { TeamError, acceptInvite, getInvite } from '../../../../../lib/team.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Join a workspace' };

export default async function InvitePage({ params }) {
  const { token } = await params;
  const invite = await getInvite(token);
  const session = await getSession();

  if (session && invite) {
    try {
      await acceptInvite({ token, userId: session.user.id, email: session.user.email });
    } catch (err) {
      if (!(err instanceof TeamError)) throw err;
      return <Problem title="This invite can’t be used" message={err.message} />;
    }
    redirect('/stories');
  }

  if (!invite) return <Problem title="This invite link isn’t valid" message="Ask the person who invited you to send a new one." />;

  const back = `/invite/${encodeURIComponent(token)}`;
  return (
    <div className="page">
      <header className="pagehead">
        <h1>Join {invite.workspace_name}</h1>
        <p>You’ve been invited as {invite.role === 'admin' ? 'an admin' : 'a member'}. Sign in with {invite.email} to accept.</p>
      </header>
      <p>
        <Link className="btn primary" href={`/sign-in?redirect_url=${encodeURIComponent(back)}`}>
          Sign in to accept
        </Link>
      </p>
    </div>
  );
}

function Problem({ title, message }) {
  return (
    <div className="page">
      <header className="pagehead">
        <h1>{title}</h1>
        <p>{message}</p>
      </header>
      <p>
        <Link className="btn ghost" href="/stories">
          Go to your stories
        </Link>
      </p>
    </div>
  );
}
