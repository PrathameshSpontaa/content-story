import { SignUp } from '@clerk/nextjs';
import { fmtNum } from '../../../../../lib/format.js';
import { TRIAL } from '../../../../../lib/pricing.js';

export const metadata = { title: 'Start free' };

export default function SignUpPage() {
  return (
    <main className="authpage">
      <div className="authcopy">
        <p className="kicker">Free trial · no card needed</p>
        <h1>Your first stories in about a minute.</h1>
        <ul className="ticks">
          <li>Pick creators, subreddits and brands to follow</li>
          <li>Every story in this week’s AI and tech feed</li>
          <li>{fmtNum(TRIAL.credits)} free credits, enough for a story report</li>
        </ul>
      </div>
      <SignUp />
    </main>
  );
}
