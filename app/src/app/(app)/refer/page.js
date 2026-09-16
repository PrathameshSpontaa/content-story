import { fmtDay, fmtNum, plural } from '../../../../lib/format.js';
import { REFERRAL, TRIAL } from '../../../../lib/pricing.js';
import { getReferralSummary } from '../../../../lib/referrals.js';
import { requireSession } from '../../../../lib/session.js';
import CopyButton from '../../components/copy-button.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Refer and earn' };

const STATUS_LABEL = {
  joined: 'Signed up · setting up',
  rewarded: 'Rewarded',
  capped: 'Joined · reward limit reached',
};

export default async function ReferPage() {
  const session = await requireSession();
  const summary = await getReferralSummary(session.workspace.id);
  const friendTotal = TRIAL.credits + REFERRAL.friendCredits;
  const message = `I use Content-Story to follow what creators, brands and communities are saying about AI and tech, told as stories. Sign up with my link and you start with ${fmtNum(friendTotal)} free credits: ${summary.link}`;

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Refer a friend, earn credits</h1>
        <p>
          Friends who sign up through your link start with {fmtNum(REFERRAL.friendCredits)} bonus credits on top of the free trial. Once they have set up their stories, you get{' '}
          {fmtNum(REFERRAL.referrerCredits)} credits.
        </p>
      </header>

      <section className="panel" aria-labelledby="h-link">
        <h2 id="h-link">Your link</h2>
        <div className="referlink">
          <code>{summary.link}</code>
          <CopyButton text={summary.link} label="Copy link" />
        </div>
        <div className="btnrow refer-share">
          <a className="btn ghost sm" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
            Share on WhatsApp
          </a>
          <a className="btn ghost sm" href={`mailto:?subject=${encodeURIComponent('Try Content-Story with me')}&body=${encodeURIComponent(message)}`}>
            Share by email
          </a>
        </div>
        <p className="hint">
          Your code is <span className="mono">{summary.code}</span>. The link works for anyone who hasn’t got an account yet; it remembers the referral for {REFERRAL.cookieDays} days.
        </p>
      </section>

      <dl className="stats" aria-label="Referral numbers">
        <div>
          <dt>Friends joined</dt>
          <dd>{fmtNum(summary.joined)}</dd>
        </div>
        <div>
          <dt>Still setting up</dt>
          <dd>{fmtNum(summary.pending)}</dd>
        </div>
        <div>
          <dt>Credits earned</dt>
          <dd>{fmtNum(summary.earned)}</dd>
        </div>
        <div>
          <dt>Rewards left</dt>
          <dd>{fmtNum(summary.remaining)}</dd>
        </div>
      </dl>

      <div className="split">
        <section className="panel">
          <h2>Friends you’ve invited</h2>
          {summary.referrals.length ? (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Friend</th>
                    <th>Joined</th>
                    <th>Status</th>
                    <th className="num">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.referrals.map((r) => (
                    <tr key={r.id}>
                      <td>{r.friend ?? r.friend_name}</td>
                      <td>{fmtDay(r.joined_at)}</td>
                      <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td className={`num${r.status === 'rewarded' ? ' plus' : ''}`}>{r.status === 'rewarded' ? `+${fmtNum(REFERRAL.referrerCredits)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted-note">Nobody yet. Share your link with someone who follows AI and tech news.</p>
          )}
        </section>

        <section className="panel">
          <h2>How it works</h2>
          <ol className="steps">
            <li>Send your link to a friend or a teammate at another company.</li>
            <li>They sign up and start with {fmtNum(friendTotal)} free credits instead of {fmtNum(TRIAL.credits)}.</li>
            <li>When they finish choosing who to follow, {fmtNum(REFERRAL.referrerCredits)} credits land in your workspace and we email you.</li>
          </ol>
          <p className="hint">
            Rewards are paid for up to {plural(REFERRAL.maxRewarded, 'friend')} per workspace. Friends invited after that still get their welcome bonus. Referring yourself, or someone already in your workspace, doesn’t count.
          </p>
        </section>
      </div>
    </div>
  );
}
