import { SignIn } from '@clerk/nextjs';

export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="authpage">
      <div className="authcopy">
        <p className="eyebrow">Welcome back</p>
        <h1>Pick up where the story left off.</h1>
        <p className="dek">Your feed, watchlist, saved stories and reports are waiting.</p>
      </div>
      <SignIn />
    </main>
  );
}
