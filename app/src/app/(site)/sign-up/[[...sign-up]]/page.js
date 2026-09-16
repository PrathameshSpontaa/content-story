import { SignUp } from '@clerk/nextjs';
import { fmtNum } from '../../../../../lib/format.js';
import { REFERRAL, TRIAL } from '../../../../../lib/pricing.js';
import { lookupCode } from '../../../../../lib/referrals.js';
import { referralCodeFromCookie } from '../../../../../lib/session.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Start free' };

export default async function SignUpPage() {
  // Someone who arrived through a friend's /r/CODE link sees the bonus they'll start with.
  const code = await referralCodeFromCookie();
  const referrer = code ? await lookupCode(code) : null;
  const credits = TRIAL.credits + (referrer ? REFERRAL.friendCredits : 0);

  return (
    <main className="authpage">
      <div className="authcopy">
        <p className="kicker">{referrer ? `Invited by ${referrer.owner_name ?? referrer.workspace_name} · ${fmtNum(REFERRAL.friendCredits)} bonus credits` : 'Free trial · no card needed'}</p>
        <h1>Your first stories in about a minute.</h1>
        <ul className="ticks">
          <li>Pick creators, subreddits and brands to follow</li>
          <li>Every story in this week’s AI and tech feed</li>
          <li>
            {fmtNum(credits)} free credits{referrer ? ` (${fmtNum(TRIAL.credits)} trial + ${fmtNum(REFERRAL.friendCredits)} from your invite)` : ', enough for a story report'}
          </li>
        </ul>
      </div>
      <SignUp />
    </main>
  );
}
