import { SignUp } from '@clerk/nextjs';
import { fmtNum } from '../../../../../lib/format.js';
import { TRIAL } from '../../../../../lib/pricing.js';

export const metadata = { title: 'Start free' };

export default function SignUpPage() {
  return (
    <main className="authpage">
      <div className="authcopy">
        <p className="eyebrow">Free trial · no card needed</p>
        <h1>Start with {fmtNum(TRIAL.credits)} free credits.</h1>
        <ul className="ticks">
          <li>Every story in the shared AI &amp; tech feed</li>
          <li>A watchlist of up to {TRIAL.maxSources} creators or communities</li>
          <li>Enough credits for an on-demand story report</li>
        </ul>
      </div>
      <SignUp />
    </main>
  );
}
